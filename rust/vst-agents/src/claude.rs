//! Claude Code CLI plugin — ports `agent-plugins/claude.ts`.
//!
//! Delivery: inline (system + task prompts via CLI flags). Ready signal: waits
//! for the interactive prompt sentinel `"> "`. `identical` two-session-identity
//! strategy: implements neither `capture_native_chat_id` nor
//! `supports_json_to_terminal_resume`.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::schema::v1::{ContentBlock, TextContent};
use tokio::fs;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use vst_types::{Channel, NormalizedEvent, NormalizedEventKind, NormalizedEventProvider};

use crate::acp_connection::{AcpConnection, AcpLaunchSpec};
use crate::acp_run_turn::{run_turn_acp, RunTurnAcpParams};
use crate::acp_transport::AcpTransport;
use crate::native_chat_id::find_latest_claude_chat_uuid;
use crate::plugin::{
    base_event, AgentPlugin, AsyncResult, CaptureArgs, ComposePromptInput, ComposePromptResult,
    LaunchConfig, ListModelsResult, PromptDelivery, ReadySignal, RestoreArgs, SkillInvocation,
    StarterBundleEntry, TurnContext, TurnInput,
};

/// Shell-quote a string (escapes embedded `'`) — see [`vst_proc::sq`]. A
/// local unescaped `'{s}'` here once broke any task prompt containing an
/// apostrophe (`sh -lc` syntax error → pane dies instantly → `exited`).
use vst_proc::sq;

/// Launch spec for the claude ACP adapter — shared by real turns and the
/// model-list probe so both always run the same setup.
///
/// A compiled, self-contained `claude-acp` binary (see [`claude_acp_bin`]) is
/// preferred: no `bun` needed at runtime. Without one — dev checkouts, the
/// Tauri bundle, or an explicit `VST_CLAUDE_ACP_ENTRY` override — it falls back
/// to `bun <entry.js>`.
fn claude_acp_spec(cwd: PathBuf) -> AcpLaunchSpec {
    let (command, args) = match claude_acp_bin() {
        Some(bin) => (bin.to_string_lossy().to_string(), Vec::new()),
        None => (claude_acp_bun_command(), vec![claude_acp_entry_path()]),
    };
    AcpLaunchSpec {
        command,
        args,
        cwd,
        env: BTreeMap::from([("CLAUDE_CODE_EXECUTABLE".to_string(), "claude".to_string())])
            .into_iter()
            .collect(),
        initialize_timeout_ms: None,
        prompt_timeout_ms: None,
        reap_detached_descendants: false,
    }
}

/// Name of the compiled claude ACP adapter binary shipped in the CLI tarball.
pub const CLAUDE_ACP_BIN_NAME: &str = "claude-acp";

/// Env var for an explicit compiled-adapter path override.
pub const CLAUDE_ACP_BIN_ENV: &str = "VST_CLAUDE_ACP_BIN";

/// Resolve the compiled `claude-acp` adapter (`bun build --compile` of the
/// pinned `@agentclientprotocol/claude-agent-acp`, built by
/// `scripts/build-claude-acp.sh`). Order: `VST_CLAUDE_ACP_BIN` env → `claude-acp`
/// beside `current_exe()` (the curl-install layout). `None` when neither
/// resolves, or when `VST_CLAUDE_ACP_ENTRY` is set — that explicit
/// `bun <entry.js>` override (dev sandbox, `tauri dev`, desktop bundle) wins.
pub fn claude_acp_bin() -> Option<PathBuf> {
    if std::env::var("VST_CLAUDE_ACP_ENTRY").is_ok_and(|v| !v.is_empty()) {
        return None;
    }
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(PathBuf::from));
    resolve_claude_acp_bin(
        std::env::var(CLAUDE_ACP_BIN_ENV).ok().as_deref(),
        exe_dir.as_deref(),
    )
}

fn resolve_claude_acp_bin(
    env_value: Option<&str>,
    exe_dir: Option<&std::path::Path>,
) -> Option<PathBuf> {
    if let Some(p) = env_value.map(str::trim).filter(|p| !p.is_empty()) {
        let pb = PathBuf::from(p);
        // A dangling override must not be reported as available.
        if pb.is_file() {
            return Some(pb);
        }
    }
    let beside = exe_dir?.join(CLAUDE_ACP_BIN_NAME);
    beside.is_file().then_some(beside)
}

/// Budget for the whole throwaway `initialize` + `session/new` model probe.
const LIST_MODELS_TIMEOUT_MS: u64 = 30_000;

/// Format (never resolve) a `<skill-invocations>` directive block and append it
/// to `message` — `formatSkillDirective` in `claude.ts`.
pub fn format_skill_directive(
    message: &str,
    skill_invocations: Option<&[SkillInvocation]>,
) -> String {
    let invocations = match skill_invocations {
        Some(s) if !s.is_empty() => s,
        _ => return message.to_string(),
    };
    let entries: Vec<String> = invocations
        .iter()
        .enumerate()
        .map(|(i, inv)| {
            let invoke_line = match &inv.path {
                Some(p) if !p.is_empty() => format!("Invoke the skill defined at {p}"),
                _ => format!("Invoke the skill named `{}`", inv.name),
            };
            let mut lines = vec![format!("{}. {}", i + 1, invoke_line)];
            if !inv.args.trim().is_empty() {
                lines.push(format!("   with arguments: {}", inv.args));
            }
            lines.join("\n")
        })
        .collect();
    let preamble = "The following are skill invocations to EXECUTE now — treat each as a command to run, not a topic to discuss:";
    format!(
        "{message}\n\n<skill-invocations>\n{preamble}\n\n{}\n</skill-invocations>",
        entries.join("\n")
    )
}

/// `.claude/vibe-recorder.sh` hook script (VST_SPAWN_TOKEN → chat-id capture).
const VIBE_RECORDER_SCRIPT: &str = r#"#!/usr/bin/env bash
set -euo pipefail
token="${VST_SPAWN_TOKEN:-}"
[ -z "$token" ] && exit 0
uuid=$(jq -r '.session_id // empty')
[ -z "$uuid" ] && exit 0
dir="$CLAUDE_PROJECT_DIR/.vibe-station/agent-chat-ids"
mkdir -p "$dir"
printf '%s' "$uuid" > "$dir/$token"
"#;

/// `.claude/vibe-uploads.sh` hook script (terminal-mode file upload).
const VIBE_UPLOADS_SCRIPT: &str = r#"#!/usr/bin/env bash
set -euo pipefail
token="${VST_SPAWN_TOKEN:-}"
[ -z "$token" ] && exit 0
dir="$CLAUDE_PROJECT_DIR/.vibe-station/pending-uploads/$token"
[ -d "$dir" ] || exit 0
shopt -s nullglob
files=("$dir"/*)
[ ${#files[@]} -eq 0 ] && exit 0
echo "The user attached the following file(s) via the vibe-station UI — use the Read tool to view them if relevant to the request:"
for f in "${files[@]}"; do
  path=$(cat "$f")
  echo "- $path"
  rm -f "$f"
done
"#;

/// The `/vst` custom slash-command template written to `.claude/commands/vst.md`.
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

/// True when `command` already appears in a `hooks.<Event>` array (idempotent merge).
fn has_hook_command(entries: &[serde_json::Value], command: &str) -> bool {
    entries.iter().any(|entry| {
        entry
            .get("hooks")
            .and_then(|h| h.as_array())
            .map(|hooks| {
                hooks
                    .iter()
                    .any(|h| h.get("command").and_then(|c| c.as_str()) == Some(command))
            })
            .unwrap_or(false)
    })
}

fn hook_entry(command: &str) -> serde_json::Value {
    serde_json::json!({ "hooks": [{ "type": "command", "command": command }] })
}

/// Claude Code plugin (stateless singleton).
pub struct ClaudePlugin;

/// Create a fresh claude plugin instance (`createClaudePlugin`).
pub fn create_claude_plugin() -> ClaudePlugin {
    ClaudePlugin
}

impl AgentPlugin for ClaudePlugin {
    fn name(&self) -> &str {
        "claude"
    }

    /// Empty = "no explicit model": the adapter/account default applies. A
    /// hardcoded id here could name a model the account doesn't have.
    fn default_model(&self) -> &str {
        ""
    }

    fn default_mode_icon(&self, _model: Option<&str>) -> &'static str {
        "claude"
    }

    fn prompt_delivery(&self) -> PromptDelivery {
        PromptDelivery::Inline
    }

    fn get_launch_command(&self, _cfg: &LaunchConfig) -> Vec<String> {
        vec!["claude".to_string()]
    }

    fn get_environment(&self, _cfg: &LaunchConfig) -> BTreeMap<String, String> {
        BTreeMap::from([
            ("CLAUDECODE".to_string(), "1".to_string()),
            ("CLAUDE_CODE_ENTRYPOINT".to_string(), "cli".to_string()),
        ])
    }

    fn get_ready_signal(&self) -> ReadySignal {
        ReadySignal {
            sentinel: Some("> "),
            fallback_ms: 15_000,
        }
    }

    fn compose_launch_prompt(&self, input: ComposePromptInput) -> ComposePromptResult {
        let file_part = format!("\"$(cat {})\"", sq(&input.system_prompt_file));
        let mut shell_line =
            format!("claude --dangerously-skip-permissions --chrome --system-prompt {file_part}");
        if let Some(model) = &input.launch_cfg.model {
            shell_line.push_str(&format!(" --model {}", sq(model)));
        }
        if let Some(task) = &input.task_prompt {
            shell_line.push(' ');
            shell_line.push_str(&sq(task));
        }
        ComposePromptResult {
            use_shell: true,
            shell_line: Some(shell_line),
            launch_args: None,
            post_launch_input: None,
            ..Default::default()
        }
    }

    fn default_channel(&self) -> Channel {
        Channel::Json
    }

    fn setup_workspace_hooks(&self, workspace_path: &str) -> AsyncResult<()> {
        let root = PathBuf::from(workspace_path);
        Box::pin(async move {
            let claude_dir = root.join(".claude");
            let commands_dir = claude_dir.join("commands");
            let _ = fs::create_dir_all(&claude_dir).await;
            let _ = fs::create_dir_all(&commands_dir).await;

            let vst_command_path = claude_dir.join("commands").join("vst.md");
            let existing = fs::read_to_string(&vst_command_path)
                .await
                .unwrap_or_default();
            if existing != VST_COMMAND {
                let _ = fs::write(&vst_command_path, VST_COMMAND).await;
            }

            let hook_script = claude_dir.join("vibe-recorder.sh");
            write_mode_755(&hook_script, VIBE_RECORDER_SCRIPT).await;
            let uploads_script = claude_dir.join("vibe-uploads.sh");
            write_mode_755(&uploads_script, VIBE_UPLOADS_SCRIPT).await;

            let _ = ensure_gitignore_entry(root.join(".gitignore"), ".claude/").await;
            let _ = ensure_gitignore_entry(root.join(".gitignore"), ".vibe-station/").await;

            let settings_path = claude_dir.join("settings.json");
            let raw = fs::read_to_string(&settings_path).await.unwrap_or_default();
            let mut settings: serde_json::Value =
                serde_json::from_str(&raw).unwrap_or(serde_json::Value::Object(Default::default()));
            let session_start = settings
                .pointer_mut("/hooks/SessionStart")
                .and_then(|v| v.as_array_mut())
                .cloned()
                .unwrap_or_default();
            let upload_hooks = settings
                .pointer("/hooks/UserPromptSubmit")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let needs_session_start = !has_hook_command(&session_start, ".claude/vibe-recorder.sh");
            let needs_uploads = !has_hook_command(&upload_hooks, ".claude/vibe-uploads.sh");

            if needs_session_start || needs_uploads {
                let mut new_session_start = session_start;
                if needs_session_start {
                    new_session_start.push(hook_entry(".claude/vibe-recorder.sh"));
                }
                let mut new_upload_hooks = upload_hooks;
                if needs_uploads {
                    new_upload_hooks.push(hook_entry(".claude/vibe-uploads.sh"));
                }
                let obj = settings.as_object_mut().expect("settings object");
                let hooks = obj.entry("hooks").or_insert_with(|| serde_json::json!({}));
                if let Some(h) = hooks.as_object_mut() {
                    h.insert(
                        "SessionStart".into(),
                        serde_json::Value::Array(new_session_start),
                    );
                    h.insert(
                        "UserPromptSubmit".into(),
                        serde_json::Value::Array(new_upload_hooks),
                    );
                }
                let pretty = serde_json::to_string_pretty(&settings).unwrap_or_default();
                let _ = fs::write(&settings_path, format!("{pretty}\n")).await;
            }
        })
    }

    fn capture_chat_id(&self, args: CaptureArgs<'_>) -> AsyncResult<Option<String>> {
        let token_file = PathBuf::from(args.cwd)
            .join(".vibe-station")
            .join("agent-chat-ids")
            .join(&args.session.id);
        Box::pin(async move {
            let Ok(raw) = fs::read_to_string(&token_file).await else {
                return None;
            };
            let uuid = raw.trim().to_string();
            let _ = fs::remove_file(&token_file).await;
            if uuid.is_empty() {
                None
            } else {
                Some(uuid)
            }
        })
    }

    /// Live list from a throwaway ACP `session/new` (its `configOptions`
    /// model select). There is deliberately no static fallback: any failure
    /// (spawn, not logged in, no model selector) comes back as `error`.
    fn list_models(&self) -> AsyncResult<ListModelsResult> {
        Box::pin(async move {
            let fail = |e: String| {
                let lower = e.to_lowercase();
                let hint = if lower.contains("auth") || lower.contains("login") {
                    " Check that you're logged in (`claude /login`)."
                } else {
                    ""
                };
                ListModelsResult {
                    models: Vec::new(),
                    error: Some(format!(
                        "Couldn't fetch the model list from Claude: {e}.{hint}"
                    )),
                }
            };
            // A stable, daemon-owned cwd for the probe session: the adapter
            // loads `.claude/settings.json` (hooks) from `session/new`'s cwd,
            // so it must not be a shared world-writable dir, and reusing one
            // path avoids leaving a new per-probe project entry under ~/.claude.
            let probe_cwd = crate::home::home_dir()
                .join(".vibe-station")
                .join("model-probe");
            if let Err(e) = fs::create_dir_all(&probe_cwd).await {
                return fail(format!("couldn't create the probe directory: {e}"));
            }
            let conn = AcpConnection::new(AcpLaunchSpec {
                initialize_timeout_ms: Some(LIST_MODELS_TIMEOUT_MS),
                ..claude_acp_spec(probe_cwd.clone())
            });
            let outcome = tokio::time::timeout(
                std::time::Duration::from_millis(LIST_MODELS_TIMEOUT_MS),
                async {
                    conn.initialize().await?;
                    conn.new_session(&probe_cwd, None).await
                },
            )
            .await;
            conn.dispose().await;
            match outcome {
                Err(_) => fail("timed out".to_string()),
                Ok(Err(e)) => fail(e.to_string()),
                Ok(Ok(o)) if o.models.is_empty() => fail("Claude advertised no models".to_string()),
                Ok(Ok(o)) => ListModelsResult {
                    models: o.models,
                    error: None,
                },
            }
        })
    }

    fn model_list_is_authoritative(&self) -> bool {
        true
    }

    fn resolve_starter_model(&self, name: &str, live_models: &[String]) -> Option<String> {
        if let Some(exact) = live_models.iter().find(|m| m.as_str() == name) {
            return Some(exact.clone());
        }
        // Family match (`fable` -> `claude-fable-5-1`): pick the highest
        // version by its numeric segments, independent of list order.
        let prefix = format!("claude-{name}-");
        live_models
            .iter()
            .filter_map(|m| {
                let rest = m.strip_prefix(&prefix)?;
                let version: Vec<u32> = rest
                    .split('-')
                    // Stop at a date-like suffix (e.g. `-20260101`).
                    .map_while(|seg| seg.parse::<u32>().ok().filter(|_| seg.len() < 8))
                    .collect();
                (!version.is_empty()).then_some((version, m))
            })
            .max_by(|a, b| a.0.cmp(&b.0))
            .map(|(_, m)| m.clone())
    }

    fn starter_bundle(&self) -> Vec<StarterBundleEntry> {
        vec![
            StarterBundleEntry {
                name: "sonnet-implementer".to_string(),
                model_name: Some("sonnet".to_string()),
                context:
                    "You are an implementation-focused coding agent. Write and modify code directly, favoring working increments over long upfront design."
                        .to_string(),
            },
            StarterBundleEntry {
                name: "opus-planner".to_string(),
                model_name: Some("opus".to_string()),
                context:
                    "You are a planning-focused coding agent. Investigate the codebase and produce a clear implementation plan before writing code."
                        .to_string(),
            },
            StarterBundleEntry {
                name: "fable-security-reviewer".to_string(),
                model_name: Some("fable".to_string()),
                context:
                    "You are a security-focused code reviewer. Review diffs for vulnerabilities, unsafe patterns, and missing input validation."
                        .to_string(),
            },
        ]
    }

    fn get_fork_command(&self) -> Option<Vec<String>> {
        Some(vec!["--fork-session".to_string()])
    }

    fn get_restore_command(&self, args: RestoreArgs<'_>) -> AsyncResult<Option<Vec<String>>> {
        let uuid = args.session.agent_chat_id.clone();
        let cwd = args.cwd.to_string();
        let model = args.model.map(|m| m.to_string());
        Box::pin(async move {
            let uuid = match uuid {
                Some(u) if !u.is_empty() => u,
                _ => match find_latest_claude_chat_uuid(&cwd).await {
                    Some(u) => u,
                    None => return None,
                },
            };
            let mut argv = vec![
                "claude".to_string(),
                "--resume".to_string(),
                uuid,
                "--dangerously-skip-permissions".to_string(),
                "--chrome".to_string(),
            ];
            if let Some(model) = model {
                argv.push("--model".to_string());
                argv.push(model);
            }
            Some(argv)
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

    fn supports_mid_turn_steering(&self) -> bool {
        true
    }

    fn run_turn(
        &self,
        input: TurnInput,
        ctx: TurnContext,
        cancel: CancellationToken,
    ) -> mpsc::UnboundedReceiver<NormalizedEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        let params = RunTurnAcpParams {
            provider: NormalizedEventProvider::Claude,
            build_spec: Box::new(|ctx| claude_acp_spec(ctx.cwd.clone())),
            enrich: None,
            // Decision 6 Option A: the ACP session id IS claude's native resume
            // id — surface it as `agentChatId` via a synthetic `session_init`.
            first_turn_session_init: Some(Arc::new(|ctx, acp_id| {
                let mut ev = base_event(
                    &ctx.session.id,
                    NormalizedEventProvider::Claude,
                    NormalizedEventKind::SessionInit,
                );
                ev.agent_chat_id = Some(acp_id.to_string());
                if let Some(model) = &ctx.model {
                    ev.model = Some(model.clone());
                }
                ev
            })),
            // prompt[0] MUST be the user message (upstream reads prompt[0] for
            // slash-command detection); the system prompt is the SECOND block
            // on the first turn only (closest analog to `--append-system-prompt`).
            build_prompt_blocks: Box::new(|_ctx, input, system| {
                let mut blocks = vec![ContentBlock::Text(TextContent::new(
                    format_skill_directive(&input.message, input.skill_invocations.as_deref()),
                ))];
                if let Some(sys) = system {
                    if !sys.is_empty() {
                        blocks.push(ContentBlock::Text(TextContent::new(sys.to_string())));
                    }
                }
                blocks
            }),
            emit_refusal_error: true,
            stuck_turn_idle_ms: None,
            stuck_turn_cancel_grace_ms: None,
        };
        tokio::spawn(run_turn_acp(tx, input, ctx, cancel, params));
        rx
    }

    fn acp_meta(&self, model: &str) -> Option<serde_json::Value> {
        let model_for_acp = model;
        let mut options = serde_json::json!({
            "betas": ["context-1m-2025-08-07"],
            // Parity with the terminal channel's `--chrome`; the adapter has no chrome option but
            // merges `extraArgs` into the claude CLI args (null = boolean flag).
            "extraArgs": { "chrome": null },
            // claude.ai Artifacts / Claude Design are default-off for SDK entrypoints; this opts in
            // (terminal sessions get them via the interactive entrypoint).
            "env": { "CLAUDE_CODE_ARTIFACT": "1" },
        });
        if !model_for_acp.is_empty() {
            options["model"] = serde_json::json!(model_for_acp);
        }
        Some(serde_json::json!({ "claudeCode": { "options": options } }))
    }

    /// claude-agent-acp ranks `ANTHROPIC_MODEL` above every other model
    /// source. Inherited from the user's shell (e.g. `claude-sonnet-4-6`), it
    /// made `session/new` report the env model while turns ran `_meta`'s,
    /// and on `session/load` the adapter re-asserted it with `setModel`, so
    /// turns ran it (200k) instead of the mode's `sonnet` (1M). Pinning the
    /// var to the session's model removes that source of drift. Empty = the
    /// account default: the user's own `ANTHROPIC_MODEL`, if any, is left
    /// alone, matching a terminal `claude` with no `--model`.
    fn acp_model_env(&self, model: &str) -> BTreeMap<String, String> {
        if model.is_empty() {
            return BTreeMap::new();
        }
        BTreeMap::from([("ANTHROPIC_MODEL".to_string(), model.to_string())])
    }

    /// `_meta`'s model above is honoured only by `session/new`. On
    /// `session/load` the adapter ignores `_meta`: the session resumes on the
    /// transcript's model (or the env one, see [`Self::acp_model_env`]). An
    /// explicit `session/set_config_option {configId: "model"}` after load
    /// re-pins it (verified against adapter 0.70.0: the next turn runs the
    /// requested model, 1M window). The reported `currentValue` can be a full
    /// id naming the requested alias's model, so the session layer may
    /// re-assert a model that already applies — harmless. Empty = no
    /// preference, never sent.
    fn acp_initial_config_option(&self, model: &str) -> Option<(String, String)> {
        if model.is_empty() {
            return None;
        }
        Some(("model".to_string(), model.to_string()))
    }

    /// claude-agent-acp rejects a model it can't resolve with "Invalid value"
    /// every time — there is no startup race to win by respawning.
    fn acp_model_refusal_is_final(&self) -> bool {
        true
    }
}

/// The `bun` binary that runs the claude ACP adapter. `bun` (not `node`) is
/// used deliberately: it's already a required, doctor-checked dependency for
/// agy's own ACP path, and — unlike `node` — can run the adapter's real
/// `dist/index.js` directly with no separate install/compile step of its
/// own. This is the load-bearing reason Node.js is no longer a daemon
/// dependency for Claude: `bun <entry.js>` replaces `node <entry.js>`
/// one-for-one, sharing the tool the project already requires elsewhere.
///
/// (A compiled standalone binary was once tried and recorded here as failing
/// at `session/new` with "Cannot find package '@anthropic-ai/claude-agent-sdk'".
/// Re-tested with bun 1.4.2 + adapter 0.70.0: `bun build --compile` of
/// `dist/index.js` completes `initialize`, `session/new` AND a real prompt turn
/// from a directory with no `node_modules` — that is now the curl-install form,
/// see [`claude_acp_bin`]. This `bun <entry.js>` path stays for dev/desktop.)
fn claude_acp_bun_command() -> String {
    std::env::var("VST_CLAUDE_ACP_BUN").unwrap_or_else(|_| "bun".to_string())
}

/// The claude-agent-acp adapter's real entrypoint (`dist/index.js`), from a
/// vendored install pinned in `vendor/claude-acp/package.json` and produced
/// by `scripts/install-claude-acp-vendor.sh` (`bun install --omit=optional` —
/// the `--omit=optional` matters: without it, `bun install` pulls BOTH
/// platform-specific `@anthropic-ai/claude-agent-sdk-*` packages, 300MB+
/// each, that this project never uses because `CLAUDE_CODE_EXECUTABLE` below
/// already points the adapter at the real, separately-installed `claude` CLI
/// instead — 56MB installed vs. 666MB with them).
///
/// Running the *official* adapter via `bun` gets the "no Node.js install"
/// outcome without taking on a reimplementation of its undocumented,
/// no-compatibility-guarantee wire protocol.
///
/// Resolution order — a bare `cargo run` from inside the repo needs zero env
/// vars (case 3); the dev sandbox, `tauri dev` and the packaged desktop app
/// all set `VST_CLAUDE_ACP_ENTRY` explicitly (case 1):
/// 1. `VST_CLAUDE_ACP_ENTRY` env var, if set — explicit override, always wins.
///    This is how the packaged Tauri desktop app finds it:
///    `desktop/src-tauri/src/daemon.rs` resolves the bundle's resource dir
///    (`tauri.conf.json`'s `bundle.resources` stages the vendor install as
///    `claude-acp-vendor/node_modules`) and sets this on the sidecar. The dev
///    sandbox (`scripts/dev-entrypoint.sh`) and `tauri dev`
///    (`scripts/dev-start.sh`) set it explicitly too.
/// 2. `<dir of the running exe>/claude-acp-vendor/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js`
///    — for a hand-staged layout that puts the vendor dir beside the daemon
///    binary (mirrors how `agent-orchestrator`, a sibling project solving the
///    identical problem, places its own Node/ACP runtime beside its own
///    executable). NOT what a Tauri bundle produces — Tauri resources land
///    in a separate resource dir (`Contents/Resources/` on macOS,
///    `/usr/lib/<app>/` for a Linux deb), which is why case 1 exists.
/// 3. Walk UPWARD from the current working directory (bounded to 8 levels)
///    looking for `vendor/claude-acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js`
///    — the DEV/DOCKER-SANDBOX convention: a plain `cargo run`/`cargo build`
///    from anywhere inside the repo, or the dev-sandbox container (cwd
///    `/app`, the repo root — see `dev.Dockerfile`), finds the vendor
///    install this way with no env var needed. `dev.Dockerfile` installs it
///    at image-build time (`scripts/install-claude-acp-vendor.sh`).
/// 4. Falls back to the raw npm specifier so a caller still gets SOME argv
///    instead of a panic if none of the above resolved. Also `eprintln!`s the
///    resolution failure directly — the OLD node-based resolver did this too
///    (see git history), and losing it here would make a broken install
///    silently produce a generic downstream ACP connection error with no
///    hint that entry-path resolution itself came up empty.
///    `vst doctor` does NOT check for the adapter install itself — only for
///    `bun`. The curl tarball ships the compiled `claude-acp` binary instead
///    (see [`claude_acp_bin`]), so this bun path is the dev/desktop fallback.
pub fn claude_acp_entry_path() -> String {
    if let Ok(p) = std::env::var("VST_CLAUDE_ACP_ENTRY") {
        if !p.is_empty() {
            return p;
        }
    }
    static RESOLVED: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    RESOLVED.get_or_init(resolve_claude_acp_entry_path).clone()
}

/// Relative suffix shared by both the beside-exe and walk-upward candidates.
const VENDOR_ENTRY_SUFFIX: &[&str] = &[
    "node_modules",
    "@agentclientprotocol",
    "claude-agent-acp",
    "dist",
    "index.js",
];

fn resolve_claude_acp_entry_path() -> String {
    // Candidate 2: beside the running exe, under `claude-acp-vendor/` (packaged builds).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let mut candidate = dir.join("claude-acp-vendor");
            candidate.extend(VENDOR_ENTRY_SUFFIX);
            if candidate.is_file() {
                return candidate.to_string_lossy().to_string();
            }
        }
    }
    // Candidate 3: walk upward from cwd looking for `vendor/claude-acp/...` (dev/Docker).
    if let Ok(cwd) = std::env::current_dir() {
        for ancestor in cwd.ancestors().take(8) {
            let mut candidate = ancestor.join("vendor").join("claude-acp");
            candidate.extend(VENDOR_ENTRY_SUFFIX);
            if candidate.is_file() {
                return candidate.to_string_lossy().to_string();
            }
        }
    }
    // Candidate 4: no install found anywhere. Diagnose loudly — this used to
    // be silent-until-downstream-failure, which made the actual root cause
    // (missing vendor install) much harder to spot than the generic ACP
    // connection error it produces a few layers up.
    eprintln!(
        "[claude-acp] no vendored install found (checked VST_CLAUDE_ACP_ENTRY, beside-exe, and \
         vendor/claude-acp/ walking up from cwd) — falling back to a bare npm specifier, which \
         will fail to spawn. Run ./scripts/install-claude-acp-vendor.sh, or set VST_CLAUDE_ACP_ENTRY."
    );
    CLAUDE_ACP_ADAPTER_SPECIFIER.to_string()
}

const CLAUDE_ACP_ADAPTER_SPECIFIER: &str = "@agentclientprotocol/claude-agent-acp/dist/index.js";

async fn write_mode_755(path: &PathBuf, content: &str) {
    let _ = fs::write(path, content).await;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).await;
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn claude_acp_bin_prefers_env_then_beside_exe() {
        use super::resolve_claude_acp_bin;
        let dir = tempfile::tempdir().unwrap();
        let beside = dir.path().join("claude-acp");
        let other = dir.path().join("override-bin");
        // Nothing exists yet: nothing resolves, and a dangling override is ignored.
        assert_eq!(resolve_claude_acp_bin(None, Some(dir.path())), None);
        assert_eq!(
            resolve_claude_acp_bin(other.to_str(), Some(dir.path())),
            None
        );
        std::fs::write(&beside, b"").unwrap();
        assert_eq!(
            resolve_claude_acp_bin(None, Some(dir.path())),
            Some(beside.clone())
        );
        assert_eq!(resolve_claude_acp_bin(Some("  "), None), None);
        // A real override beats the beside-exe copy.
        std::fs::write(&other, b"").unwrap();
        assert_eq!(
            resolve_claude_acp_bin(other.to_str(), Some(dir.path())),
            Some(other)
        );
    }

    #[test]
    fn resolve_starter_model_matches_family_newest_first() {
        let live: Vec<String> = [
            "default",
            "opus",
            "claude-fable-5-1",
            "sonnet",
            "claude-fable-5",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let p = create_claude_plugin();
        assert_eq!(
            p.resolve_starter_model("opus", &live).as_deref(),
            Some("opus")
        );
        assert_eq!(
            p.resolve_starter_model("fable", &live).as_deref(),
            Some("claude-fable-5-1")
        );
        assert_eq!(p.resolve_starter_model("haiku", &live), None);
        let dated: Vec<String> = ["claude-fable-5-20260101", "claude-fable-5-1"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(
            p.resolve_starter_model("fable", &dated).as_deref(),
            Some("claude-fable-5-1")
        );
        // Independent of list order (oldest first here).
        let oldest_first: Vec<String> = ["claude-fable-4-9", "claude-fable-5", "claude-fable-5-1"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(
            p.resolve_starter_model("fable", &oldest_first).as_deref(),
            Some("claude-fable-5-1")
        );
    }

    use super::*;

    #[test]
    fn starter_bundle_returns_three_curated_modes() {
        let plugin = ClaudePlugin;
        let bundle = plugin.starter_bundle();
        assert_eq!(bundle.len(), 3);
        let names: Vec<&str> = bundle.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "sonnet-implementer",
                "opus-planner",
                "fable-security-reviewer"
            ]
        );
        let models: Vec<Option<&str>> = bundle.iter().map(|e| e.model_name.as_deref()).collect();
        assert_eq!(models, vec![Some("sonnet"), Some("opus"), Some("fable")]);
    }

    #[test]
    fn binary_name_defaults_to_claude() {
        let plugin = ClaudePlugin;
        assert_eq!(plugin.binary_name(), "claude");
    }

    #[test]
    fn default_channel_is_json() {
        assert_eq!(ClaudePlugin.default_channel(), Channel::Json);
    }
}
