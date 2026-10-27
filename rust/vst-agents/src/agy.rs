//! Antigravity CLI plugin (`agy`).
//!
//! Terminal launch: `agy --dangerously-skip-permissions --log-file <path>`; task
//! prompt delivered inline via `-i`. The chat id is captured by tailing a
//! PER-SESSION `--log-file` for "Created/Streaming conversation <id>" lines
//! (restore commands also pass `--log-file`, so a tty->json toggle always reads
//! a fresh log).
//!
//! Rich Chat (json channel) is driven over ACP by spawning
//! `<current_exe> agy-stream-acp` (the hidden subcommand of `vst` /
//! `vst-daemon`, crate `vst-agy-stream-acp`), which runs one long-lived
//! `agy --input-format stream-json` process per session. The ACP `sessionId`
//! IS agy's conversation id, so the two-session-identity strategy is
//! `identical` (omp-shaped): this plugin implements `acp_session_id_is_native`
//! and neither `capture_native_chat_id` nor `supports_channel_resume`. If the
//! binary is replaced on disk between `current_exe()` and the spawn, the spawn
//! fails with a plain error.
//!
//! No history importer: agy's conversation store is not parsed yet, so
//! `native_history_importer` stays `None` (the UI warns via
//! `importsNativeHistory:false`). Reference parser for a future importer:
//! orca's `ai-vault/antigravity-*`.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use agent_client_protocol::schema::v1::{ContentBlock, TextContent};
use tokio::fs;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use vst_types::{Channel, NormalizedEvent, NormalizedEventKind, NormalizedEventProvider};

use crate::acp_connection::AcpLaunchSpec;
use crate::acp_run_turn::{run_turn_acp, RunTurnAcpParams};
use crate::home::home_dir;
use crate::native_chat_id::read_latest_agy_conversation_id;
use crate::plugin::{
    base_event, AgentPlugin, AsyncResult, CaptureArgs, ComposePromptInput, ComposePromptResult,
    LaunchConfig, ListModelsResult, PromptDelivery, ReadySignal, RestoreArgs, TurnContext,
    TurnInput,
};

/// Fallback default model, used before a live `list_models()` fetch has ever
/// run (e.g. to pick an initial `--model` for a brand-new session, or agy's
/// own entry in a generic starter-mode bundle — `AgentPlugin::starter_bundle`'s
/// default impl). Not a model *list* — see `list_models()` below for the
/// live, non-stale source of truth. A flash-tier model at Medium effort
/// (not the heaviest Pro/High tier) is the right default here specifically
/// because this is what a brand-new mode silently runs on before anyone has
/// looked at the model picker — fast and cheap beats maximal capability for
/// an unreviewed default. "3.8" is the newest flash generation as of
/// writing (verified live via `agy models`); isn't re-validated at runtime —
/// if agy ever retires it, the daemon just passes a `--model` agy no longer
/// recognizes on first spawn, which agy itself will report as its own CLI
/// error.
pub const AGY_DEFAULT_MODEL: &str = "Gemini 3.8 Flash (Medium)";

/// Parse `agy models`' stdout into the flat list of selectable model
/// strings `list_models()` returns.
///
/// Output shape (real example, verified against an authenticated `agy`):
/// ```text
/// Fetching available models...
/// gemini-3.1-pro-high	Gemini 3.1 Pro (High)
/// gemini-3.1-pro-low	Gemini 3.1 Pro (Low)
/// claude-sonnet-4-6	Claude Sonnet 4.6 (Thinking)
/// ```
/// One model per line, `<id>\t<display-name>`. The leading "Fetching..."
/// status line has no tab and is naturally dropped by requiring a
/// `split_once('\t')` to succeed — no special-casing it as a "header".
///
/// Returns the **display-name** column, not the id — `agy` accepts the
/// display name directly as `--model "<name>"` (verified), and every
/// existing caller (the stale `AGY_MODELS` const this replaces, the
/// mode-picker UI, `session/setConfigOption`) already expects that format.
/// Each line — including every Low/Medium/High reasoning-effort variant —
/// becomes its own flat entry; this deliberately does NOT group/expand
/// variants, matching how every other plugin already bakes its own variant
/// concept into flat strings (e.g. claude's `"sonnet[1m]"` vs `"sonnet"`).
pub fn parse_agy_models_output(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .filter_map(|line| line.split_once('\t'))
        .map(|(_id, display_name)| display_name.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Default poll constants for chat-id capture.
pub const CHAT_ID_POLL_TIMEOUT_MS: u64 = 30_000;
pub const CHAT_ID_POLL_INTERVAL_MS: u64 = 500;

/// `~/.vibe-station/agy-logs/<sessionId>.log`
pub fn agy_log_path(session_id: &str) -> PathBuf {
    home_dir()
        .join(".vibe-station")
        .join("agy-logs")
        .join(format!("{session_id}.log"))
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36 && s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

/// Last match of `<marker><36-char-uuid>` in `content` (prefer the last
/// "Streaming" line; fall back to the last "Created" line).
fn last_conversation_id(content: &str, marker: &str) -> Option<String> {
    let mut last: Option<String> = None;
    let mut idx = 0;
    while let Some(pos) = content[idx..].find(marker) {
        let start = idx + pos + marker.len();
        if start + 36 <= content.len() {
            let candidate = &content[start..start + 36];
            if is_uuid(candidate) {
                last = Some(candidate.to_string());
            }
        }
        idx = start + 1;
    }
    last
}

/// Read the LAST conversation id from an agy `--log-file` (`parseLastConversationIdFromLog`).
pub async fn parse_last_conversation_id_from_log(log_path: &Path) -> Option<String> {
    let content = fs::read_to_string(log_path).await.ok()?;
    last_conversation_id(&content, "Streaming conversation ")
        .or_else(|| last_conversation_id(&content, "Created conversation "))
}

/// Poll the session's `--log-file` until a conversation id appears, or the
/// timeout elapses (→ `None`) — `pollLogForConversationId`.
pub async fn poll_log_for_conversation_id(
    log_path: &Path,
    timeout_ms: Option<u64>,
    interval_ms: Option<u64>,
) -> Option<String> {
    let timeout_ms = timeout_ms.unwrap_or(CHAT_ID_POLL_TIMEOUT_MS);
    let interval_ms = interval_ms.unwrap_or(CHAT_ID_POLL_INTERVAL_MS);
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    loop {
        if let Some(id) = parse_last_conversation_id_from_log(log_path).await {
            return Some(id);
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(std::time::Duration::from_millis(interval_ms)).await;
    }
}

// No `native_history_importer` (default `None`): agy's conversation store is
// not parsed yet; see the module header.
/// Agy plugin (stateless singleton).
pub struct AgyPlugin;

/// Create a fresh agy plugin instance (`createAgyPlugin`).
pub fn create_agy_plugin() -> AgyPlugin {
    AgyPlugin
}

impl AgentPlugin for AgyPlugin {
    fn name(&self) -> &str {
        "agy"
    }

    fn default_model(&self) -> &str {
        AGY_DEFAULT_MODEL
    }

    fn default_mode_icon(&self, _model: Option<&str>) -> &'static str {
        "agy"
    }

    fn prompt_delivery(&self) -> PromptDelivery {
        PromptDelivery::Inline
    }

    fn get_launch_command(&self, cfg: &LaunchConfig) -> Vec<String> {
        let mut argv = vec![
            "agy".to_string(),
            "--dangerously-skip-permissions".to_string(),
        ];
        if let Some(model) = &cfg.model {
            argv.push("--model".to_string());
            argv.push(model.clone());
        }
        if let Some(id) = &cfg.session.agent_chat_id {
            argv.push("--conversation".to_string());
            argv.push(id.clone());
        }
        let log_path = agy_log_path(&cfg.session.id);
        if let Some(parent) = log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        argv.push("--log-file".to_string());
        argv.push(log_path.to_string_lossy().into_owned());
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
        if let Some(task) = &input.task_prompt {
            let combined = match &input.system_prompt {
                s if !s.is_empty() => format!("{s}\n\n{task}"),
                _ => task.clone(),
            };
            let combined_file = PathBuf::from(&input.system_prompt_file)
                .parent()
                .map(|p| p.join("combined_prompt.txt"))
                .unwrap_or_else(|| PathBuf::from("combined_prompt.txt"));
            let _ = std::fs::write(&combined_file, combined);
            let mut shell_line = "agy --dangerously-skip-permissions".to_string();
            if let Some(model) = &input.launch_cfg.model {
                shell_line.push_str(&format!(" --model {}", sq(model)));
            }
            if let Some(id) = &input.launch_cfg.session.agent_chat_id {
                shell_line.push_str(&format!(" --conversation {}", sq(id)));
            }
            let log_path = agy_log_path(&input.session_id);
            if let Some(parent) = log_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            shell_line.push_str(&format!(" --log-file {}", sq(&log_path.to_string_lossy())));
            shell_line.push_str(&format!(
                " -i \"$(cat {})\"",
                sq(&combined_file.to_string_lossy())
            ));
            return ComposePromptResult {
                use_shell: true,
                shell_line: Some(shell_line),
                ..Default::default()
            };
        }
        ComposePromptResult::default()
    }

    fn default_channel(&self) -> Channel {
        Channel::Tmux
    }

    fn capture_chat_id(&self, args: CaptureArgs<'_>) -> AsyncResult<Option<String>> {
        let path = agy_log_path(&args.session.id);
        Box::pin(async move { poll_log_for_conversation_id(&path, None, None).await })
    }

    fn refresh_chat_id_on_toggle(&self, args: CaptureArgs<'_>) -> AsyncResult<Option<String>> {
        let path = agy_log_path(&args.session.id);
        Box::pin(async move { parse_last_conversation_id_from_log(&path).await })
    }

    fn list_models(&self) -> AsyncResult<ListModelsResult> {
        // Mirrors opencode.rs's list_models(): shell out to the CLI's own
        // "list models" command instead of a hardcoded, inevitably-stale
        // const (that's exactly what this replaced — `AGY_MODELS` still
        // listed "Gemini 3.5 Flash", which current `agy models` no longer
        // returns at all).
        Box::pin(async move {
            match tokio::time::timeout(
                std::time::Duration::from_secs(15),
                // `resolve_agy_binary()`, not a bare "agy" — every other agy
                // spawn path (get_launch_command, get_restore_command,
                // compose_launch_prompt) honors AGY_BIN, a documented
                // dev-sandbox override (docker-compose.dev.yml); a bare PATH
                // lookup here would fail with a misleading "check that the
                // CLI is installed" error whenever AGY_BIN points somewhere
                // not on PATH.
                tokio::process::Command::new(resolve_agy_binary())
                    .arg("models")
                    .output(),
            )
            .await
            {
                Ok(Ok(output)) if output.status.success() => {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let models = parse_agy_models_output(&stdout);
                    ListModelsResult {
                        models,
                        error: None,
                    }
                }
                Ok(Ok(output)) => {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    eprintln!(
                        "[cli-models] agy fetch failed: status={} stderr={}",
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
                    eprintln!("[cli-models] agy fetch failed to spawn: {err}");
                    ListModelsResult {
                        models: vec![],
                        error: Some(
                            "Failed to fetch models from CLI. Check that the CLI is installed and authenticated."
                                .to_string(),
                        ),
                    }
                }
                Err(_timeout) => {
                    eprintln!("[cli-models] agy fetch timed out after 15s");
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

    fn supports_json(&self) -> bool {
        true
    }

    /// agy's ACP `sessionId` is its conversation id (the `identical` strategy),
    /// so a stale stored `acp_session_id` may be dropped after a tty->json
    /// toggle refreshes `agent_chat_id`.
    fn acp_session_id_is_native(&self) -> bool {
        true
    }

    fn supports_acp(&self) -> bool {
        true
    }

    fn get_limits(&self) -> AsyncResult<vst_types::LimitsResult> {
        Box::pin(crate::agy_limits::probe_agy_limits())
    }

    fn get_restore_command(&self, args: RestoreArgs<'_>) -> AsyncResult<Option<Vec<String>>> {
        let known = args.session.agent_chat_id.clone();
        let cwd = args.cwd.to_string();
        let model = args.model.map(|m| m.to_string());
        let log_path = agy_log_path(&args.session.id);
        Box::pin(async move {
            let id = match known {
                Some(id) if !id.is_empty() => id,
                _ => match read_latest_agy_conversation_id(&cwd).await {
                    Some(id) => id,
                    None => return None,
                },
            };
            let mut argv = vec![
                "agy".to_string(),
                "--conversation".to_string(),
                id,
                "--dangerously-skip-permissions".to_string(),
            ];
            if let Some(model) = model {
                argv.push("--model".to_string());
                argv.push(model);
            }
            if let Some(parent) = log_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            argv.push("--log-file".to_string());
            argv.push(log_path.to_string_lossy().into_owned());
            Some(argv)
        })
    }

    fn run_turn(
        &self,
        input: TurnInput,
        ctx: TurnContext,
        cancel: CancellationToken,
    ) -> mpsc::UnboundedReceiver<NormalizedEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        let params = RunTurnAcpParams {
            provider: NormalizedEventProvider::Agy,
            build_spec: Box::new(|ctx| agy_stream_launch_spec(&ctx.cwd, ctx.model.as_deref())),
            enrich: None,
            // `identical`: the ACP session id is agy's conversation id.
            first_turn_session_init: Some(Arc::new(|ctx, acp_id| {
                let mut ev = base_event(
                    &ctx.session.id,
                    NormalizedEventProvider::Agy,
                    NormalizedEventKind::SessionInit,
                );
                ev.agent_chat_id = Some(acp_id.to_string());
                ev
            })),
            // agy prepends the system prompt to the message on the first turn.
            build_prompt_blocks: Box::new(|_ctx, input, system| {
                let message = match system {
                    Some(sys) if !sys.is_empty() && input.is_first_turn => {
                        format!("{sys}\n\n{}", input.message)
                    }
                    _ => input.message.clone(),
                };
                vec![ContentBlock::Text(TextContent::new(message))]
            }),
            emit_refusal_error: false,
            stuck_turn_idle_ms: None,
            stuck_turn_cancel_grace_ms: None,
        };
        tokio::spawn(run_turn_acp(tx, input, ctx, cancel, params));
        rx
    }
}

/// Resolve the user's own `agy` binary (`AGY_BIN`, default `agy`). Used by
/// `list_models`; the `agy-stream-acp` agent reads the same env var by
/// inheritance.
pub(crate) fn resolve_agy_binary() -> String {
    std::env::var("AGY_BIN").unwrap_or_else(|_| "agy".to_string())
}

/// Launch spec for the Rich Chat agent: `<current_exe> agy-stream-acp
/// [--model <m>]`. The model rides `--model` at process start (a model change
/// rebuilds the connection), so there is no `acp_initial_config_option`.
pub(crate) fn agy_stream_launch_spec(cwd: &Path, model: Option<&str>) -> AcpLaunchSpec {
    let command = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "vst".to_string());
    let mut args = vec!["agy-stream-acp".to_string()];
    if let Some(m) = model.filter(|m| !m.is_empty()) {
        args.push("--model".to_string());
        args.push(m.to_string());
    }
    AcpLaunchSpec {
        command,
        args,
        cwd: cwd.to_path_buf(),
        env: HashMap::new(),
        // Never let connect/initialize hang indefinitely.
        initialize_timeout_ms: Some(20_000),
        prompt_timeout_ms: None,
        reap_detached_descendants: false,
        open_tool_idle_timeout_ms: Some(12 * 60 * 60 * 1000),
    }
}

/// Shell-quote a string (escapes embedded `'`) — see [`vst_proc::sq`]. A
/// local unescaped `'{s}'` here once broke any task prompt containing an
/// apostrophe (`sh -lc` syntax error → pane dies instantly → `exited`).
use vst_proc::sq;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_channel_is_tmux() {
        assert_eq!(AgyPlugin.default_channel(), Channel::Tmux);
    }

    #[test]
    fn launch_spec_args_and_env() {
        let spec = agy_stream_launch_spec(Path::new("/w"), Some("M"));
        assert_eq!(spec.args, vec!["agy-stream-acp", "--model", "M"]);
        assert!(spec.env.is_empty());
        assert_eq!(spec.cwd, PathBuf::from("/w"));
        assert_eq!(spec.initialize_timeout_ms, Some(20_000));
        assert_eq!(spec.prompt_timeout_ms, None);
        assert_eq!(spec.open_tool_idle_timeout_ms, Some(12 * 60 * 60 * 1000));
    }

    #[test]
    fn launch_spec_omits_model_when_none_or_empty() {
        for m in [None, Some("")] {
            let spec = agy_stream_launch_spec(Path::new("/w"), m);
            assert_eq!(spec.args, vec!["agy-stream-acp"]);
        }
    }
}
