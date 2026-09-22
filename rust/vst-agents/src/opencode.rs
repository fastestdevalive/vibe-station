//! OpenCode CLI plugin — ports `agent-plugins/opencode.ts`.
//!
//! System-prompt delivery: `OPENCODE_CONFIG` env (a JSON config whose
//! `instructions` point at the system-prompt file). Task-prompt delivery:
//! post-launch paste. Ready signal: `"opencode"` banner. `identical`
//! two-session-identity strategy: implements neither `capture_native_chat_id`
//! nor `supports_json_to_terminal_resume`.

use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::schema::v1::{ContentBlock, TextContent};
use serde_json::Value;
use tokio::fs;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use vst_types::{NormalizedEvent, NormalizedEventKind, NormalizedEventProvider, Role, ToolResult};

use crate::acp_connection::AcpLaunchSpec;
use crate::acp_run_turn::{run_turn_acp, RunTurnAcpParams};
use crate::claude::format_skill_directive;
use crate::context::{
    opencode_config_path_for as ctx_opencode_config_path_for, resolved_context_of,
    system_prompt_path_for as ctx_system_prompt_path_for,
};
use crate::opencode_config::write_opencode_config;
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
        match &cfg.model {
            Some(m) => vec!["opencode".to_string(), "-m".to_string(), m.clone()],
            None => vec!["opencode".to_string()],
        }
    }

    fn get_environment(&self, cfg: &LaunchConfig) -> BTreeMap<String, String> {
        let paths = Paths::default();
        let config_path = opencode_config_path_for(&paths, cfg);
        let prompt_file = system_prompt_path_for(&paths, cfg);
        // Best-effort write (mirrors the TS — updated AGENTS.md is always picked up).
        if let Some(parent) = config_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = write_opencode_config_blocking(&config_path, &prompt_file);
        BTreeMap::from([(
            "OPENCODE_CONFIG".to_string(),
            config_path.to_string_lossy().into_owned(),
        )])
    }

    fn get_ready_signal(&self) -> ReadySignal {
        ReadySignal {
            sentinel: Some("opencode"),
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
        // Mirrors TS `daemon/src/agent-plugins/opencode.ts`'s `listModels()`:
        // shell out to `opencode models` and split stdout into one model id
        // per line. This was previously stubbed to always return an empty
        // list + generic error (an earlier phase's "no live process" rule,
        // never wired up to a real subprocess afterward) — that stub is the
        // confirmed cause of "opencode is not showing any models".
        Box::pin(async move {
            match tokio::time::timeout(
                std::time::Duration::from_secs(15),
                tokio::process::Command::new("opencode")
                    .arg("models")
                    .output(),
            )
            .await
            {
                Ok(Ok(output)) if output.status.success() => {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let models: Vec<String> = stdout
                        .lines()
                        .map(|l| l.trim().to_string())
                        .filter(|l| !l.is_empty())
                        .collect();
                    ListModelsResult {
                        models,
                        error: None,
                    }
                }
                Ok(Ok(output)) => {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    eprintln!(
                        "[cli-models] opencode fetch failed: status={} stderr={}",
                        output.status,
                        stderr.trim()
                    );
                    ListModelsResult {
                        models: vec![],
                        error: Some(
                            "Failed to fetch models from CLI. Check that the CLI is installed and authenticated."
                                .to_string(),
                        ),
                    }
                }
                Ok(Err(err)) => {
                    eprintln!("[cli-models] opencode fetch failed to spawn: {err}");
                    ListModelsResult {
                        models: vec![],
                        error: Some(
                            "Failed to fetch models from CLI. Check that the CLI is installed and authenticated."
                                .to_string(),
                        ),
                    }
                }
                Err(_timeout) => {
                    eprintln!("[cli-models] opencode fetch timed out after 15s");
                    ListModelsResult {
                        models: vec![],
                        error: Some(
                            "Failed to fetch models from CLI. Check that the CLI is installed and authenticated."
                                .to_string(),
                        ),
                    }
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
                    let mut argv = vec!["opencode".to_string()];
                    if let Some(model) = model {
                        argv.push("-m".to_string());
                        argv.push(model);
                    }
                    argv.push("--session".to_string());
                    argv.push(id);
                    Some(argv)
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
                        ("VST_SPAWN_TOKEN".to_string(), ctx.session.id.clone()),
                    ])
                    .into_iter()
                    .collect(),
                    initialize_timeout_ms: None,
                    prompt_timeout_ms: None,
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

/// Synchronous best-effort config write used inside `get_environment` (which is
/// synchronous). Mirrors the TS `writeOpenCodeConfig` call there.
fn write_opencode_config_blocking(config_path: &PathBuf, prompt_file: &PathBuf) {
    let config = serde_json::json!({
        "instructions": [prompt_file.to_string_lossy()],
        "permission": { "*": { "*": "allow" } },
    });
    let pretty = serde_json::to_string_pretty(&config).unwrap_or_default();
    let _ = std::fs::write(config_path, format!("{pretty}\n"));
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
}
