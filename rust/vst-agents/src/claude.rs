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
use vst_types::{NormalizedEvent, NormalizedEventKind, NormalizedEventProvider};

use crate::acp_connection::AcpLaunchSpec;
use crate::acp_run_turn::{run_turn_acp, RunTurnAcpParams};
use crate::native_chat_id::find_latest_claude_chat_uuid;
use crate::plugin::{
    base_event, AgentPlugin, AsyncResult, CaptureArgs, ComposePromptInput, ComposePromptResult,
    LaunchConfig, ListModelsResult, PromptDelivery, ReadySignal, RestoreArgs, SkillInvocation,
    TurnContext, TurnInput,
};

/// Shell-quote a string by wrapping in single quotes (mirrors `sq` in shell.ts).
fn sq(s: &str) -> String {
    format!("'{s}'")
}

/// The curated claude model list (`CLAUDE_MODELS`).
pub const CLAUDE_MODELS: [&str; 8] = [
    "sonnet",
    "opus",
    "haiku",
    "fable",
    "claude-opus-4-5",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "claude-fable-5",
];

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

    fn default_model(&self) -> &str {
        "sonnet"
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

    fn list_models(&self) -> AsyncResult<ListModelsResult> {
        Box::pin(async move {
            ListModelsResult {
                models: CLAUDE_MODELS.iter().map(|s| s.to_string()).collect(),
                error: None,
            }
        })
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
            build_spec: Box::new(|ctx| AcpLaunchSpec {
                command: claude_acp_command(),
                args: vec![claude_acp_adapter_entry()],
                cwd: ctx.cwd.clone(),
                env: BTreeMap::from([("CLAUDE_CODE_EXECUTABLE".to_string(), "claude".to_string())])
                    .into_iter()
                    .collect(),
                initialize_timeout_ms: None,
                prompt_timeout_ms: None,
            }),
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
        };
        tokio::spawn(run_turn_acp(tx, input, ctx, cancel, params));
        rx
    }
}

/// The node binary that drives the claude ACP adapter (mirrors TS `process.execPath`).
fn claude_acp_command() -> String {
    std::env::var("VST_CLAUDE_ACP_NODE").unwrap_or_else(|_| "node".to_string())
}

/// The claude ACP adapter entrypoint (`dist/index.js`). The TS resolves this
/// via Node's `require.resolve`; Rust cannot, so the path comes from an env
/// var (`VST_CLAUDE_ACP_ADAPTER`) with a documented fallback to a conventional
/// npm global location. This is a live-verify item — flagged in the report.
fn claude_acp_adapter_entry() -> String {
    if let Ok(p) = std::env::var("VST_CLAUDE_ACP_ADAPTER") {
        if !p.is_empty() {
            return p;
        }
    }
    "@agentclientprotocol/claude-agent-acp/dist/index.js".to_string()
}

async fn write_mode_755(path: &PathBuf, content: &str) {
    let _ = fs::write(path, content).await;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).await;
    }
}
