//! OpenCode CLI plugin — ports `agent-plugins/opencode.ts`.
//!
//! System-prompt delivery: `OPENCODE_CONFIG` env (a JSON config whose
//! `instructions` point at the system-prompt file, and whose `model` key is how
//! v2 selects a model — v2 removed the top-level `-m/--model` flag). Task-prompt
//! delivery: post-launch paste. Ready signal: a TUI paint marker (`ctrl+p`, the
//! status bar both v1 and v2 paint — the bare word `opencode` never appears in a
//! healthy TUI on either). `identical`
//! two-session-identity strategy: implements neither `capture_native_chat_id`
//! nor `supports_json_to_terminal_resume`.
//!
//! Interactive argv is **capability-probed** (`OpencodeCli`), never assumed from
//! a version number: a flag the installed build does not know makes opencode
//! print its help and exit 1, killing the pane. See
//! `.vibekit/reports/2026-10-22-opencode-rich-chat-to-terminal-resume.md`.

use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use agent_client_protocol::schema::v1::{ContentBlock, TextContent};
use serde_json::Value;
use tokio::fs;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use vst_types::{
    Channel, NormalizedEvent, NormalizedEventKind, NormalizedEventProvider, Role, ToolResult,
};

use crate::acp_connection::AcpLaunchSpec;
use crate::acp_run_turn::{run_turn_acp, RunTurnAcpParams};
use crate::claude::format_skill_directive;
use crate::context::{
    opencode_config_path_for as ctx_opencode_config_path_for, resolved_context_of,
    system_prompt_path_for as ctx_system_prompt_path_for,
};
use crate::opencode_config::{write_opencode_config, write_opencode_config_blocking};
use crate::paths::Paths;
use crate::plugin::{
    base_event, AgentPlugin, AsyncResult, CaptureArgs, ComposePromptInput, ComposePromptResult,
    LaunchConfig, ListModelsResult, PromptDelivery, ReadySignal, RestoreArgs, SkillInvocation,
    TurnContext, TurnInput,
};

fn num(v: &Value) -> i64 {
    v.as_i64().unwrap_or(0)
}

/// Per-turn mutable state threaded through [`parse_opencode_stream_line`] —
/// mirrors `opencode.ts`'s `{ initEmitted, toolStarted }`.
#[derive(Default)]
pub struct OpencodeStreamState {
    pub init_emitted: bool,
    pub tool_started: HashSet<String>,
}

/// Map ONE opencode `run --format json` line into zero or more
/// [`NormalizedEvent`]s — `parseOpencodeStreamLine` in `opencode.ts`.
pub fn parse_opencode_stream_line(
    line: &str,
    session_id: &str,
    state: &mut OpencodeStreamState,
) -> Vec<NormalizedEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return vec![];
    }
    let parsed: Result<Value, _> = serde_json::from_str(trimmed);
    let msg = match parsed {
        Ok(v) if v.is_object() => v,
        _ => return vec![],
    };
    let event =
        |kind: NormalizedEventKind| base_event(session_id, NormalizedEventProvider::Opencode, kind);

    let type_s = msg.get("type").and_then(|t| t.as_str());
    let part = msg
        .get("part")
        .cloned()
        .unwrap_or(Value::Object(Default::default()));
    let session_id_wire = msg.get("sessionID").and_then(|s| s.as_str());
    let mut events: Vec<NormalizedEvent> = Vec::new();

    // Surface the harness session id once (no explicit init event).
    if !state.init_emitted {
        if let Some(sid) = session_id_wire {
            state.init_emitted = true;
            let mut ev = event(NormalizedEventKind::SessionInit);
            ev.agent_chat_id = Some(sid.to_string());
            ev.model = msg
                .get("model")
                .and_then(|m| m.as_str())
                .map(str::to_string);
            events.push(ev);
        }
    }

    let emit_usage_and_result = |events: &mut Vec<NormalizedEvent>| {
        let tokens = part
            .get("tokens")
            .or_else(|| msg.get("tokens"))
            .cloned()
            .unwrap_or(Value::Object(Default::default()));
        let cache = tokens
            .get("cache")
            .cloned()
            .unwrap_or(Value::Object(Default::default()));
        let input_tokens = tokens.get("input").map(num).unwrap_or(0);
        let output_tokens = tokens.get("output").map(num).unwrap_or(0);
        let cache_read_tokens = cache.get("read").map(num).unwrap_or(0);
        let cache_create_tokens = cache.get("write").map(num).unwrap_or(0);
        let model = msg
            .get("model")
            .and_then(|m| m.as_str())
            .unwrap_or("")
            .to_string();
        let has_usage = input_tokens + output_tokens + cache_read_tokens + cache_create_tokens > 0;
        if has_usage {
            let usage = vst_types::UsageInfo {
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_create_tokens,
                total_tokens: input_tokens
                    + output_tokens
                    + cache_read_tokens
                    + cache_create_tokens,
                cost_usd: part.get("cost").and_then(|c| c.as_f64()),
                model: model.clone(),
                ..Default::default()
            };
            let mut usage_ev = event(NormalizedEventKind::Usage);
            if !model.is_empty() {
                usage_ev.model = Some(model.clone());
            }
            usage_ev.usage = Some(usage.clone());
            events.push(usage_ev);
            let mut result_ev = event(NormalizedEventKind::Result);
            if !model.is_empty() {
                result_ev.model = Some(model.clone());
            }
            result_ev.usage = Some(usage);
            events.push(result_ev);
        } else {
            events.push(event(NormalizedEventKind::Result));
        }
    };

    if type_s == Some("step_finish") {
        let reason = part
            .get("reason")
            .or_else(|| msg.get("reason"))
            .and_then(|r| r.as_str());
        if reason == Some("stop") {
            emit_usage_and_result(&mut events);
        }
        return events;
    }
    if type_s == Some("step_start") {
        return events;
    }

    let part_type = part.get("type").and_then(|t| t.as_str());
    if part_type == Some("text") {
        if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
            let mut ev = event(NormalizedEventKind::Text);
            ev.role = Some(Role::Assistant);
            ev.text = Some(text.to_string());
            events.push(ev);
        }
    } else if part_type == Some("reasoning") {
        if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
            let mut ev = event(NormalizedEventKind::Thinking);
            ev.role = Some(Role::Assistant);
            ev.text = Some(text.to_string());
            events.push(ev);
        }
    } else if part_type == Some("tool") {
        let st = part
            .get("state")
            .cloned()
            .unwrap_or(Value::Object(Default::default()));
        let status = st.get("status").and_then(|s| s.as_str());
        let call_id = part.get("callID").and_then(|c| c.as_str());
        let tool_name = part.get("tool").and_then(|t| t.as_str());
        let mut emit_tool_use = |events: &mut Vec<NormalizedEvent>, input: Option<&Value>| {
            if let Some(cid) = call_id {
                if !state.tool_started.insert(cid.to_string()) {
                    return;
                }
            }
            let mut ev = event(NormalizedEventKind::ToolUse);
            ev.role = Some(Role::Assistant);
            ev.tool_name = tool_name.map(str::to_string);
            ev.tool_id = call_id.map(str::to_string);
            ev.tool_input = input.cloned();
            events.push(ev);
        };
        match status {
            Some("running") | Some("pending") => {
                emit_tool_use(&mut events, st.get("input"));
            }
            Some("completed") | Some("error") => {
                emit_tool_use(&mut events, st.get("input"));
                let raw = st.get("output").or_else(|| st.get("error"));
                let content_str = match raw {
                    Some(Value::String(s)) => Some(s.clone()),
                    Some(Value::Null) | None => None,
                    Some(other) => Some(other.to_string()),
                };
                let mut ev = event(NormalizedEventKind::ToolResult);
                ev.tool_id = call_id.map(str::to_string);
                ev.tool_result = Some(ToolResult {
                    content: content_str,
                    is_error: Some(status == Some("error")),
                });
                events.push(ev);
            }
            _ => {}
        }
    }
    events
}

/// The `vst-recorder.ts` opencode plugin file content.
///
/// Registers via the generic `event` hook, not a top-level `"session.created"`
/// hook key — opencode 1.18.x never invokes that top-level key at all; only
/// `event` fires, delivering `{ type: "session.created", properties: { info: { id } } }`.
/// Verified live against opencode 1.18.32 (a probe plugin logging both hook
/// shapes: `event` fired after the first message, the top-level hook never
/// did). See .vibekit/reports/2026-09-22-opencode-toggle-empty-then-syncs.md (B5/A1).
const VST_RECORDER: &str = r#"import type { Plugin } from "@opencode-ai/plugin";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export const VstRecorder: Plugin = async ({ directory }) => ({
  event: async ({ event }) => {
    if (event.type !== "session.created") return;
    // Subagent sessions fire this same event with a parentID set — skip
    // them, only the root session's id should ever be recorded. Without
    // this, a subagent spawned later in the conversation would overwrite
    // the token file with ITS session id, and a reader (capture_chat_id)
    // would then bind the whole session to the wrong native conversation.
    if (event.properties?.info?.parentID) return;
    const token = process.env.VST_SPAWN_TOKEN;
    if (!token) return;
    const sessionId = event.properties?.info?.id;
    if (!sessionId) return;
    const dir = join(directory, ".vibe-station", "agent-chat-ids");
    mkdirSync(dir, { recursive: true });
    const tokenPath = join(dir, token);
    // Write-once: only the FIRST session.created for this token wins.
    // capture_chat_id deletes the file after a successful read, so a
    // pre-existing file here means a read is still pending, not stale.
    if (existsSync(tokenPath)) return;
    writeFileSync(tokenPath, sessionId);
  },
});
"#;

/// The `/vst` custom slash-command template for `.opencode/commands/vst.md`.
const VST_COMMAND: &str = r#"---
description: Reset, hand off, or rename this vibe-station session/worktree
---

The user invoked `/vst $ARGUMENTS` — map it to exactly one `vst` CLI
command below and run it as a shell command. Do not run more than one, and
do not improvise flags beyond what's listed here.

Argument patterns (`$ARGUMENTS` is everything typed after `/vst`):

- `reset` -> `vst session reset $VST_SESSION`
- `reset --handoff` -> see "Important — `reset --handoff` writes its own file" below
- `reset <text>` (any other text after `reset`) -> `vst session reset $VST_SESSION --prompt "<text>"`
- `reset --handoff <text>` -> see "Important — `reset --handoff` writes its own file" below (final command includes both `--handoff-file <path>` and `--prompt "<text>"`)
- `reset --mode <name>` -> `vst session reset $VST_SESSION --mode "<name>"` (switches mode/CLI on reset — combine with other reset flags, e.g. `--mode "<name>" --prompt "<text>"`)
- `handoff` -> `vst session handoff $VST_SESSION`
- `rename <name>` -> `vst session rename $VST_SESSION "<name>"`
- `rename --worktree <name>` -> `vst worktree rename $VST_WORKTREE "<name>"`

Important — `reset --handoff` writes its own file:
Do NOT pass `--handoff` to the `vst session reset` command. This command is
running from inside the very session being reset, so the daemon has no way
to paste an instruction back into your own pane and wait for a reply — you
are blocked on this shell command, so you'd never see it. Instead: BEFORE
running `vst session reset`, write a concise handoff summary of the current
state, remaining work, and anything the next session should know to any file
of your own choosing, using a normal file-write tool call (not a shell
command). Then run `vst session reset $VST_SESSION --handoff-file <path>`
(with `--prompt "<text>"` too if other text followed `--handoff`, but never
`--handoff` itself) — the CLI reads that file locally and sends its contents
as the handoff summary.

Important — `--worktree` requires a worktree session:
`$VST_WORKTREE` is only set when this session belongs to a worktree; direct
(non-worktree) sessions never have it. Before running the `rename --worktree`
command, check whether `$VST_WORKTREE` is actually set and non-empty. If it
is NOT set, do not run the command — instead tell the user: "This session
isn't part of a worktree, so there's no worktree to rename."

Important — `reset` ends this session:
Any `reset` variant tears down the CURRENT session process as part of
running the command — this turn effectively never completes from the
user's point of view. Before running a `reset` command, tell the user
something like "Resetting this session now — you'll see a fresh session
appear." Then run the command as your last action. Do not continue the
conversation afterward as if nothing happened.

`handoff` and `rename` do not end the session — after running those, report
the CLI's output back to the user normally.
"#;

/// OpenCode plugin (stateless singleton).
pub struct OpencodePlugin;

/// Create a fresh opencode plugin instance (`createOpencodePlugin`).
pub fn create_opencode_plugin() -> OpencodePlugin {
    OpencodePlugin
}

impl AgentPlugin for OpencodePlugin {
    fn name(&self) -> &str {
        "opencode"
    }

    fn default_model(&self) -> &str {
        "opencode/big-pickle"
    }

    fn default_mode_icon(&self, model: Option<&str>) -> &'static str {
        match model {
            Some(m) if m.to_ascii_lowercase().contains("deepseek") => "deepseek",
            _ => "opencode",
        }
    }

    fn prompt_delivery(&self) -> PromptDelivery {
        PromptDelivery::PostLaunch
    }

    fn post_sentinel_delay_ms(&self) -> Option<u64> {
        Some(500)
    }

    fn get_launch_command(&self, cfg: &LaunchConfig) -> Vec<String> {
        opencode_cli().launch_argv(cfg.model.as_deref())
    }

    fn get_environment(&self, cfg: &LaunchConfig) -> BTreeMap<String, String> {
        let paths = Paths::default();
        let config_path = opencode_config_path_for(&paths, cfg);
        let prompt_file = system_prompt_path_for(&paths, cfg);
        // Best-effort write (mirrors the TS — updated AGENTS.md is always picked up).
        if let Some(parent) = config_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // The model goes in the config file, not argv: opencode v2 dropped the
        // top-level `-m` entirely. On v1 the config `model` key is redundant
        // with the `-m` `get_launch_command` still passes (same value, no
        // precedence surprise). The config is what `Standalone` relies on. On
        // `Unknown` (v2, no `--standalone`) the TUI ignores the config — that
        // loss is the documented degradation of `Unknown`, not a bug here.
        let _ = write_opencode_config_blocking(
            &config_path,
            &[prompt_file.to_string_lossy().into_owned()],
            cfg.model.as_deref(),
        );
        BTreeMap::from([
            (
                "OPENCODE_CONFIG".to_string(),
                config_path.to_string_lossy().into_owned(),
            ),
            // See OPENCODE_DISABLE_FILEWATCHER note in `build_spec` below.
            ("OPENCODE_DISABLE_FILEWATCHER".to_string(), "1".to_string()),
        ])
    }

    /// Ready sentinel — a string the **drawn TUI** contains, not the binary's
    /// name.
    ///
    /// The long-standing `"opencode"` sentinel never appears in a drawn
    /// opencode TUI, on either generation: measured on v2.1.2 and v1.19.4,
    /// `grep -c opencode` on the pane is **0** (both render `OpenCode`, capital
    /// O). It only ever matched on a *broken* pane, because a rejected argv
    /// prints the help text, which contains `.opencode/` paths. Every healthy
    /// spawn therefore burned the full 10 s fallback.
    ///
    /// `ctrl+p commands` is the status-bar hint both TUIs paint: measured
    /// 1.4 s to first paint on v2.1.2 and 2.1 s on v1.19.4, so it is the
    /// marker for every shape (it does not need the capability probe).
    ///
    /// A sentinel is a *latency* bound only: it can be printed by a CLI that is
    /// about to die (the help text again), so callers must confirm the process
    /// is still alive afterwards — see `spawn_session_from_argv`.
    fn get_ready_signal(&self) -> ReadySignal {
        ReadySignal {
            sentinel: Some("ctrl+p"),
            fallback_ms: 10_000,
        }
    }

    fn compose_launch_prompt(&self, input: ComposePromptInput) -> ComposePromptResult {
        let mut parts: Vec<String> = Vec::new();
        if let Some(task) = &input.task_prompt {
            parts.push(task.clone());
        }
        parts.push(format!(
            "<!-- {} -->",
            crate::plugin::prompt_verification_needle(&input.session_id)
        ));
        ComposePromptResult {
            post_launch_input: if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n\n"))
            },
            post_launch_submit: true,
            ..Default::default()
        }
    }

    fn default_channel(&self) -> Channel {
        Channel::Json
    }

    fn setup_workspace_hooks(&self, workspace_path: &str) -> AsyncResult<()> {
        let root = PathBuf::from(workspace_path);
        Box::pin(async move {
            let plugin_dir = root.join(".opencode").join("plugins");
            let _ = fs::create_dir_all(&plugin_dir).await;
            let plugin_path = plugin_dir.join("vst-recorder.ts");
            match fs::read_to_string(&plugin_path).await {
                Ok(existing) if existing == VST_RECORDER => {}
                Ok(_) => {
                    let _ = fs::write(&plugin_path, VST_RECORDER).await;
                }
                Err(_) => {
                    let _ = fs::write(&plugin_path, VST_RECORDER).await;
                }
            }

            let commands_dir = root.join(".opencode").join("commands");
            let _ = fs::create_dir_all(&commands_dir).await;
            let vst_command_path = commands_dir.join("vst.md");
            let existing = fs::read_to_string(&vst_command_path)
                .await
                .unwrap_or_default();
            if existing != VST_COMMAND {
                let _ = fs::write(&vst_command_path, VST_COMMAND).await;
            }

            let _ = ensure_gitignore_entry(root.join(".gitignore"), ".opencode/").await;
        })
    }

    fn list_models(&self) -> AsyncResult<ListModelsResult> {
        // Shells out to `opencode models` (one model id per line). Right after
        // opencode starts, its providers/config may not have loaded yet, and it
        // then exits 0 with an EMPTY or PARTIAL list (the same startup race
        // that makes `opencode acp` pick a fallback model) — so run it until
        // two consecutive runs agree on a non-empty list, and report an error
        // (never an empty success) if it never produces one.
        Box::pin(async move {
            let fail = |msg: String| ListModelsResult {
                models: vec![],
                error: Some(msg),
            };
            let deadline = std::time::Instant::now() + LIST_MODELS_BUDGET;
            let mut previous: Option<Vec<String>> = None;
            let mut best: Vec<String> = Vec::new();
            for attempt in 0..LIST_MODELS_MAX_RUNS {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                if remaining.is_zero() {
                    break;
                }
                let output = match tokio::time::timeout(
                    remaining,
                    tokio::process::Command::new("opencode")
                        .arg("models")
                        .output(),
                )
                .await
                {
                    Ok(Ok(o)) => o,
                    Ok(Err(err)) => {
                        eprintln!("[cli-models] opencode fetch failed to spawn: {err}");
                        return fail(format!(
                            "Couldn't run `opencode models`: {err}. Check that opencode is installed."
                        ));
                    }
                    Err(_) => break,
                };
                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    eprintln!(
                        "[cli-models] opencode fetch failed: status={} stderr={}",
                        output.status,
                        stderr.trim()
                    );
                    return fail(format!(
                        "`opencode models` failed ({}). Check that opencode is installed and authenticated.",
                        output.status
                    ));
                }
                let models: Vec<String> = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .map(|l| l.trim().to_string())
                    .filter(|l| !l.is_empty())
                    .collect();
                if !models.is_empty() {
                    if previous.as_ref() == Some(&models) {
                        return ListModelsResult {
                            models,
                            error: None,
                        };
                    }
                    if models.len() > best.len() {
                        best = models.clone();
                    }
                    previous = Some(models);
                } else {
                    previous = None;
                }
                if attempt + 1 < LIST_MODELS_MAX_RUNS {
                    tokio::time::sleep(LIST_MODELS_RETRY_DELAY).await;
                }
            }
            if best.is_empty() {
                fail(
                    "opencode reported no models (its providers may not have finished loading). Try again."
                        .to_string(),
                )
            } else {
                // Never stabilised within the budget; the largest run seen is
                // the most complete one.
                ListModelsResult {
                    models: best,
                    error: None,
                }
            }
        })
    }

    fn capture_chat_id(&self, args: CaptureArgs<'_>) -> AsyncResult<Option<String>> {
        let token_file = PathBuf::from(args.cwd)
            .join(".vibe-station")
            .join("agent-chat-ids")
            .join(&args.session.id);
        Box::pin(async move {
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(30_000);
            loop {
                match fs::read_to_string(&token_file).await {
                    Ok(raw) => {
                        let id = raw.trim().to_string();
                        let _ = fs::remove_file(&token_file).await;
                        if id.is_empty() {
                            return None;
                        }
                        return Some(id);
                    }
                    Err(_) => {
                        if std::time::Instant::now() >= deadline {
                            return None;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    }
                }
            }
        })
    }

    fn get_restore_command(&self, args: RestoreArgs<'_>) -> AsyncResult<Option<Vec<String>>> {
        let id = args.session.agent_chat_id.clone();
        let model = args.model.map(|m| m.to_string());
        Box::pin(async move {
            match id {
                Some(id) if !id.is_empty() => {
                    Some(opencode_cli().restore_argv(model.as_deref(), &id))
                }
                _ => None,
            }
        })
    }

    fn supports_json(&self) -> bool {
        true
    }

    fn supports_acp(&self) -> bool {
        true
    }

    /// `opencode acp` spawns `opencode serve --stdio` via `setsid()`, which
    /// escapes the process group the transport kills on dispose, so every
    /// disposed connection would otherwise orphan a live server.
    fn reap_detached_descendants(&self) -> bool {
        true
    }

    fn acp_initial_config_option(&self, model: &str) -> Option<(String, String)> {
        // `OPENCODE_CONFIG`'s `model` key is only honoured if `opencode acp`
        // has finished loading its config/providers before it creates the
        // session. It sometimes hasn't (a startup race, ~50% of spawns in
        // probes): the session is then created on the first available model
        // (a free, rate-limited one) and stays there — `session/load`
        // restores that stored model and ignores the config too, and `_meta`
        // on `session/new` is ignored entirely. So the config-file write in
        // `run_turn` is kept only as a backup; the authoritative channel is
        // this explicit `session/set_config_option {configId: "model"}`,
        // whose outcome the session layer checks against the model the
        // session reports (and retries on a lost race). An empty model means
        // "no preference" — never send an empty value.
        if model.is_empty() {
            return None;
        }
        Some(("model".to_string(), model.to_string()))
    }

    fn format_skill_directive(
        &self,
        message: &str,
        skill_invocations: Option<&[SkillInvocation]>,
    ) -> String {
        format_skill_directive(message, skill_invocations)
    }

    fn run_turn(
        &self,
        input: TurnInput,
        ctx: TurnContext,
        cancel: CancellationToken,
    ) -> mpsc::UnboundedReceiver<NormalizedEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        let params = RunTurnAcpParams {
            provider: NormalizedEventProvider::Opencode,
            build_spec: Box::new(|ctx| {
                let resolved = resolved_context_of(ctx.project.clone(), ctx.worktree.clone());
                let config_path = ctx_opencode_config_path_for(&resolved, &ctx.session.id);
                AcpLaunchSpec {
                    command: "opencode".to_string(),
                    args: vec!["acp".to_string()],
                    cwd: ctx.cwd.clone(),
                    env: BTreeMap::from([
                        ("OPENCODE_CONFIG".to_string(), config_path),
                        // Every opencode instance opens its own inotify
                        // instance for its file watcher. The kernel caps these
                        // per-USER (fs.inotify.max_user_instances, default
                        // 128), not per-process, so with several agent
                        // sessions plus browsers/editors the cap is exhausted
                        // and opencode fails with EMFILE ("too many open
                        // files") even though `ulimit -n` is huge. Agent
                        // sessions don't need live file-change events.
                        ("OPENCODE_DISABLE_FILEWATCHER".to_string(), "1".to_string()),
                        ("VST_SPAWN_TOKEN".to_string(), ctx.session.id.clone()),
                    ])
                    .into_iter()
                    .collect(),
                    initialize_timeout_ms: None,
                    prompt_timeout_ms: None,
                    reap_detached_descendants: OpencodePlugin.reap_detached_descendants(),
                }
            }),
            enrich: None,
            // Decision 6 Option A (spike 3.0b verdict: coincide) — the ACP
            // session id IS opencode's native resume id; surface it as
            // `agentChatId` on the first turn.
            first_turn_session_init: Some(Arc::new(|ctx, acp_id| {
                let mut ev = base_event(
                    &ctx.session.id,
                    NormalizedEventProvider::Opencode,
                    NormalizedEventKind::SessionInit,
                );
                ev.agent_chat_id = Some(acp_id.to_string());
                ev
            })),
            // System prompt is delivered via OPENCODE_CONFIG (written before the
            // connection spawns), not as a prompt block.
            build_prompt_blocks: Box::new(|_ctx, input, _system| {
                vec![ContentBlock::Text(TextContent::new(input.message.clone()))]
            }),
            emit_refusal_error: false,
            stuck_turn_idle_ms: None,
            stuck_turn_cancel_grace_ms: None,
        };
        tokio::spawn(async move {
            // Write the opencode config (best-effort — spawn proceeds without
            // instructions if this fails) BEFORE the connection is created.
            let resolved = resolved_context_of(ctx.project.clone(), ctx.worktree.clone());
            let config_path = ctx_opencode_config_path_for(&resolved, &ctx.session.id);
            let prompt_file = ctx_system_prompt_path_for(&resolved, &ctx.session.id);
            if let Some(parent) = std::path::Path::new(&config_path).parent() {
                let _ = fs::create_dir_all(parent).await;
            }
            write_opencode_config(
                std::path::Path::new(&config_path),
                std::slice::from_ref(&prompt_file),
                ctx.model.as_deref(),
            )
            .await;
            run_turn_acp(tx, input, ctx, cancel, params).await;
        });
        rx
    }
}

/// Budget for the `opencode models` probe (see `list_models`).
const LIST_MODELS_BUDGET: std::time::Duration = std::time::Duration::from_secs(15);
const LIST_MODELS_MAX_RUNS: usize = 8;
const LIST_MODELS_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(250);

fn opencode_config_path_for(paths: &Paths, cfg: &LaunchConfig) -> PathBuf {
    match &cfg.ctx.worktree {
        Some(wt) => paths.opencode_config_path(&cfg.ctx.project_id, &wt.id, &cfg.session.id),
        None => paths.direct_opencode_config_path(&cfg.ctx.project_id, &cfg.session.id),
    }
}

fn system_prompt_path_for(paths: &Paths, cfg: &LaunchConfig) -> PathBuf {
    match &cfg.ctx.worktree {
        Some(wt) => paths.system_prompt_path(&cfg.ctx.project_id, &wt.id, &cfg.session.id),
        None => paths.direct_system_prompt_path(&cfg.ctx.project_id, &cfg.session.id),
    }
}

/// Which top-level argv shape the installed `opencode` accepts.
///
/// opencode v2 removed the top-level `-m/--model` flag (it survives only on
/// `opencode run`) and added `--standalone`. Passing `-m` to v2 makes the CLI
/// print its help and exit 1 — the dead terminal documented in
/// `.vibekit/reports/2026-10-22-opencode-rich-chat-to-terminal-resume.md`.
/// `--standalone` is not safe to pass blindly either (a build without it would
/// reject the flag the same way), so the shape is probed from `--help`, never
/// assumed from a version number.
///
/// The variants name the *capability*, not a version, because the two are what
/// actually drive argv construction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpencodeCli {
    /// No top-level model flag, `--standalone` present (v2+). The model and
    /// instructions travel in `OPENCODE_CONFIG`, which the TUI only honours
    /// together with `--standalone`.
    Standalone,
    /// Top-level `-m <model>` present, no `--standalone` (v1).
    Legacy,
    /// Probe failed — emit only flags every version understands. Degrades to
    /// the smallest usable argv: a launch/resume still succeeds, but the model
    /// override and per-process `instructions`/`permission` are lost (on v2,
    /// both ride in `OPENCODE_CONFIG`, which the TUI only honours with
    /// `--standalone` — see `get_environment`).
    Unknown,
}

impl OpencodeCli {
    /// Interactive TUI argv for a fresh launch.
    fn launch_argv(self, model: Option<&str>) -> Vec<String> {
        match self {
            OpencodeCli::Legacy => match model.filter(|m| !m.is_empty()) {
                Some(m) => vec!["opencode".to_string(), "-m".to_string(), m.to_string()],
                None => vec!["opencode".to_string()],
            },
            // v2 removed the top-level `-m` (it would print `--help` and exit
            // 1). The model rides in `OPENCODE_CONFIG` — see `get_environment`
            // — and `--standalone` is what makes the TUI honour that
            // per-process config instead of the shared background server
            // (without it v2 also silently drops `instructions`/`permission`).
            OpencodeCli::Standalone => vec!["opencode".to_string(), "--standalone".to_string()],
            // Probe failed (broken/unrunnable binary): emit only flags every
            // version accepts. Launch still works. On v2 there is no argv flag
            // that can restore the model/instructions/permission overrides —
            // those live in OPENCODE_CONFIG, which the TUI ignores without
            // `--standalone` — so they are lost until the next probe.
            OpencodeCli::Unknown => vec!["opencode".to_string()],
        }
    }

    /// Interactive TUI argv that resumes `session_id`.
    fn restore_argv(self, model: Option<&str>, session_id: &str) -> Vec<String> {
        let mut argv = self.launch_argv(model);
        argv.push("--session".to_string());
        argv.push(session_id.to_string());
        argv
    }
}

/// The capabilities this module cares about, read off `opencode --help`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct OpencodeHelp {
    /// Top-level `-m` / `--model` exists (v1).
    top_level_model: bool,
    /// `--standalone` exists (v2+).
    standalone: bool,
}

impl OpencodeHelp {
    fn parse(help: &str) -> Self {
        // Match whole flags, not substrings of the flag table's prose: `-m` and
        // `--model` must appear as a token, and so must `--standalone`.
        let tokens: Vec<&str> = help
            .split(|c: char| c.is_whitespace() || c == ',' || c == '|')
            .filter(|t| !t.is_empty())
            .collect();
        Self {
            top_level_model: tokens
                .iter()
                .any(|t| *t == "-m" || *t == "--model" || t.starts_with("--model=")),
            standalone: tokens
                .iter()
                .any(|t| *t == "--standalone" || t.starts_with("--standalone=")),
        }
    }

    fn shape(self) -> OpencodeCli {
        match (self.standalone, self.top_level_model) {
            // A build with both: prefer the standalone/config path — the
            // config `model` key is honoured either way, and this avoids the
            // flag that was on its way out.
            (true, _) => OpencodeCli::Standalone,
            (false, true) => OpencodeCli::Legacy,
            (false, false) => OpencodeCli::Unknown,
        }
    }
}

/// How long a failed probe (`Unknown`) is remembered before it is retried.
///
/// Unlike a successful probe — which is valid for as long as the binary's
/// identity is unchanged — an `Unknown` is the state we want to re-check (a
/// half-written upgrade, a transient hang). But re-probing on *every* spawn
/// turns a hung binary into one blocking probe + one log line per spawn, so it
/// is cached briefly: long enough to collapse a burst of spawns, short enough
/// that the machine recovers on its own.
const UNKNOWN_PROBE_TTL: Duration = Duration::from_secs(30);

/// Cached probe result. `expires` is `Some` only for `Unknown`.
struct ProbeCache {
    identity: BinaryIdentity,
    shape: OpencodeCli,
    expires: Option<std::time::Instant>,
}

/// Detect the installed opencode's argv shape.
///
/// Cached against the **binary's identity** (resolved path + mtime + size), not
/// for the process lifetime: `opencode upgrade` is a documented subcommand, and
/// a daemon that outlives the upgrade must not keep spawning the pre-upgrade
/// argv (that is exactly the v1→v2 transition that caused the original bug).
/// A failed probe (`Unknown`) is cached for [`UNKNOWN_PROBE_TTL`] only.
///
/// Blocking (it runs the CLI once per identity): callers are the argv builders
/// (`get_launch_command`, `get_restore_command`), which are synchronous plugin
/// methods, so a cache miss blocks the calling thread for at most
/// [`PROBE_TIMEOUT`] — once per binary identity, or once per
/// [`UNKNOWN_PROBE_TTL`] while the probe keeps failing. `get_ready_signal` no
/// longer consults this (its sentinel is shape-independent).
pub fn opencode_cli() -> OpencodeCli {
    static CACHE: OnceLock<Mutex<Option<ProbeCache>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));

    let Some((program, identity)) = binary_identity() else {
        // Not resolvable at all: `ensure_binary_on_path` will fail the spawn
        // with a "not found on PATH" error, so nothing to probe or cache.
        return OpencodeCli::Unknown;
    };

    if let Ok(guard) = cache.lock() {
        if let Some(entry) = guard.as_ref().filter(|e| e.identity == identity) {
            // Borrow-checker: copy the fields out before the guard is dropped.
            let shape = entry.shape;
            let expired = entry
                .expires
                .is_some_and(|expires| std::time::Instant::now() >= expires);
            if !expired {
                return shape;
            }
        }
    }

    let shape = match run_opencode_help(&program, PROBE_TIMEOUT) {
        Some(help) => OpencodeHelp::parse(&help).shape(),
        None => OpencodeCli::Unknown,
    };
    let expires =
        (shape == OpencodeCli::Unknown).then(|| std::time::Instant::now() + UNKNOWN_PROBE_TTL);
    if shape == OpencodeCli::Unknown {
        eprintln!(
            "[opencode] could not detect the installed CLI's flags (`{} --help` failed or timed \
             out); launching with the version-agnostic argv — model/instruction overrides may be \
             ignored until the next probe ({UNKNOWN_PROBE_TTL:?})",
            program.display()
        );
    }
    if let Ok(mut guard) = cache.lock() {
        *guard = Some(ProbeCache {
            identity,
            shape,
            expires,
        });
    }
    shape
}

/// Overall bound on one `opencode --help` probe (spawn → exit, not per pipe).
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// Resolved path + mtime + size of the `opencode` binary, used as the cache key
/// for [`opencode_cli`]. `None` when it cannot be resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
struct BinaryIdentity {
    path: PathBuf,
    len: u64,
    modified: Option<std::time::SystemTime>,
}

/// Resolve `opencode` on the **same PATH the spawn will use**, and fingerprint
/// it. Deliberately not `std::env::var("PATH")` (the daemon's own): the child
/// gets `context::effective_path()` (daemon PATH + the user's interactive-shell
/// dirs), so resolving against anything else could probe one binary and spawn
/// another — or miss an install that is only on the shell PATH and degrade
/// silently to `Unknown`.
fn binary_identity() -> Option<(PathBuf, BinaryIdentity)> {
    let path = crate::registry::resolve_binary("opencode", &crate::context::effective_path())?;
    let meta = std::fs::metadata(&path).ok()?;
    let identity = BinaryIdentity {
        len: meta.len(),
        modified: meta.modified().ok(),
        path: path.clone(),
    };
    Some((path, identity))
}

/// Read a child pipe to EOF on its own thread (so a full pipe can never
/// deadlock the wait, and a timeout can still fire).
fn drain_pipe<R: std::io::Read + Send + 'static>(
    mut reader: R,
) -> std::sync::mpsc::Receiver<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = reader.read_to_string(&mut buf);
        let _ = tx.send(buf);
    });
    rx
}

/// Run `<program> --help` and return its combined stdout+stderr, or `None` if it
/// couldn't be spawned or didn't finish within `timeout` (killed on timeout).
///
/// One deadline covers the whole probe — spawn, both pipes, exit — rather than
/// `timeout` per pipe. The exit status is ignored on purpose: v2's help path
/// exits 0, but an unknown flag exits 1 *with* the help text, and the flag list
/// is what we need either way.
fn run_opencode_help(program: &std::path::Path, timeout: Duration) -> Option<String> {
    use std::process::{Command, Stdio};

    let mut child = Command::new(program)
        .arg("--help")
        // Run the probe under the same PATH the child will be spawned with
        // (`effective_path()`), not the daemon's inherited PATH: an npm/nvm
        // install resolves `opencode` through a shim that may behave
        // differently, and a deliberate launcher path must be kept stable
        // across the probe and the spawn it feeds.
        .env("PATH", crate::context::effective_path())
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;

    let out = drain_pipe(child.stdout.take()?);
    let err = child.stderr.take().map(drain_pipe);

    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            // Either the deadline passed or the wait itself failed: kill and
            // report "couldn't probe" rather than hang on a binary that closed
            // its pipes without exiting.
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }

    // The child has exited, so both pipes are normally at EOF and these return
    // immediately. The short timeouts only matter if a grandchild inherited the
    // pipes and is still holding them open.
    let mut text = out.recv_timeout(Duration::from_secs(1)).unwrap_or_default();
    if let Some(err) = err {
        if let Ok(stderr) = err.recv_timeout(Duration::from_millis(200)) {
            text.push_str(&stderr);
        }
    }
    (!text.is_empty()).then_some(text)
}

/// Ensure a gitignore entry is present (best-effort, mirrors `ensureGitignoreEntry`).
async fn ensure_gitignore_entry(gitignore_path: PathBuf, entry: &str) {
    let content = fs::read_to_string(&gitignore_path)
        .await
        .unwrap_or_default();
    if content.lines().any(|l| l.trim() == entry) {
        return;
    }
    let new_content = if content.is_empty() || content.ends_with('\n') {
        format!("{content}{entry}\n")
    } else {
        format!("{content}\n{entry}\n")
    };
    let _ = fs::write(&gitignore_path, new_content).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_mode_icon_model_aware() {
        let plugin = OpencodePlugin;
        // deepseek model (case-insensitive) -> deepseek
        assert_eq!(
            plugin.default_mode_icon(Some("deepseek-local/deepseek-v4")),
            "deepseek"
        );
        assert_eq!(plugin.default_mode_icon(Some("DeepSeek-R1")), "deepseek");
        // non-deepseek model -> opencode
        assert_eq!(plugin.default_mode_icon(Some("gpt-5")), "opencode");
        // missing model -> opencode
        assert_eq!(plugin.default_mode_icon(None), "opencode");
    }

    /// Regression guard for
    /// .vibekit/reports/2026-09-22-opencode-toggle-empty-then-syncs.md (B5):
    /// the recorder plugin MUST register via the generic `event` hook, not a
    /// top-level `"session.created"` key — opencode 1.18.x never invokes the
    /// latter at all (verified live), so the chat-id token file would
    /// silently never get written.
    #[test]
    fn vst_recorder_uses_event_hook_not_top_level_session_created() {
        assert!(
            VST_RECORDER.contains("event: async"),
            "recorder must register via the generic `event` hook"
        );
        assert!(
            VST_RECORDER.contains(r#"event.type !== "session.created""#),
            "recorder must branch on event.type, not a top-level hook key"
        );
        assert!(
            !VST_RECORDER.contains(r#""session.created": async"#),
            "must not use the dead top-level `\"session.created\"` hook key"
        );
    }

    #[test]
    fn default_channel_is_json() {
        assert_eq!(OpencodePlugin.default_channel(), Channel::Json);
    }

    // --- opencode v1 vs v2 argv shape -------------------------------------
    //
    // opencode v2 removed the top-level `-m/--model` flag (it survives only on
    // `opencode run`); passing it makes the CLI print `--help` and exit 1,
    // which killed a json→tty toggle outright. See
    // .vibekit/reports/2026-10-22-opencode-rich-chat-to-terminal-resume.md.

    #[test]
    fn legacy_argv_uses_top_level_model_flag() {
        assert_eq!(
            OpencodeCli::Legacy.launch_argv(Some("opencode/deepseek")),
            vec!["opencode", "-m", "opencode/deepseek"]
        );
        assert_eq!(
            OpencodeCli::Legacy.restore_argv(Some("opencode/deepseek"), "ses_abc"),
            vec![
                "opencode",
                "-m",
                "opencode/deepseek",
                "--session",
                "ses_abc"
            ]
        );
    }

    #[test]
    fn standalone_argv_never_passes_model_on_the_command_line() {
        // The model goes through OPENCODE_CONFIG; `--standalone` is what makes
        // the TUI honour it.
        assert_eq!(
            OpencodeCli::Standalone.launch_argv(Some("opencode/deepseek")),
            vec!["opencode", "--standalone"]
        );
        assert_eq!(
            OpencodeCli::Standalone.restore_argv(Some("opencode/deepseek"), "ses_abc"),
            vec!["opencode", "--standalone", "--session", "ses_abc"]
        );
    }

    #[test]
    fn unknown_shape_emits_only_flags_both_versions_accept() {
        // Probe failed: a resume must still work, at the cost of the model
        // override (which no argv flag can express on v2 anyway).
        assert_eq!(
            OpencodeCli::Unknown.launch_argv(Some("m")),
            vec!["opencode"]
        );
        assert_eq!(
            OpencodeCli::Unknown.restore_argv(Some("m"), "ses_abc"),
            vec!["opencode", "--session", "ses_abc"]
        );
    }

    #[test]
    fn detection_returns_a_known_shape() {
        // `opencode` may not be installed on the test machine — every shape is
        // a valid outcome; this pins that the probe is total and stable within
        // one binary identity.
        assert_eq!(opencode_cli(), opencode_cli());
    }

    #[test]
    fn help_parsing_detects_the_two_capabilities() {
        // Verbatim v2.1.2 `opencode --help` fragments: no top-level model
        // flag, `--standalone` present.
        let v2 = "FLAGS\n  --standalone            Run with a private server instead\n  \
                  --session, -s string    Session ID to continue\n";
        assert_eq!(
            OpencodeHelp::parse(v2),
            OpencodeHelp {
                top_level_model: false,
                standalone: true
            }
        );
        assert_eq!(OpencodeHelp::parse(v2).shape(), OpencodeCli::Standalone);

        // Verbatim v1.19.4 `opencode --help` fragments (captured from
        // `opencode-ai@1.19.4` in the dev sandbox): top-level `-m, --model`,
        // no `--standalone`.
        let v1 = "Options:\n  -h, --help          show help                                          \
                  [boolean]\n  -m, --model         model to use in the format of provider/model       \
                  [string]\n  -c, --continue      continue the last session                          \
                  [boolean]\n  -s, --session       session id to continue                             \
                  [string]\n  --fork          fork the session when continuing (use with --continue \
                  or --session)  [boolean]\n";
        assert_eq!(
            OpencodeHelp::parse(v1),
            OpencodeHelp {
                top_level_model: true,
                standalone: false
            }
        );
        assert_eq!(OpencodeHelp::parse(v1).shape(), OpencodeCli::Legacy);

        // Neither capability (or unreadable help) => the safe fallback, never a
        // shape that would make the CLI print help and exit.
        assert_eq!(
            OpencodeHelp::parse("USAGE\n  opencode <subcommand>\n").shape(),
            OpencodeCli::Unknown
        );

        // `--standalone` wins when a build advertises both.
        assert_eq!(
            OpencodeHelp::parse("-m, --model string\n--standalone\n").shape(),
            OpencodeCli::Standalone
        );

        // Substring lookalikes must not be mistaken for the flags.
        assert_eq!(
            OpencodeHelp::parse("--standalone-mode is not a flag; see model docs").shape(),
            OpencodeCli::Unknown
        );
    }

    /// The sentinel is a *paint* marker, not the binary's name: `"opencode"`
    /// never appears in opencode v2's TUI (it renders `OpenCode`), so on v2 the
    /// wait always ran the full 10 s fallback. Pinning the pairing here keeps a
    /// future sentinel edit from silently reverting to a marker that never
    /// matches.
    #[test]
    fn ready_sentinel_is_a_tui_paint_marker_not_the_binary_name() {
        // `"opencode"` (the binary name) never appears in a drawn TUI on either
        // generation — measured on v2.1.2 and v1.19.4 — so it always ran the
        // full 10 s fallback. `ctrl+p commands` is the status-bar hint both
        // paint. Pinning it here keeps a future edit from reverting to a marker
        // that never matches.
        let signal = OpencodePlugin.get_ready_signal();
        assert_eq!(signal.sentinel, Some("ctrl+p"));
        assert!(
            !signal.sentinel.is_some_and(|s| s.is_empty()),
            "an empty sentinel would match every pane immediately"
        );
        assert!(
            signal.fallback_ms > 0,
            "a zero fallback would skip the wait entirely"
        );
    }

    /// One deadline covers the whole probe. A binary that never exits must not
    /// hold the caller (a spawn path) past it, and must be killed.
    #[test]
    fn help_probe_is_bounded_and_kills_a_hung_binary() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("hangs");
        std::fs::write(&script, "#!/bin/sh\nsleep 30\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let started = std::time::Instant::now();
        let out = run_opencode_help(&script, Duration::from_millis(300));
        assert_eq!(out, None);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "probe must honour its deadline, took {:?}",
            started.elapsed()
        );
    }

    /// A probe that produces no output at all is `Unknown`, never a guess (and
    /// never a shape that could emit a flag the CLI rejects).
    #[test]
    fn help_probe_without_output_is_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let silent = dir.path().join("silent");
        std::fs::write(&silent, "#!/bin/sh\nexit 0\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&silent, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert_eq!(
            run_opencode_help(&silent, Duration::from_secs(2)),
            None,
            "nothing to parse => Unknown"
        );
    }

    #[test]
    fn blocking_config_write_carries_the_model() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("opencode-config.json");
        let prompt_path = dir.path().join("system-prompt.md");
        crate::opencode_config::write_opencode_config_blocking(
            &config_path,
            &[prompt_path.to_string_lossy().into_owned()],
            Some("opencode/deepseek-v4.1-flash-free"),
        );
        let raw = std::fs::read_to_string(&config_path).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["model"], "opencode/deepseek-v4.1-flash-free");
        assert_eq!(
            parsed["instructions"][0],
            prompt_path.to_string_lossy().as_ref()
        );

        // No model configured -> no `model` key at all (never an empty string,
        // which opencode would reject).
        crate::opencode_config::write_opencode_config_blocking(&config_path, &[], Some(""));
        let raw = std::fs::read_to_string(&config_path).unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert!(parsed.get("model").is_none());
    }
}
