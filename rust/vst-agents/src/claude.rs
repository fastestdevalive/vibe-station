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
pub const CLAUDE_MODELS: [&str; 12] = [
    "sonnet",
    "sonnet[1m]",
    "opus",
    "opus[1m]",
    "haiku",
    "fable",
    "claude-opus-4-5",
    "claude-opus-4-5[1m]",
    "claude-sonnet-4-5",
    "claude-sonnet-4-5[1m]",
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
                command: claude_acp_bun_command(),
                args: vec![claude_acp_entry_path()],
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

    fn acp_meta(&self, model: &str) -> Option<serde_json::Value> {
        let model_for_acp = match model {
            "claude-sonnet-4-5" => "claude-sonnet-4-5[1m]",
            "claude-opus-4-5" => "claude-opus-4-5[1m]",
            other => other,
        };
        Some(serde_json::json!({
            "claudeCode": {
                "options": {
                    "model": model_for_acp,
                    "betas": ["context-1m-2025-08-07"]
                }
            }
        }))
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
/// (A single compiled standalone binary via `bun build --compile` was tried
/// first and rejected: it silently fails at `session/new` with "Cannot find
/// package '@anthropic-ai/claude-agent-sdk'" — that dependency ships
/// per-platform optional variants Bun's static bundler can't resolve inside
/// a compiled binary's virtual filesystem, `--external` doesn't help either
/// since the externalized `require` can't walk up from a virtual path to a
/// real `node_modules` on disk. Running `bun` against the real, unmodified
/// `dist/index.js` — a real file, real `require.resolve` — has none of that
/// problem, confirmed end to end via `examples/acp_hello_bundled.rs`.)
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
///    `vst doctor` (`vst-cli/src/commands/doctor.rs`) also flags a missing
///    install ahead of time, but that only helps if someone actually runs it.
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
