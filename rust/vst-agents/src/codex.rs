//! Codex agent plugin.
//!
//! Delivery: inline (system + task prompts baked into the launch command).
//! Ready signal: no sentinel, 12s fallback.
//! The ACP session id is codex's native thread id; `capture_native_chat_id`
//! adopts it verbatim as `agent_chat_id`.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

use agent_client_protocol::schema::v1::{ContentBlock, TextContent};
use tokio::fs;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use vst_proc::sq;
use vst_types::{Channel, NormalizedEvent, NormalizedEventProvider};

use crate::acp_connection::AcpLaunchSpec;
use crate::acp_run_turn::{run_turn_acp, RunTurnAcpParams};
use crate::plugin::{
    AgentPlugin, AsyncResult, CaptureArgs, CaptureNativeChatIdArgs, ComposePromptInput,
    ComposePromptResult, LaunchConfig, ListModelsResult, PromptDelivery, ReadySignal, RestoreArgs,
    TurnContext, TurnInput,
};

/// `.codex/vibe-uploads.sh` hook script (terminal-mode file upload).
///
/// Runs on every codex `UserPromptSubmit`. If `VST_SPAWN_TOKEN` is set and the
/// per-session pending-uploads dir has pointer files, prints the attached paths
/// to stdout (which codex feeds to the model as context) and deletes the
/// pointers. Otherwise it is a silent no-op that exits 0.
const VIBE_UPLOADS_SCRIPT: &str = r#"#!/usr/bin/env bash
set -euo pipefail
token="${VST_SPAWN_TOKEN:-}"
[ -z "$token" ] && exit 0
root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/.vibe-station/pending-uploads/$token"
[ -d "$dir" ] || exit 0
shopt -s nullglob
files=("$dir"/*)
[ ${#files[@]} -eq 0 ] && exit 0
echo "The user attached the following file(s) via the vibe-station UI — read them with your shell/file tools if relevant to the request:"
for f in "${files[@]}"; do
  path=$(cat "$f")
  echo "- $path"
  rm -f "$f"
done
"#;

/// `.codex/vibe-recorder.sh` — codex `SessionStart` hook: records this session's
/// codex thread id so the daemon can resume exactly THIS conversation (two codex
/// agents in one worktree each get their own). Codex passes `session_id` (the
/// thread id) as JSON on stdin; no `jq` needed in the sandbox/image.
const VIBE_RECORDER_SCRIPT: &str = r#"#!/usr/bin/env bash
set -euo pipefail
token="${VST_SPAWN_TOKEN:-}"
[ -z "$token" ] && exit 0
id=$(sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)
[ -z "$id" ] && exit 0
root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$root/.vibe-station/agent-chat-ids"
printf '%s' "$id" > "$root/.vibe-station/agent-chat-ids/$token"
"#;

/// Ensure a gitignore entry is present (best-effort, mirrors `ensureGitignoreEntry`).
pub(crate) async fn ensure_gitignore_entry(gitignore_path: PathBuf, entry: &str) {
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

async fn write_mode_755(path: &PathBuf, content: &str) {
    let _ = fs::write(path, content).await;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).await;
    }
}

/// `-c` values that register the vst hooks for ONE codex invocation:
/// `hooks.UserPromptSubmit` (attachment delivery) and `hooks.SessionStart`
/// (records the codex thread id). Each is `hooks.<Event>=[{hooks=[{type="command",command="<abs script>"}]}]`.
///
/// Passed on the command line (not written to `.codex/hooks.json`) because codex
/// 0.160 resolves the project `.codex/` layer from the MAIN repo root, so a
/// hooks.json inside a vst git-worktree checkout is never loaded. A `-c` override
/// works for worktrees, direct sessions, and resume alike.
///
/// Known limit: a `-c hooks.<Event>=[...]` override REPLACES the array codex would
/// otherwise load for that event, so a user's own `SessionStart` /
/// `UserPromptSubmit` hooks from `~/.codex/config.toml` do not run in
/// vst-launched sessions. Merging would mean parsing the user's TOML here.
fn hook_config_overrides(cwd: &std::path::Path) -> Vec<String> {
    [
        ("SessionStart", "vibe-recorder.sh"),
        ("UserPromptSubmit", "vibe-uploads.sh"),
    ]
    .iter()
    .map(|(event, script)| {
        let path = cwd.join(".codex").join(script);
        let escaped = path
            .to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"");
        format!("hooks.{event}=[{{hooks=[{{type=\"command\",command=\"{escaped}\"}}]}}]")
    })
    .collect()
}

/// `<cwd>/.vibe-station/agent-chat-ids/<sessionId>` — written by the SessionStart hook.
fn chat_id_token_file(cwd: &str, session_id: &str) -> PathBuf {
    PathBuf::from(cwd)
        .join(".vibe-station")
        .join("agent-chat-ids")
        .join(session_id)
}

/// Whether codex still has a rollout (`rollout-<ts>-<id>.jsonl`, the transcript
/// `codex resume <id>` replays) for `id`. A missing rollout makes `codex resume`
/// print an error and exit, killing the session on every Resume click.
///
/// Errs on the side of resuming: only a definite "not there" returns `false`; an
/// unreadable tree counts as present so a flaky filesystem never downgrades a
/// resumable session to a fresh one.
fn rollout_exists(sessions_root: &std::path::Path, id: &str) -> bool {
    !matches!(
        crate::codex_import::find_rollout(sessions_root, id),
        crate::codex_import::RolloutSearch::NotFound
    )
}

/// The id to resume: the stored id, else the one this session's SessionStart hook
/// recorded, whichever still has a rollout. `None` ⇒ launch fresh. Re-checked on
/// every call, so a stale stored id heals itself once the hook records the id of
/// the replacement conversation.
fn resumable_chat_id(known: Option<&str>, recorded: Option<&str>) -> Option<String> {
    let root = crate::codex_import::codex_native_store_path();
    [known, recorded]
        .into_iter()
        .flatten()
        .filter(|id| !id.is_empty())
        .find(|id| rollout_exists(&root, id))
        .map(str::to_string)
}

async fn read_recorded_chat_id(token_file: &std::path::Path) -> Option<String> {
    let raw = fs::read_to_string(token_file).await.ok()?;
    let id = raw.trim();
    (!id.is_empty()).then(|| id.to_string())
}

/// `-c` value that hands codex the vst system prompt as developer instructions.
/// The value is a TOML basic string; JSON string escaping is a valid encoding of it.
fn developer_instructions_override(system_prompt: &str) -> String {
    let encoded = serde_json::to_string(system_prompt).unwrap_or_else(|_| "\"\"".to_string());
    // serde_json leaves DEL (0x7f) raw, which a TOML basic string forbids.
    format!(
        "developer_instructions={}",
        encoded.replace('\u{7f}', "\\u007f")
    )
}

/// Codex agent plugin.
pub struct CodexPlugin;

/// Create a fresh Codex plugin instance.
pub fn create_codex_plugin() -> CodexPlugin {
    CodexPlugin
}

impl AgentPlugin for CodexPlugin {
    fn name(&self) -> &str {
        "codex"
    }

    fn default_channel(&self) -> Channel {
        Channel::Json
    }

    fn default_model(&self) -> &str {
        ""
    }

    fn default_mode_icon(&self, _model: Option<&str>) -> &'static str {
        "codex"
    }

    fn prompt_delivery(&self) -> PromptDelivery {
        PromptDelivery::Inline
    }

    fn setup_workspace_hooks(&self, workspace_path: &str) -> AsyncResult<()> {
        let root = PathBuf::from(workspace_path);
        Box::pin(async move {
            let codex_dir = root.join(".codex");
            let _ = fs::create_dir_all(&codex_dir).await;

            // The scripts only; they are registered per-launch via `-c` (see
            // `hook_config_overrides`), not through a hooks.json file.
            let script = codex_dir.join("vibe-uploads.sh");
            write_mode_755(&script, VIBE_UPLOADS_SCRIPT).await;
            write_mode_755(&codex_dir.join("vibe-recorder.sh"), VIBE_RECORDER_SCRIPT).await;

            let _ = ensure_gitignore_entry(root.join(".gitignore"), ".codex/").await;
            let _ = ensure_gitignore_entry(root.join(".gitignore"), ".vibe-station/").await;
        })
    }

    fn get_launch_command(&self, cfg: &LaunchConfig) -> Vec<String> {
        let mut argv = vec![
            "codex".to_string(),
            // The TUI otherwise attaches to / installs codex's shared background
            // app-server daemon (~/.codex/packages/...) and refuses to start
            // where that install is absent (fresh homes, containers). vst
            // sessions are self-contained, so never depend on it.
            "--no-daemon".to_string(),
            // Inline mode: codex's default alternate screen leaves tmux with no
            // scrollback (copy-mode shows 0/0), so the web terminal can't scroll.
            "--no-alt-screen".to_string(),
            "--dangerously-bypass-approvals-and-sandbox".to_string(),
            // Without hook-trust the vibe-uploads hook silently never runs
            // (codex 0.160). vst already runs codex with sandbox/approvals fully
            // bypassed, and the hook is vst-authored: no new trust surface.
            "--dangerously-bypass-hook-trust".to_string(),
        ];
        for value in hook_config_overrides(&cfg.ctx.cwd) {
            argv.push("-c".to_string());
            argv.push(value);
        }
        // Only resume a conversation that still exists; a stale id would make codex
        // exit at once, on every launch, forever.
        if let Some(id) = resumable_chat_id(cfg.session.agent_chat_id.as_deref(), None) {
            argv.push("resume".to_string());
            argv.push(id);
        }
        if let Some(model) = &cfg.model {
            argv.push("-m".to_string());
            argv.push(model.clone());
        }
        argv
    }

    fn get_environment(&self, _cfg: &LaunchConfig) -> BTreeMap<String, String> {
        BTreeMap::new()
    }

    fn get_ready_signal(&self) -> ReadySignal {
        ReadySignal {
            sentinel: None,
            fallback_ms: 12_000,
        }
    }

    fn compose_launch_prompt(&self, input: ComposePromptInput) -> ComposePromptResult {
        if input.task_prompt.is_none() && input.system_prompt.is_empty() {
            return ComposePromptResult::default();
        }
        let mut shell_line = "codex --no-daemon --no-alt-screen --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust".to_string();
        for value in hook_config_overrides(&input.launch_cfg.ctx.cwd) {
            shell_line.push_str(&format!(" -c {}", sq(&value)));
        }
        // The system prompt goes in as developer instructions, out of band (like
        // claude's --system-prompt), so it never appears as — or merges into — the
        // user's first message in the conversation.
        //
        // Passed as `"$(cat <file>)"`, expanded by `sh` AFTER tmux receives the
        // command: the prompt (base + mode context + the project's AGENTS.md) can
        // exceed tmux's ~16 KB command limit if it were inlined.
        if !input.system_prompt.is_empty() {
            let instructions_file = PathBuf::from(&input.system_prompt_file)
                .parent()
                .map(|p| p.join("developer_instructions.txt"))
                .unwrap_or_else(|| PathBuf::from("developer_instructions.txt"));
            // Skip the flag on a write failure: `-c ""` would be a broken override.
            if std::fs::write(
                &instructions_file,
                developer_instructions_override(&input.system_prompt),
            )
            .is_ok()
            {
                shell_line.push_str(&format!(
                    " -c \"$(cat {})\"",
                    sq(&instructions_file.to_string_lossy())
                ));
            }
        }
        if let Some(id) = resumable_chat_id(input.launch_cfg.session.agent_chat_id.as_deref(), None)
        {
            shell_line.push_str(&format!(" resume {}", sq(&id)));
        }
        if let Some(model) = &input.launch_cfg.model {
            shell_line.push_str(&format!(" -m {}", sq(model)));
        }
        if let Some(task) = &input.task_prompt {
            let task_file = PathBuf::from(&input.system_prompt_file)
                .parent()
                .map(|p| p.join("task_prompt.txt"))
                .unwrap_or_else(|| PathBuf::from("task_prompt.txt"));
            let _ = std::fs::write(&task_file, task);
            shell_line.push_str(&format!(" \"$(cat {})\"", sq(&task_file.to_string_lossy())));
        }
        ComposePromptResult {
            use_shell: true,
            shell_line: Some(shell_line),
            ..Default::default()
        }
    }

    fn list_models(&self) -> AsyncResult<ListModelsResult> {
        Box::pin(async {
            // `codex debug models --bundled` prints the embedded model catalog as
            // JSON (no network call, no auth required): `{"models":[{"slug":…}]}`.
            // Bounded like pi's listing so a hung CLI can't wedge the model catalog.
            let run = tokio::process::Command::new("codex")
                .args(["debug", "models", "--bundled"])
                .stdin(std::process::Stdio::null())
                .kill_on_drop(true)
                .output();
            let result = match tokio::time::timeout(std::time::Duration::from_secs(20), run).await {
                Ok(r) => r,
                Err(_) => {
                    return ListModelsResult {
                        models: vec![],
                        error: Some(
                            "`codex debug models --bundled` timed out after 20s.".to_string(),
                        ),
                    }
                }
            };
            match result {
                Ok(out) if out.status.success() => {
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    let models = parse_codex_debug_models(&stdout);
                    if models.is_empty() {
                        ListModelsResult {
                            models: vec![],
                            error: Some(
                                "`codex debug models --bundled` returned no parseable models. \
                                 Check that codex is installed and up to date."
                                    .to_string(),
                            ),
                        }
                    } else {
                        ListModelsResult {
                            models,
                            error: None,
                        }
                    }
                }
                Ok(out) => {
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    ListModelsResult {
                        models: vec![],
                        error: Some(format!(
                            "`codex debug models --bundled` failed ({}). \
                             Check that codex is installed.",
                            stderr.trim()
                        )),
                    }
                }
                Err(e) => ListModelsResult {
                    models: vec![],
                    error: Some(format!(
                        "Couldn't run `codex debug models --bundled`: {e}. \
                         Check that codex is installed."
                    )),
                },
            }
        })
    }

    /// Reads the thread id the `SessionStart` hook recorded for THIS session, then
    /// deletes the file.
    fn capture_chat_id(&self, args: CaptureArgs<'_>) -> AsyncResult<Option<String>> {
        let token_file = chat_id_token_file(args.cwd, &args.session.id);
        Box::pin(async move {
            let id = read_recorded_chat_id(&token_file).await;
            let _ = fs::remove_file(&token_file).await;
            id
        })
    }

    /// Resumes this session's own thread: the stored chat id, else the one the
    /// `SessionStart` hook recorded (not yet persisted, e.g. a prompt-less spawn).
    /// Neither means a fresh launch.
    fn get_restore_command(&self, args: RestoreArgs<'_>) -> AsyncResult<Option<Vec<String>>> {
        let known = args.session.agent_chat_id.clone();
        let token_file = chat_id_token_file(args.cwd, &args.session.id);
        let cwd = args.cwd.to_string();
        let model = args.model.map(|m| m.to_string());
        Box::pin(async move {
            let recorded = read_recorded_chat_id(&token_file).await;
            // Whichever of the stored / hook-recorded ids still has a rollout (see
            // `resumable_chat_id`); neither ⇒ a fresh launch.
            let id = tokio::task::spawn_blocking(move || {
                resumable_chat_id(known.as_deref(), recorded.as_deref())
            })
            .await
            .ok()
            .flatten()?;
            let mut argv = vec![
                "codex".to_string(),
                "--no-daemon".to_string(),
                "--no-alt-screen".to_string(),
                "resume".to_string(),
                id,
                "--dangerously-bypass-approvals-and-sandbox".to_string(),
                "--dangerously-bypass-hook-trust".to_string(),
            ];
            for value in hook_config_overrides(std::path::Path::new(&cwd)) {
                argv.push("-c".to_string());
                argv.push(value);
            }
            if let Some(model) = model {
                argv.push("-m".to_string());
                argv.push(model);
            }
            Some(argv)
        })
    }

    /// tty→json toggle: replace a stored id whose rollout is gone with the one this
    /// session's SessionStart hook recorded (the conversation that replaced it).
    /// `None` keeps the stored id: it is live, or nothing better was recorded.
    fn refresh_chat_id_on_toggle(&self, args: CaptureArgs<'_>) -> AsyncResult<Option<String>> {
        let known = args
            .session
            .agent_chat_id
            .clone()
            .filter(|id| !id.is_empty());
        let token_file = chat_id_token_file(args.cwd, &args.session.id);
        Box::pin(async move {
            let recorded = read_recorded_chat_id(&token_file).await?;
            let root = crate::codex_import::codex_native_store_path();
            tokio::task::spawn_blocking(move || {
                let stale = known.as_deref().is_some_and(|k| !rollout_exists(&root, k));
                (stale
                    && known.as_deref() != Some(recorded.as_str())
                    && rollout_exists(&root, &recorded))
                .then_some(recorded)
            })
            .await
            .ok()
            .flatten()
        })
    }

    fn supports_json(&self) -> bool {
        true
    }

    fn supports_acp(&self) -> bool {
        true
    }

    fn capture_native_chat_id(
        &self,
        args: CaptureNativeChatIdArgs<'_>,
    ) -> AsyncResult<Option<String>> {
        let known = args.session.agent_chat_id.clone();
        let acp = args.acp_session_id.to_string();
        Box::pin(async move {
            if let Some(id) = known.filter(|id| !id.is_empty()) {
                Some(id)
            } else {
                Some(acp)
            }
        })
    }

    fn acp_initial_config_option(&self, model: &str) -> Option<(String, String)> {
        // codex-acp ignores `_meta` at `session/new` (inspected only for additional
        // directories) — the only way to select a model is this explicit follow-up
        // `configId: "model"` call. Without it,
        // every codex Rich Chat session silently runs on whatever default model
        // codex uses, ignoring the mode's configured model.
        Some(("model".to_string(), model.to_string()))
    }

    fn acp_session_config_options(&self) -> Vec<(String, String)> {
        // codex-acp defaults to its "Approve for me" mode (workspace-write
        // sandbox via bubblewrap). bwrap can't create user namespaces in
        // containers/restricted hosts, so EVERY shell command fails. The
        // terminal channel already runs with
        // `--dangerously-bypass-approvals-and-sandbox`; "Full access" is the
        // ACP equivalent, and vst agents run unattended with no approval UI.
        vec![("mode".to_string(), "agent-full-access".to_string())]
    }

    fn run_turn(
        &self,
        input: TurnInput,
        ctx: TurnContext,
        cancel: CancellationToken,
    ) -> mpsc::UnboundedReceiver<NormalizedEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        let params = RunTurnAcpParams {
            provider: NormalizedEventProvider::Codex,
            build_spec: Box::new(|ctx| {
                let (command, args) = match codex_acp_bin() {
                    Some(bin) => (bin.to_string_lossy().to_string(), Vec::new()),
                    None => (codex_acp_bun_command(), vec![codex_acp_entry_path()]),
                };
                AcpLaunchSpec {
                    command,
                    args,
                    cwd: ctx.cwd.clone(),
                    env: acp_env(ctx),
                    initialize_timeout_ms: None,
                    prompt_timeout_ms: None,
                    reap_detached_descendants: false,
                }
            }),
            enrich: None,
            first_turn_session_init: None,
            // The system prompt is not part of the prompt text: it reaches codex as
            // developer instructions via `CODEX_CONFIG` (see `acp_env`).
            build_prompt_blocks: Box::new(|_ctx, input, _system| {
                vec![ContentBlock::Text(TextContent::new(input.message.clone()))]
            }),
            emit_refusal_error: false,
            stuck_turn_idle_ms: None,
            stuck_turn_cancel_grace_ms: None,
        };
        tokio::spawn(run_turn_acp(tx, input, ctx, cancel, params));
        rx
    }
}

/// Env for the codex-acp adapter: where the real `codex` is, plus the vst system
/// prompt as `developer_instructions` through the adapter's `CODEX_CONFIG` (a JSON
/// object of codex config overrides). Read once when the connection is created.
fn acp_env(ctx: &TurnContext) -> HashMap<String, String> {
    let mut env = HashMap::from([("CODEX_PATH".to_string(), "codex".to_string())]);
    if let Some(sys) = std::fs::read_to_string(&ctx.system_prompt_file)
        .ok()
        .filter(|s| !s.is_empty())
    {
        env.insert(
            "CODEX_CONFIG".to_string(),
            serde_json::json!({ "developer_instructions": sys }).to_string(),
        );
    }
    env
}

/// Name of the compiled codex ACP adapter binary shipped in the CLI tarball
/// and as a Tauri sidecar.
pub const CODEX_ACP_BIN_NAME: &str = "codex-acp";

/// Env var for an explicit compiled-adapter path override.
pub const CODEX_ACP_BIN_ENV: &str = "VST_CODEX_ACP_BIN";

/// Resolve the compiled `codex-acp` adapter (`bun build --compile` of the
/// pinned `@agentclientprotocol/codex-acp`, built by
/// `scripts/build-codex-acp.sh`). Order: `VST_CODEX_ACP_BIN` env → `codex-acp`
/// beside `current_exe()` (curl-install and Tauri sidecar layouts). `None` when
/// neither resolves, or when `VST_CODEX_ACP_ENTRY` is set — that explicit
/// `bun <entry.js>` override (dev sandbox) wins.
pub fn codex_acp_bin() -> Option<std::path::PathBuf> {
    if std::env::var("VST_CODEX_ACP_ENTRY").is_ok_and(|v| !v.is_empty()) {
        return None;
    }
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(std::path::PathBuf::from));
    resolve_codex_acp_bin(
        std::env::var(CODEX_ACP_BIN_ENV).ok().as_deref(),
        exe_dir.as_deref(),
    )
}

fn resolve_codex_acp_bin(
    env_value: Option<&str>,
    exe_dir: Option<&std::path::Path>,
) -> Option<std::path::PathBuf> {
    if let Some(p) = env_value.map(str::trim).filter(|p| !p.is_empty()) {
        let pb = std::path::PathBuf::from(p);
        // A dangling override must not be reported as available.
        if pb.is_file() {
            return Some(pb);
        }
    }
    let beside = exe_dir?.join(CODEX_ACP_BIN_NAME);
    beside.is_file().then_some(beside)
}

/// The `bun` binary that runs the codex ACP adapter. `bun` (not `node`) is
/// used deliberately: it's already a required, doctor-checked dependency for
/// agy's and claude's ACP paths, and — unlike `node` — can run the adapter's real
/// `dist/index.js` directly with no separate install/compile step of its
/// own.
fn codex_acp_bun_command() -> String {
    std::env::var("VST_CODEX_ACP_BUN").unwrap_or_else(|_| "bun".to_string())
}

/// Relative suffix shared by both the beside-exe and walk-upward candidates.
const VENDOR_ENTRY_SUFFIX: &[&str] = &[
    "node_modules",
    "@agentclientprotocol",
    "codex-acp",
    "dist",
    "index.js",
];

/// The codex-acp adapter's real entrypoint (`dist/index.js`), from a
/// vendored install pinned in `vendor/codex-acp/package.json` and produced
/// by `scripts/install-codex-acp-vendor.sh` (`bun install --omit=optional`).
///
/// Resolution order — a bare `cargo run` from inside the repo needs zero env
/// vars (case 3); the dev sandbox, `tauri dev` and the packaged desktop app
/// all set `VST_CODEX_ACP_ENTRY` explicitly (case 1):
/// 1. `VST_CODEX_ACP_ENTRY` env var, if set — explicit override, always wins.
/// 2. `<dir of the running exe>/codex-acp-vendor/node_modules/@agentclientprotocol/codex-acp/dist/index.js`
///    — beside-exe layout (packaged builds).
/// 3. Walk UPWARD from cwd (bounded to 8 levels) looking for `vendor/codex-acp/...` (dev/Docker).
/// 4. Fallback to bare npm specifier with an `eprintln!` diagnostic.
pub fn codex_acp_entry_path() -> String {
    if let Ok(p) = std::env::var("VST_CODEX_ACP_ENTRY") {
        if !p.is_empty() {
            return p;
        }
    }
    static RESOLVED: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    RESOLVED.get_or_init(resolve_codex_acp_entry_path).clone()
}

fn resolve_codex_acp_entry_path() -> String {
    // Candidate 2: beside the running exe, under `codex-acp-vendor/` (packaged builds).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let mut candidate = dir.join("codex-acp-vendor");
            candidate.extend(VENDOR_ENTRY_SUFFIX);
            if candidate.is_file() {
                return candidate.to_string_lossy().to_string();
            }
        }
    }
    // Candidate 3: walk upward from cwd looking for `vendor/codex-acp/...` (dev/Docker).
    if let Ok(cwd) = std::env::current_dir() {
        for ancestor in cwd.ancestors().take(8) {
            let mut candidate = ancestor.join("vendor").join("codex-acp");
            candidate.extend(VENDOR_ENTRY_SUFFIX);
            if candidate.is_file() {
                return candidate.to_string_lossy().to_string();
            }
        }
    }
    // Candidate 4: no install found anywhere. Diagnose loudly.
    eprintln!(
        "[codex-acp] no vendored install found (checked VST_CODEX_ACP_ENTRY, beside-exe, and \
         vendor/codex-acp/ walking up from cwd) — falling back to a bare npm specifier, which \
         will fail to spawn. Run ./scripts/install-codex-acp-vendor.sh, or set VST_CODEX_ACP_ENTRY."
    );
    CODEX_ACP_ADAPTER_SPECIFIER.to_string()
}

const CODEX_ACP_ADAPTER_SPECIFIER: &str = "@agentclientprotocol/codex-acp/dist/index.js";

/// Extract model ids from the JSON output of `codex debug models [--bundled]`.
///
/// Real output is compact JSON shaped `{"models":[{"slug":"gpt-…",…}]}`. A bare
/// array of objects, and an `id` key in place of `slug`, are accepted too.
/// Returns an empty vec if nothing is parseable; the caller surfaces an error then.
fn parse_codex_debug_models(json: &str) -> Vec<String> {
    let Ok(root) = serde_json::from_str::<serde_json::Value>(json.trim()) else {
        return Vec::new();
    };
    let entries = match &root {
        serde_json::Value::Array(a) => a.as_slice(),
        other => other
            .get("models")
            .and_then(|m| m.as_array())
            .map(|a| a.as_slice())
            .unwrap_or(&[]),
    };
    let mut models: Vec<String> = Vec::new();
    for obj in entries {
        let id = obj
            .get("slug")
            .or_else(|| obj.get("id"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !id.is_empty() && !models.iter().any(|m| m == id) {
            models.push(id.to_string());
        }
    }
    models
}

#[cfg(test)]
mod codex_models_tests {
    use super::parse_codex_debug_models;

    #[test]
    fn parses_models_object_with_slug() {
        let j =
            r#"{"models":[{"slug":"gpt-6-astra","display_name":"GPT-6-Astra"},{"slug":"gpt-5"}]}"#;
        assert_eq!(parse_codex_debug_models(j), vec!["gpt-6-astra", "gpt-5"]);
    }

    #[test]
    fn parses_bare_array_with_id_and_dedupes() {
        let j = r#"[{"id":"a"},{"id":"a"},{"id":"b"}]"#;
        assert_eq!(parse_codex_debug_models(j), vec!["a", "b"]);
    }

    #[test]
    fn garbage_yields_empty() {
        assert!(parse_codex_debug_models("not json").is_empty());
        assert!(parse_codex_debug_models("{}").is_empty());
    }
}

#[cfg(test)]
mod acp_bin_tests {
    const ID: &str = "01a0ffb0-70ee-7ac0-86ea-d98c15c32eaf";
    const OTHER: &str = "01a0ff4a-8b99-70d2-a7bb-272b461b37c1";

    fn rollout(dir: &std::path::Path, id: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join(format!("rollout-2026-10-03T02-55-48-{id}.jsonl")),
            b"",
        )
        .unwrap();
    }

    #[test]
    fn rollout_exists_matches_whole_id_in_sessions_and_archived() {
        use super::rollout_exists;
        let home = tempfile::tempdir().unwrap();
        let sessions = home.path().join("sessions");
        rollout(&sessions.join("2026/10/03"), ID);
        assert!(rollout_exists(&sessions, ID));
        assert!(!rollout_exists(&sessions, OTHER));
        // a sibling `archived_sessions` still counts
        rollout(&home.path().join("archived_sessions"), OTHER);
        assert!(rollout_exists(&sessions, OTHER));
        // no sessions dir at all: definitely missing
        let empty = tempfile::tempdir().unwrap();
        assert!(!rollout_exists(&empty.path().join("sessions"), ID));
    }

    #[cfg(unix)]
    #[test]
    fn rollout_search_terminates_on_a_symlink_cycle_and_counts_it_as_unsure() {
        use super::rollout_exists;
        let home = tempfile::tempdir().unwrap();
        let sessions = home.path().join("sessions");
        std::fs::create_dir_all(sessions.join("2026")).unwrap();
        std::os::unix::fs::symlink(&sessions, sessions.join("2026/loop")).unwrap();
        // Terminates; a symlink may hide the rollout, so absence is not proven.
        assert!(rollout_exists(&sessions, ID));
    }

    #[test]
    fn resumable_chat_id_prefers_a_live_stored_id_then_the_recorded_one() {
        let _g = vst_agents_home(|home| {
            rollout(&home.join(".codex/sessions/2026/10/03"), OTHER);
        });
        use super::resumable_chat_id;
        // stored id is stale, hook-recorded id is live -> heals onto the recorded one
        assert_eq!(
            resumable_chat_id(Some(ID), Some(OTHER)).as_deref(),
            Some(OTHER)
        );
        // stored id live -> kept even if a different one was recorded
        assert_eq!(
            resumable_chat_id(Some(OTHER), Some(ID)).as_deref(),
            Some(OTHER)
        );
        // neither live -> fresh launch
        assert_eq!(resumable_chat_id(Some(ID), None), None);
        assert_eq!(resumable_chat_id(None, None), None);
    }

    #[cfg(unix)]
    #[test]
    fn rollout_search_follows_a_symlinked_root_but_flags_a_symlinked_subdir() {
        use super::rollout_exists;
        let base = tempfile::tempdir().unwrap();
        // sandbox layout: ~/.codex/sessions -> persistent store
        let store = base.path().join("store");
        rollout(&store.join("2026/10/03"), ID);
        let link = base.path().join("sessions");
        std::os::unix::fs::symlink(&store, &link).unwrap();
        assert!(rollout_exists(&link, ID));
        assert!(!rollout_exists(&link, OTHER));
        // a symlinked date dir hides content: absence is unproven -> "exists"
        let other = base.path().join("elsewhere");
        rollout(&other, OTHER);
        std::os::unix::fs::symlink(&other, store.join("2026/10/04")).unwrap();
        assert!(rollout_exists(&link, OTHER));
    }

    #[test]
    fn non_ascii_filenames_do_not_panic_the_thread_id_parser() {
        assert_eq!(
            crate::native_chat_id::extract_codex_thread_id(
                "rollout-ééééééééééééééééééééééééééééééééééééé.jsonl"
            ),
            None
        );
    }

    #[test]
    fn developer_instructions_escapes_del_for_toml() {
        let v = super::developer_instructions_override("a\u{7f}b\n\"q\"");
        assert!(!v.contains('\u{7f}'));
        assert!(v.starts_with("developer_instructions=\""));
        assert!(v.contains("\\u007f"));
    }

    /// Point the crate's home dir at a fresh temp dir seeded by `seed`.
    fn vst_agents_home(
        seed: impl FnOnce(&std::path::Path),
    ) -> (tempfile::TempDir, crate::home::HomeGuard) {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path());
        let guard = crate::home::with_home(dir.path().to_path_buf());
        (dir, guard)
    }

    #[test]
    fn codex_acp_bin_prefers_env_then_beside_exe() {
        use super::resolve_codex_acp_bin;
        let dir = tempfile::tempdir().unwrap();
        let beside = dir.path().join("codex-acp");
        let other = dir.path().join("override-bin");
        assert_eq!(resolve_codex_acp_bin(None, Some(dir.path())), None);
        assert_eq!(
            resolve_codex_acp_bin(other.to_str(), Some(dir.path())),
            None
        );
        std::fs::write(&beside, b"").unwrap();
        assert_eq!(
            resolve_codex_acp_bin(None, Some(dir.path())),
            Some(beside.clone())
        );
        assert_eq!(resolve_codex_acp_bin(Some("  "), None), None);
        std::fs::write(&other, b"").unwrap();
        assert_eq!(
            resolve_codex_acp_bin(other.to_str(), Some(dir.path())),
            Some(other)
        );
    }
}
