//! Antigravity CLI plugin (`agy`) — ports `agent-plugins/agy.ts`.
//!
//! TTY launch: `agy --dangerously-skip-permissions --log-file <path>`; task
//! prompt delivered inline via `-i`. Chat id captured by tailing a PER-SESSION
//! `--log-file` for "Created/Streaming conversation <id>" lines. `bridged`
//! two-session-identity strategy: implements `capture_native_chat_id`, not
//! `supports_json_to_terminal_resume` (≡ `true`).
//!
//! Rich Chat (json channel) is driven over ACP by spawning the openab `agy-acp`
//! adapter binary (vendored submodule, `vst-agy-acp` resolves its path) which
//! itself spawns `agy -p`. The adapter's session store lives under
//! `~/.vibe-station/agy-acp/` (handed to it via `AGY_ACP_STATE_DIR`); the
//! native-chat-id bridge reads the same store.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use agent_client_protocol::schema::v1::{ContentBlock, TextContent};
use serde_json::Value;
use tokio::fs;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use vst_types::{
    NormalizedEvent, NormalizedEventKind, NormalizedEventProvider, Role, ToolResult, UsageInfo,
};

use crate::acp_connection::AcpLaunchSpec;
use crate::acp_run_turn::{run_turn_acp, RunTurnAcpParams};
use crate::home::home_dir;
use crate::native_chat_id::{
    read_agy_acp_session_conversation_id, read_latest_agy_conversation_id,
};
use crate::plugin::{
    base_event, AgentPlugin, AsyncResult, CaptureArgs, CaptureNativeChatIdArgs, ComposePromptInput,
    ComposePromptResult, LaunchConfig, ListModelsResult, PromptDelivery, ReadySignal, RestoreArgs,
    TurnContext, TurnInput,
};

fn num(v: &Value) -> i64 {
    v.as_i64().unwrap_or(0)
}

/// Fallback default model, used before a live `list_models()` fetch has ever
/// run (e.g. to pick an initial `--model` for a brand-new session). Not a
/// model *list* — see `list_models()` below for the live, non-stale source
/// of truth. This value is still current as of writing (present in `agy
/// models`' live output), but isn't re-validated at runtime; if agy ever
/// retires it, the daemon just passes a `--model` agy no longer recognizes
/// on first spawn, which agy itself will report as its own CLI error.
pub const AGY_DEFAULT_MODEL: &str = "Gemini 3.1 Pro (High)";

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

// Rich Chat (ACP) is driven by the openab `agy-acp` binary (vendored
// submodule), not a bun/npm package. Its path is resolved by `vst-agy-acp`.

/// Default poll constants for chat-id capture.
pub const CHAT_ID_POLL_TIMEOUT_MS: u64 = 30_000;
pub const CHAT_ID_POLL_INTERVAL_MS: u64 = 500;

/// Per-turn mutable state threaded through [`parse_agy_stream_line`] — a fresh
/// object per turn (step_index resets every turn).
#[derive(Default)]
pub struct AgyStreamState {
    pub tool_started: HashSet<String>,
}

pub fn create_agy_stream_state() -> AgyStreamState {
    AgyStreamState::default()
}

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

/// Parse ONE agy `--output-format stream-json` line — `parseAgyStreamLine`.
pub fn parse_agy_stream_line(
    line: &str,
    session_id: &str,
    state: &mut AgyStreamState,
    fallback_model: Option<&str>,
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
        |kind: NormalizedEventKind| base_event(session_id, NormalizedEventProvider::Agy, kind);

    let event_name = msg.get("event").and_then(|e| e.as_str());
    let model = fallback_model
        .filter(|m| !m.is_empty())
        .unwrap_or("")
        .to_string();

    if event_name == Some("init") {
        let mut ev = event(NormalizedEventKind::SessionInit);
        ev.agent_chat_id = msg
            .get("conversation_id")
            .and_then(|c| c.as_str())
            .map(str::to_string);
        if !model.is_empty() {
            ev.model = Some(model.clone());
        }
        return vec![ev];
    }

    if event_name == Some("step_update") {
        let step = msg
            .get("step_update")
            .cloned()
            .unwrap_or(Value::Object(Default::default()));
        let step_type = step.get("step_type").and_then(|s| s.as_str());
        let step_state = step.get("state").and_then(|s| s.as_str());
        let mut events: Vec<NormalizedEvent> = Vec::new();

        if step_type == Some("agent_response") {
            let text_delta = step
                .get("text_delta")
                .and_then(|t| t.as_str())
                .unwrap_or("");
            if !text_delta.is_empty() {
                let mut ev = event(NormalizedEventKind::Text);
                ev.role = Some(Role::Assistant);
                ev.text = Some(text_delta.to_string());
                events.push(ev);
            }
            return events;
        }

        if step_type == Some("tool") {
            let tool_id = step
                .get("step_index")
                .and_then(|i| i.as_i64())
                .map(|i| i.to_string());
            let tool_info = step
                .get("tool_info")
                .cloned()
                .unwrap_or(Value::Object(Default::default()));
            let tool_name = step.get("tool_name").and_then(|t| t.as_str());
            let mut emitted_tool_use = false;
            if let Some(tid) = &tool_id {
                if !state.tool_started.contains(tid) {
                    state.tool_started.insert(tid.clone());
                    let mut ev = event(NormalizedEventKind::ToolUse);
                    ev.role = Some(Role::Assistant);
                    ev.tool_name = tool_name.map(str::to_string);
                    ev.tool_id = Some(tid.clone());
                    ev.tool_input = tool_info.get("parameters").cloned();
                    events.push(ev);
                    emitted_tool_use = true;
                }
            }
            if step_state == Some("DONE") {
                let raw = tool_info.get("output").or_else(|| tool_info.get("error"));
                let content_str = match raw {
                    Some(Value::String(s)) => Some(s.clone()),
                    Some(Value::Null) | None => None,
                    Some(other) => Some(other.to_string()),
                };
                let mut ev = event(NormalizedEventKind::ToolResult);
                ev.tool_id = tool_id.clone();
                ev.tool_result = Some(ToolResult {
                    content: content_str,
                    is_error: Some(tool_info.get("error").is_some()),
                });
                events.push(ev);
            }
            let _ = emitted_tool_use;
            return events;
        }

        // user_input / unknown / checkpoint / error_message — no renderable payload.
        return events;
    }

    if event_name == Some("result") {
        let result = msg
            .get("result")
            .cloned()
            .unwrap_or(Value::Object(Default::default()));
        let status = result.get("status").and_then(|s| s.as_str());
        let mut events: Vec<NormalizedEvent> = Vec::new();

        let usage_raw = result
            .get("usage")
            .cloned()
            .unwrap_or(Value::Object(Default::default()));
        let input_tokens = usage_raw.get("input_tokens").map(num).unwrap_or(0);
        let output_tokens = usage_raw.get("output_tokens").map(num).unwrap_or(0);
        let total_tokens = usage_raw
            .get("total_tokens")
            .map(num)
            .unwrap_or(input_tokens + output_tokens);
        let usage = UsageInfo {
            input_tokens,
            output_tokens,
            cache_read_tokens: 0,
            cache_create_tokens: 0,
            total_tokens,
            model: model.clone(),
            ..Default::default()
        };
        let mut usage_ev = event(NormalizedEventKind::Usage);
        if !model.is_empty() {
            usage_ev.model = Some(model.clone());
        }
        usage_ev.usage = Some(usage.clone());
        events.push(usage_ev);

        let error_text = result.get("error").and_then(|e| e.as_str());
        let is_error = status == Some("ERROR") || error_text.is_some();
        let mut result_ev = event(NormalizedEventKind::Result);
        if !model.is_empty() {
            result_ev.model = Some(model.clone());
        }
        result_ev.usage = Some(usage);
        if is_error {
            if let Some(err) = error_text {
                result_ev.text = Some(err.to_string());
            }
        }
        events.push(result_ev);

        if is_error {
            let mut err_ev = event(NormalizedEventKind::Error);
            err_ev.text = Some(error_text.unwrap_or("agy turn failed").to_string());
            events.push(err_ev);
        }
        return events;
    }

    vec![]
}

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

    fn supports_acp(&self) -> bool {
        true
    }

    fn acp_initial_config_option(&self, model: &str) -> Option<(String, String)> {
        // openab's agy-acp ignores `_meta` at `session/new`/`session/load`
        // entirely (its handler hardcodes `model_id: None`) — the only way
        // to select a model is this explicit follow-up `configId: "model"`
        // call. Without it, every agy Rich Chat session silently runs on
        // whatever `agy`'s own CLI defaults to (currently its first `agy
        // models` entry), ignoring the mode's configured model and the model
        // picker entirely — verified live: a mode set to "Claude Opus 4.6
        // (Thinking)" still replied as "Gemini 3.8 Flash". `value` is the
        // model's display name (same string `list_models()`/`--model`
        // already use — the adapter passes it straight through to `agy
        // --model <value>`, and agy accepts the display name directly). See
        // .vibekit/reports/2026-09-22-agy-toggle-no-reply.md.
        Some(("model".to_string(), model.to_string()))
    }

    fn capture_native_chat_id(
        &self,
        args: CaptureNativeChatIdArgs<'_>,
    ) -> AsyncResult<Option<String>> {
        let known = args.session.agent_chat_id.clone();
        let acp = args.acp_session_id.to_string();
        let cwd = args.cwd.to_string();
        Box::pin(async move {
            if let Some(id) = known.filter(|id| !id.is_empty()) {
                return Some(id);
            }
            if let Some(id) = read_agy_acp_session_conversation_id(&acp).await {
                return Some(id);
            }
            read_latest_agy_conversation_id(&cwd).await
        })
    }

    fn get_restore_command(&self, args: RestoreArgs<'_>) -> AsyncResult<Option<Vec<String>>> {
        let known = args.session.agent_chat_id.clone();
        let cwd = args.cwd.to_string();
        let model = args.model.map(|m| m.to_string());
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
            build_spec: Box::new(|ctx| {
                // The openab `agy-acp` binary must be present (built from the
                // vendored submodule). If it isn't, use a clear sentinel so the
                // spawn failure is diagnosable rather than a silent empty argv.
                let adapter_bin = vst_agy_acp::agy_acp_bin()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "agy-acp".to_string());
                AcpLaunchSpec {
                    command: adapter_bin,
                    args: Vec::new(),
                    cwd: ctx.cwd.clone(),
                    env: HashMap::from([
                        // Point the adapter at the user's own agy install.
                        ("AGY_BIN".to_string(), resolve_agy_binary()),
                        // Point the adapter's session store at the harness-owned path.
                        (
                            vst_agy_acp::AGY_ACP_STATE_DIR_ENV.to_string(),
                            vst_agy_acp::agy_acp_state_dir_env_value(),
                        ),
                        // The adapter splices this into every `agy -p ...` invocation
                        // it makes internally (adapter.rs's AGY_EXTRA_ARGS handling).
                        // Without it, agy runs with toolPermission=request-review and
                        // soft-denies every tool confirmation in headless/print mode
                        // (no TTY to approve from), silently stopping the stream with
                        // no error surfaced anywhere — the turn just ends with no
                        // text. The TTY launch (get_launch_command/get_restore_command
                        // below, and compose_launch_prompt) has always passed
                        // --dangerously-skip-permissions directly; ACP mode needs the
                        // exact same policy, just via this indirect env seam since we
                        // don't build agy's argv ourselves here (the adapter does).
                        // See .vibekit/reports/2026-09-22-agy-toggle-no-reply.md (B1/A1).
                        (
                            "AGY_EXTRA_ARGS".to_string(),
                            "--dangerously-skip-permissions".to_string(),
                        ),
                    ]),
                    // Phase 4.3 — never lets the connect/initialize hang indefinitely.
                    initialize_timeout_ms: Some(20_000),
                    prompt_timeout_ms: None,
                }
            }),
            enrich: None,
            // agy spike (4.1b): Option B — the ACP session id does NOT
            // round-trip through `agy --conversation`, so we do NOT surface it
            // as `agentChatId`. None = no session_init.
            first_turn_session_init: None,
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

/// Resolve the user's own `agy` binary, passed to the adapter via `AGY_BIN`
/// (its escape hatch — it otherwise tries to download a release binary itself).
fn resolve_agy_binary() -> String {
    std::env::var("AGY_BIN").unwrap_or_else(|_| "agy".to_string())
}

/// Shell-quote a string (escapes embedded `'`) — see [`vst_proc::sq`]. A
/// local unescaped `'{s}'` here once broke any task prompt containing an
/// apostrophe (`sh -lc` syntax error → pane dies instantly → `exited`).
use vst_proc::sq;
