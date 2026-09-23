//! Cursor agent plugin — ports `agent-plugins/cursor.ts`.
//!
//! Delivery: inline (system + task prompts baked into the launch command).
//! Ready signal: no sentinel, 8s fallback. `unavailable` two-session-identity
//! strategy: implements `capture_native_chat_id` (best-effort) AND
//! `supports_json_to_terminal_resume() -> false`.

use std::collections::BTreeMap;
use std::path::PathBuf;

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
use crate::native_chat_id::find_latest_cursor_chat_id;
use crate::plugin::{
    base_event, AgentPlugin, AsyncResult, CaptureArgs, CaptureNativeChatIdArgs, ComposePromptInput,
    ComposePromptResult, LaunchConfig, ListModelsResult, PromptDelivery, ReadySignal, RestoreArgs,
    TurnContext, TurnInput,
};

/// Shell-quote a string (escapes embedded `'`) — see [`vst_proc::sq`]. A
/// local unescaped `'{s}'` here once broke any task prompt containing an
/// apostrophe (`sh -lc` syntax error → pane dies instantly → `exited`).
use vst_proc::sq;

fn num(v: &Value) -> i64 {
    v.as_i64().unwrap_or(0)
}

/// Map ONE cursor-agent `stream-json` line into zero or more
/// [`NormalizedEvent`]s — `parseCursorStreamLine` in `cursor.ts`. Malformed
/// lines are skipped (tolerated), never fatal.
pub fn parse_cursor_stream_line(line: &str, session_id: &str) -> Vec<NormalizedEvent> {
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
        |kind: NormalizedEventKind| base_event(session_id, NormalizedEventProvider::Cursor, kind);

    let Some(type_s) = msg.get("type").and_then(|t| t.as_str()) else {
        return vec![];
    };
    let subtype = msg.get("subtype").and_then(|t| t.as_str());
    let mut events: Vec<NormalizedEvent> = Vec::new();

    if type_s == "system" && subtype == Some("init") {
        let mut ev = event(NormalizedEventKind::SessionInit);
        ev.model = msg
            .get("model")
            .and_then(|m| m.as_str())
            .map(str::to_string);
        ev.agent_chat_id = msg
            .get("session_id")
            .and_then(|m| m.as_str())
            .map(str::to_string);
        events.push(ev);
        return events;
    }

    // Suppress the CLI's user echo.
    if type_s == "user" {
        return vec![];
    }

    if type_s == "assistant" {
        let content = msg
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array());
        if let Some(blocks) = content {
            for block in blocks {
                let Some(bt) = block.get("type").and_then(|t| t.as_str()) else {
                    continue;
                };
                if bt == "text" {
                    if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                        let mut ev = event(NormalizedEventKind::Text);
                        ev.role = Some(Role::Assistant);
                        ev.text = Some(text.to_string());
                        events.push(ev);
                    }
                } else if bt == "thinking" {
                    if let Some(text) = block.get("thinking").and_then(|t| t.as_str()) {
                        let mut ev = event(NormalizedEventKind::Thinking);
                        ev.role = Some(Role::Assistant);
                        ev.text = Some(text.to_string());
                        events.push(ev);
                    }
                } else if bt == "tool_use" {
                    let mut ev = event(NormalizedEventKind::ToolUse);
                    ev.role = Some(Role::Assistant);
                    ev.tool_name = block
                        .get("name")
                        .and_then(|n| n.as_str())
                        .map(str::to_string);
                    ev.tool_id = block.get("id").and_then(|n| n.as_str()).map(str::to_string);
                    ev.tool_input = block.get("input").cloned();
                    events.push(ev);
                }
            }
        }
        return events;
    }

    if type_s == "thinking" {
        let text = msg
            .get("text")
            .and_then(|t| t.as_str())
            .or_else(|| msg.get("delta").and_then(|t| t.as_str()))
            .or_else(|| msg.get("thinking").and_then(|t| t.as_str()));
        if let Some(text) = text {
            let mut ev = event(NormalizedEventKind::Thinking);
            ev.role = Some(Role::Assistant);
            ev.text = Some(text.to_string());
            events.push(ev);
        }
        return events;
    }

    if type_s == "tool_call" {
        let call_id = msg.get("call_id").and_then(|c| c.as_str());
        let tool_call = msg
            .get("tool_call")
            .cloned()
            .unwrap_or(Value::Object(Default::default()));
        let keys: Vec<String> = tool_call
            .as_object()
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();
        let tool_name = keys
            .iter()
            .find(|k| k.ends_with("ToolCall"))
            .or_else(|| keys.first())
            .cloned();
        let payload = tool_name
            .as_ref()
            .and_then(|n| tool_call.get(n))
            .cloned()
            .unwrap_or(Value::Object(Default::default()));
        match subtype {
            Some("started") => {
                let mut ev = event(NormalizedEventKind::ToolUse);
                ev.role = Some(Role::Assistant);
                ev.tool_name = tool_name;
                ev.tool_id = call_id.map(str::to_string);
                ev.tool_input = payload.get("args").cloned();
                events.push(ev);
            }
            Some("completed") => {
                let raw_result = payload.get("result").or_else(|| msg.get("result")).cloned();
                let mut is_error = false;
                let mut detail = raw_result.clone();
                if let Some(Value::Object(r)) = raw_result {
                    if r.contains_key("failure") {
                        is_error = true;
                        detail = r.get("failure").cloned();
                    } else if r.contains_key("success") {
                        detail = r.get("success").cloned();
                    }
                }
                let content_str = match &detail {
                    Some(Value::String(s)) => Some(s.clone()),
                    Some(other) => Some(other.to_string()),
                    None => None,
                };
                let mut ev = event(NormalizedEventKind::ToolResult);
                ev.tool_id = call_id.map(str::to_string);
                ev.tool_result = Some(ToolResult {
                    content: content_str,
                    is_error: Some(is_error),
                });
                events.push(ev);
            }
            _ => {}
        }
        return events;
    }

    if type_s == "result" {
        let usage_raw = msg
            .get("usage")
            .cloned()
            .unwrap_or(Value::Object(Default::default()));
        let input_tokens = usage_raw
            .get("inputTokens")
            .or_else(|| usage_raw.get("input_tokens"))
            .map(num)
            .unwrap_or(0);
        let output_tokens = usage_raw
            .get("outputTokens")
            .or_else(|| usage_raw.get("output_tokens"))
            .map(num)
            .unwrap_or(0);
        let cache_read_tokens = usage_raw
            .get("cacheReadTokens")
            .or_else(|| usage_raw.get("cache_read_input_tokens"))
            .map(num)
            .unwrap_or(0);
        let cache_create_tokens = usage_raw
            .get("cacheWriteTokens")
            .or_else(|| usage_raw.get("cache_creation_input_tokens"))
            .map(num)
            .unwrap_or(0);
        let model = msg
            .get("model")
            .and_then(|m| m.as_str())
            .unwrap_or("")
            .to_string();
        let usage = UsageInfo {
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_create_tokens,
            total_tokens: input_tokens + output_tokens + cache_read_tokens + cache_create_tokens,
            cost_usd: msg.get("total_cost_usd").and_then(|c| c.as_f64()),
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
        result_ev.usage = Some(usage.clone());
        if subtype == Some("error") {
            if let Some(text) = msg.get("result").and_then(|r| r.as_str()) {
                result_ev.text = Some(text.to_string());
            }
        }
        events.push(result_ev);

        if subtype == Some("error") {
            let err_text = msg
                .get("result")
                .and_then(|r| r.as_str())
                .or_else(|| msg.get("error").and_then(|e| e.as_str()))
                .unwrap_or("turn failed");
            let mut err_ev = event(NormalizedEventKind::Error);
            err_ev.text = Some(err_text.to_string());
            events.push(err_ev);
        }
        return events;
    }

    vec![]
}

/// The `/vst` custom slash-command template for `.cursor/commands/vst.md`
/// (NO `$ARGUMENTS` placeholder — Cursor appends trailing text, not substitutes).
const VST_COMMAND: &str = r#"The user just ran `/vst`, optionally followed by more text appended
right after this instruction (that trailing text, if any, follows below).
Read whatever follows and map it to exactly one `vst` CLI command below,
then run it as a shell command. Do not improvise flags beyond these:

- Nothing after `/vst`, or just `reset` -> `vst session reset $VST_SESSION`
- `reset --handoff` -> see "Important — `reset --handoff` writes its own file" below
- `reset` followed by other text -> `vst session reset $VST_SESSION --prompt "<that text>"`
- `reset --handoff` followed by other text -> see "Important — `reset --handoff` writes its own file" below (final command includes both `--handoff-file <path>` and `--prompt "<that text>"`)
- `reset --mode <name>` -> `vst session reset $VST_SESSION --mode "<name>"` (switches mode/CLI on reset — combine with other reset flags, e.g. `--mode "<name>" --prompt "<that text>"`)
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
(with `--prompt "<that text>"` too if other text followed `--handoff`, but
never `--handoff` itself) — the CLI reads that file locally and sends its
contents as the handoff summary.

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

/// Cursor agent plugin (stateless singleton).
pub struct CursorPlugin;

/// Create a fresh cursor plugin instance (`createCursorPlugin`).
pub fn create_cursor_plugin() -> CursorPlugin {
    CursorPlugin
}

impl AgentPlugin for CursorPlugin {
    fn name(&self) -> &str {
        "cursor"
    }

    fn default_model(&self) -> &str {
        "auto"
    }

    fn default_mode_icon(&self, _model: Option<&str>) -> &'static str {
        "cursor"
    }

    fn prompt_delivery(&self) -> PromptDelivery {
        PromptDelivery::Inline
    }

    fn get_launch_command(&self, cfg: &LaunchConfig) -> Vec<String> {
        let wt_path = cfg.ctx.cwd.to_string_lossy().into_owned();
        let mut argv = vec!["cursor-agent".to_string()];
        if let Some(id) = &cfg.session.agent_chat_id {
            argv.push("--resume".to_string());
            argv.push(id.clone());
        }
        if let Some(model) = &cfg.model {
            argv.push("--model".to_string());
            argv.push(model.clone());
        }
        argv.push("--workspace".to_string());
        argv.push(wt_path);
        argv.push("--force".to_string());
        argv.push("--sandbox".to_string());
        argv.push("disabled".to_string());
        argv.push("--approve-mcps".to_string());
        argv
    }

    fn get_environment(&self, _cfg: &LaunchConfig) -> BTreeMap<String, String> {
        BTreeMap::new()
    }

    fn get_ready_signal(&self) -> ReadySignal {
        ReadySignal {
            sentinel: None,
            fallback_ms: 8_000,
        }
    }

    fn compose_launch_prompt(&self, input: ComposePromptInput) -> ComposePromptResult {
        let wt_path = input.launch_cfg.ctx.cwd.to_string_lossy().into_owned();
        let mut stdin_content = format!("cat {}", sq(&input.system_prompt_file));
        if let Some(task) = &input.task_prompt {
            stdin_content.push_str(&format!("; printf '\\n\\n'; printf %s {}", sq(task)));
        }
        let mut parts: Vec<String> = vec!["cursor-agent".to_string()];
        if let Some(id) = &input.launch_cfg.session.agent_chat_id {
            parts.push(format!("--resume {id}"));
        }
        if let Some(model) = &input.launch_cfg.model {
            parts.push(format!("--model {}", sq(model)));
        }
        parts.push(format!("--workspace {}", sq(&wt_path)));
        parts.push("--force".to_string());
        parts.push("--sandbox disabled".to_string());
        parts.push("--approve-mcps".to_string());
        parts.push(format!("-- \"$({stdin_content})\""));
        ComposePromptResult {
            use_shell: true,
            shell_line: Some(parts.join(" ")),
            ..Default::default()
        }
    }

    fn setup_workspace_hooks(&self, workspace_path: &str) -> AsyncResult<()> {
        let root = PathBuf::from(workspace_path);
        Box::pin(async move {
            let commands_dir = root.join(".cursor").join("commands");
            let _ = fs::create_dir_all(&commands_dir).await;
            let vst_command_path = commands_dir.join("vst.md");
            let existing = fs::read_to_string(&vst_command_path)
                .await
                .unwrap_or_default();
            if existing != VST_COMMAND {
                let _ = fs::write(&vst_command_path, VST_COMMAND).await;
            }
            let _ = ensure_gitignore_entry(root.join(".gitignore"), ".cursor/").await;
        })
    }

    fn list_models(&self) -> AsyncResult<ListModelsResult> {
        // cursor's TS `listModels` shells out to `cursor-agent --list-models`;
        // per this part's "no live process" rule that call is not made here,
        // and no 04a test exercises it — return the offline failure shape.
        Box::pin(async move {
            ListModelsResult {
                models: vec![],
                error: Some(
                    "Failed to fetch models from CLI. Check that the CLI is installed and authenticated."
                        .to_string(),
                ),
            }
        })
    }

    fn provide_chat_id(&self, _args: CaptureArgs<'_>) -> AsyncResult<Option<String>> {
        // cursor's TS `provideChatId` runs `cursor-agent create-chat`; per the
        // "no live process" rule it is not spawned here (no 04a test covers it).
        Box::pin(async { None })
    }

    fn get_restore_command(&self, args: RestoreArgs<'_>) -> AsyncResult<Option<Vec<String>>> {
        let chat_id = args.session.agent_chat_id.clone();
        let cwd = args.cwd.to_string();
        let model = args.model.map(|m| m.to_string());
        Box::pin(async move {
            let chat_id = match chat_id {
                Some(c) if !c.is_empty() => c,
                _ => match find_latest_cursor_chat_id(&cwd).await {
                    Some(c) => c,
                    None => return None,
                },
            };
            let mut argv = vec!["cursor-agent".to_string(), "--resume".to_string(), chat_id];
            if let Some(model) = model {
                argv.push("--model".to_string());
                argv.push(model);
            }
            argv.push("--workspace".to_string());
            argv.push(cwd);
            argv.push("--force".to_string());
            argv.push("--sandbox".to_string());
            argv.push("disabled".to_string());
            argv.push("--approve-mcps".to_string());
            Some(argv)
        })
    }

    fn supports_json(&self) -> bool {
        true
    }

    fn supports_acp(&self) -> bool {
        true
    }

    fn supports_json_to_terminal_resume(&self) -> bool {
        false
    }

    fn capture_native_chat_id(
        &self,
        args: CaptureNativeChatIdArgs<'_>,
    ) -> AsyncResult<Option<String>> {
        let known = args.session.agent_chat_id.clone();
        let cwd = args.cwd.to_string();
        Box::pin(async move {
            if let Some(id) = known.filter(|id| !id.is_empty()) {
                return Some(id);
            }
            find_latest_cursor_chat_id(&cwd).await
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
            provider: NormalizedEventProvider::Cursor,
            build_spec: Box::new(|ctx| AcpLaunchSpec {
                command: "cursor-agent".to_string(),
                args: vec!["acp".to_string()],
                cwd: ctx.cwd.clone(),
                env: Default::default(),
                initialize_timeout_ms: None,
                prompt_timeout_ms: None,
            }),
            enrich: None,
            // cursor spike (3.0a): Option B — the ACP session id does NOT
            // reliably round-trip through the raw CLI's own `--resume`, so we
            // do NOT surface it as `agentChatId`. None = no session_init.
            first_turn_session_init: None,
            // cursor prepends the system prompt to the message on the first
            // turn (a single text block), matching the TS.
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
