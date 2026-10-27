//! Maps agy `step_update`/`result` frames onto ACP `session/update`s and a
//! `PromptResponse`.
//!
//! Rules (event mapping):
//! - frames whose `conversation_id` is not this session's are dropped;
//! - `agent_response` ACTIVE **and** DONE `text_delta`s are forwarded as
//!   `AgentMessageChunk` (agy splits one reply across both, and
//!   `result.response` is never used for text);
//! - turn usage is the SUM of per-step `agent_response` usage — `result.usage`
//!   is cumulative per conversation and only used when no step carried usage;
//! - every tool step is one `ToolCall` (first sight) plus a terminal
//!   `ToolCallUpdate`; a tool still open when the turn ends/dies is FAILED,
//!   never left spinning;
//! - a successful `write_file`/`edit_file` additionally carries a `Diff` when
//!   the caller resolved one from agy's transcript (see [`EditLookup`]).

use std::collections::HashSet;
use std::path::PathBuf;

use agent_client_protocol::schema::v1::{
    ContentChunk, Diff, SessionUpdate, StopReason, ToolCall, ToolCallContent, ToolCallLocation,
    ToolCallStatus, ToolCallUpdate, ToolCallUpdateFields, ToolKind, Usage,
};
use serde_json::Value;

use crate::edit_diff::{self, DiffPiece};
use crate::transcript::{self, CallKey};
use crate::wire::{error_text, AgyResult, AgyUsage, ResultStatus, Step, StepState, StepType};

/// First chunk of the first prompt of a `session/new` session: stream-json has
/// no permission channel, so agy always runs with
/// `--dangerously-skip-permissions`. Said once, never on load/respawn.
pub const AUTO_APPROVE_NOTE: &str = "agy Rich Chat auto-approves tool calls.\n\n";

/// Result of [`TurnMapper::finish`].
#[derive(Debug)]
pub struct TurnOutcome {
    /// Updates still to be sent before the prompt response.
    pub updates: Vec<SessionUpdate>,
    /// `Ok(stop_reason)` ends the turn; `Err(message)` is a JSON-RPC error.
    pub stop: Result<StopReason, String>,
    /// Token usage for THIS turn (never the conversation-cumulative figure).
    pub usage: Option<Usage>,
}

/// Everything needed to resolve a file tool's diff from the transcript. Owned
/// so it can move into a blocking task; built by [`TurnMapper::edit_lookup`].
#[derive(Debug, Clone)]
pub struct EditLookup {
    pub conversation_id: String,
    pub tool_name: String,
    pub path: String,
    /// The stream's tool `step_index` (keys the transcript's result row).
    pub step_index: i64,
    pub consumed: HashSet<CallKey>,
}

impl EditLookup {
    /// Blocking file IO: run it off the async runtime.
    #[must_use]
    pub fn resolve(&self, home: &std::path::Path) -> Option<ResolvedEdit> {
        transcript::find_edit(
            home,
            &self.conversation_id,
            &self.tool_name,
            &self.path,
            self.step_index,
            &self.consumed,
        )
        .map(|(key, edit)| ResolvedEdit {
            key,
            path: edit.path.clone(),
            pieces: edit_diff::plan(&edit),
        })
    }
}

/// A transcript call matched to a tool step.
#[derive(Debug, Clone)]
pub struct ResolvedEdit {
    pub key: CallKey,
    pub path: String,
    /// Diffs to show; empty = the call is matched (consumed) but no trustworthy
    /// line number exists, so the card carries no diff.
    pub pieces: Vec<DiffPiece>,
}

/// Per-turn agy → ACP translation state. One instance per `session/prompt`.
pub struct TurnMapper {
    conversation_id: String,
    note_pending: bool,
    /// Tool step indexes that already have a `ToolCall`.
    started_tools: HashSet<i64>,
    /// Tool step indexes that have a `ToolCall` but no terminal update yet.
    open_tools: HashSet<i64>,
    /// `agent_response` step indexes whose usage was already added.
    counted_usage_steps: HashSet<i64>,
    usage: AgyUsage,
    usage_from_steps: bool,
    /// Transcript tool calls already turned into a diff this turn, so repeated
    /// edits of one file map to successive calls.
    consumed_edits: HashSet<CallKey>,
}

impl TurnMapper {
    /// `first_prompt_of_new_session` emits [`AUTO_APPROVE_NOTE`] as the very
    /// first chunk of the turn.
    #[must_use]
    pub fn new(conversation_id: &str, first_prompt_of_new_session: bool) -> Self {
        Self {
            conversation_id: conversation_id.to_string(),
            note_pending: first_prompt_of_new_session,
            started_tools: HashSet::new(),
            open_tools: HashSet::new(),
            counted_usage_steps: HashSet::new(),
            usage: AgyUsage::default(),
            usage_from_steps: false,
            consumed_edits: HashSet::new(),
        }
    }

    /// `Some` when `step` is a successfully finished file tool whose diff can
    /// be looked up in the transcript. DONE only, never at ACTIVE.
    #[must_use]
    pub fn edit_lookup(&self, step: &Step) -> Option<EditLookup> {
        if step.step_type != StepType::Tool || step.state != StepState::Done {
            return None;
        }
        if step
            .conversation_id
            .as_ref()
            .is_some_and(|conv| conv != &self.conversation_id)
        {
            return None;
        }
        let tool_name = step.tool_name.as_deref()?;
        if !transcript::supports(tool_name) {
            return None;
        }
        let path = step
            .tool_info
            .as_ref()?
            .parameters
            .get("Path")?
            .as_str()
            .filter(|p| !p.is_empty())?;
        Some(EditLookup {
            conversation_id: self.conversation_id.clone(),
            tool_name: tool_name.to_string(),
            path: path.to_string(),
            step_index: step.step_index,
            consumed: self.consumed_edits.clone(),
        })
    }

    /// Translate one `step_update` (no diff lookup).
    pub fn on_step(&mut self, step: &Step) -> Vec<SessionUpdate> {
        self.on_step_with_edit(step, None)
    }

    /// Translate one `step_update`; `edit` is the transcript match for a DONE
    /// file tool (see [`TurnMapper::edit_lookup`]), attached as a `Diff`.
    pub fn on_step_with_edit(
        &mut self,
        step: &Step,
        edit: Option<ResolvedEdit>,
    ) -> Vec<SessionUpdate> {
        if let Some(conv) = &step.conversation_id {
            if conv != &self.conversation_id {
                return Vec::new();
            }
        }
        let mut updates = Vec::new();
        if self.note_pending {
            self.note_pending = false;
            updates.push(text_chunk(AUTO_APPROVE_NOTE));
        }
        match step.step_type {
            StepType::AgentResponse => {
                if let Some(delta) = &step.text_delta {
                    if !delta.is_empty() {
                        updates.push(text_chunk(delta));
                    }
                }
                if step.state == StepState::Done {
                    if let Some(usage) = step.usage {
                        if self.counted_usage_steps.insert(step.step_index) {
                            self.add_usage(&usage);
                        }
                    }
                }
            }
            StepType::Tool => {
                let id = self.tool_id(step.step_index);
                if !self.started_tools.contains(&step.step_index) {
                    self.started_tools.insert(step.step_index);
                    self.open_tools.insert(step.step_index);
                    updates.push(SessionUpdate::ToolCall(Self::tool_call(step, &id)));
                }
                match step.state {
                    StepState::Done => {
                        self.open_tools.remove(&step.step_index);
                        let output = step
                            .tool_info
                            .as_ref()
                            .and_then(|i| i.output.as_ref())
                            .map_or_else(String::new, output_text);
                        updates.push(match edit {
                            Some(resolved) => {
                                self.consumed_edits.insert(resolved.key);
                                diff_update(&id, output, resolved)
                            }
                            None => tool_update(&id, ToolCallStatus::Completed, output),
                        });
                    }
                    StepState::Error => {
                        self.open_tools.remove(&step.step_index);
                        updates.push(tool_update(
                            &id,
                            ToolCallStatus::Failed,
                            step.tool_info
                                .as_ref()
                                .and_then(|i| i.error.as_ref())
                                .map(error_text)
                                .unwrap_or_default(),
                        ));
                    }
                    _ => {}
                }
            }
            // user_input / checkpoint / error_message / system_message /
            // unknown step types carry no renderable payload.
            _ => {}
        }
        updates
    }

    /// Translate the turn's `result` frame. `cancelled` means the client sent
    /// `session/cancel` (any result then ends as `Cancelled`, never an error).
    pub fn finish(&mut self, result: &AgyResult, cancelled: bool) -> TurnOutcome {
        let interrupted =
            result.status == ResultStatus::Error && result.error.as_deref() == Some("interrupted");
        let is_cancel = cancelled || interrupted;

        let fail_reason = if is_cancel {
            "cancelled".to_string()
        } else if result.status == ResultStatus::Error {
            result
                .error
                .clone()
                .filter(|e| !e.is_empty())
                .unwrap_or_else(|| "agy turn failed".to_string())
        } else {
            "the turn ended before the tool finished".to_string()
        };
        let mut updates = self.fail_open_tools(&fail_reason);

        let stop = if is_cancel {
            Ok(StopReason::Cancelled)
        } else if result.status == ResultStatus::Error {
            Err(fail_reason)
        } else {
            if !result.denied_actions.is_empty() {
                updates.push(text_chunk(&denied_note(&result.denied_actions)));
            }
            Ok(StopReason::EndTurn)
        };

        TurnOutcome {
            updates,
            stop,
            usage: self.turn_usage(result),
        }
    }

    /// Translate "agy died before its `result`": every open tool becomes
    /// FAILED so the UI never shows a spinner for a dead process.
    pub fn on_exit(&mut self) -> Vec<SessionUpdate> {
        self.fail_open_tools("agy exited before the tool finished")
    }

    fn tool_id(&self, step_index: i64) -> String {
        format!(
            "agy-{}-{step_index}",
            self.conversation_id.chars().take(8).collect::<String>()
        )
    }

    fn tool_call(step: &Step, id: &str) -> ToolCall {
        let tool_name = step.tool_name.as_deref().unwrap_or_default();
        let parameters = step
            .tool_info
            .as_ref()
            .map_or(Value::Null, |i| i.parameters.clone());
        let (title, kind, locations) = tool_presentation(tool_name, &parameters);
        ToolCall::new(id.to_string(), title)
            .kind(kind)
            .status(ToolCallStatus::InProgress)
            .locations(locations)
            .raw_input(parameters)
    }

    fn fail_open_tools(&mut self, reason: &str) -> Vec<SessionUpdate> {
        let mut open: Vec<i64> = self.open_tools.drain().collect();
        open.sort_unstable();
        open.into_iter()
            .map(|idx| {
                tool_update(
                    &self.tool_id(idx),
                    ToolCallStatus::Failed,
                    reason.to_string(),
                )
            })
            .collect()
    }

    fn add_usage(&mut self, usage: &AgyUsage) {
        self.usage_from_steps = true;
        self.usage.input_tokens += usage.input_tokens;
        self.usage.output_tokens += usage.output_tokens;
        self.usage.thinking_tokens += usage.thinking_tokens;
        self.usage.cache_read_tokens += usage.cache_read_tokens;
        self.usage.total_tokens += usage.total_tokens;
    }

    fn turn_usage(&self, result: &AgyResult) -> Option<Usage> {
        let usage = if self.usage_from_steps {
            self.usage
        } else {
            result.usage?
        };
        Some(to_acp_usage(&usage))
    }
}

/// `AgyUsage` → ACP `Usage`: `total_tokens` falls back to input+output when
/// agy omits it.
#[must_use]
pub fn to_acp_usage(usage: &AgyUsage) -> Usage {
    let total = if usage.total_tokens == 0 {
        usage.input_tokens + usage.output_tokens
    } else {
        usage.total_tokens
    };
    Usage::new(total, usage.input_tokens, usage.output_tokens)
        .thought_tokens(usage.thinking_tokens)
        .cached_read_tokens(usage.cache_read_tokens)
}

fn text_chunk(text: &str) -> SessionUpdate {
    SessionUpdate::AgentMessageChunk(ContentChunk::new(text.to_string().into()))
}

fn tool_update(id: &str, status: ToolCallStatus, text: String) -> SessionUpdate {
    SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
        id.to_string(),
        ToolCallUpdateFields::new()
            .status(status)
            .content(vec![ToolCallContent::from(text)]),
    ))
}

/// Completed update carrying the file diff after the (usually empty) output.
fn diff_update(id: &str, output: String, edit: ResolvedEdit) -> SessionUpdate {
    let mut content = Vec::new();
    if !output.is_empty() {
        content.push(ToolCallContent::from(output));
    }
    for piece in edit.pieces {
        let mut diff =
            Diff::new(PathBuf::from(&edit.path), piece.new_text).old_text(piece.old_text);
        if let Some((old_start, new_start)) = piece.starts {
            // The generic ACP convention the daemon reads: 1-based line starts.
            let mut meta = serde_json::Map::new();
            meta.insert("oldStart".into(), old_start.into());
            meta.insert("newStart".into(), new_start.into());
            diff = diff.meta(meta);
        }
        content.push(ToolCallContent::Diff(diff));
    }
    if content.is_empty() {
        content.push(ToolCallContent::from(String::new()));
    }
    SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
        id.to_string(),
        ToolCallUpdateFields::new()
            .status(ToolCallStatus::Completed)
            .content(content),
    ))
}

/// A tool's `output` is a string for most tools; keep non-string payloads
/// readable instead of dropping them.
fn output_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => crate::wire::compact(other),
    }
}

/// `"\n\nAntigravity denied: <display_name or action, joined ', '>\n"`.
fn denied_note(denied_actions: &[Value]) -> String {
    let names: Vec<String> = denied_actions
        .iter()
        .map(|action| {
            action
                .get("display_name")
                .and_then(Value::as_str)
                .or_else(|| action.get("action").and_then(Value::as_str))
                .map_or_else(
                    || {
                        let compact = crate::wire::compact(action);
                        compact.chars().take(200).collect()
                    },
                    str::to_string,
                )
        })
        .collect();
    format!("\n\nAntigravity denied: {}\n", names.join(", "))
}

/// `tool_name` + raw `parameters` → (title, kind, locations). Unknown tools or
/// missing keys fall back to `title = tool_name`, `ToolKind::Other`, no paths.
#[must_use]
pub fn tool_presentation(
    tool_name: &str,
    parameters: &Value,
) -> (String, ToolKind, Vec<ToolCallLocation>) {
    let param_str = |key: &str| {
        parameters
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let location = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| param_str(key).filter(|p| !p.is_empty()))
            .map(|p| vec![ToolCallLocation::new(PathBuf::from(p))])
            .unwrap_or_default()
    };
    match tool_name {
        "run_command" => (
            param_str("CommandLine").unwrap_or_else(|| tool_name.to_string()),
            ToolKind::Execute,
            Vec::new(),
        ),
        // `read_file`/`write_file`/`edit_file` are the names verified against
        // agy 1.4.7 (params: just `Path`); the others are older aliases from
        // the initial research, kept because they are still unverified.
        "read_file" | "view_file" => (
            tool_name.to_string(),
            ToolKind::Read,
            location(&["Path", "AbsolutePath"]),
        ),
        "write_file"
        | "edit_file"
        | "write_to_file"
        | "replace_file_content"
        | "multi_replace_file_content"
        | "sed_file"
        | "notebook_edit" => (
            tool_name.to_string(),
            ToolKind::Edit,
            location(&["Path", "TargetFile", "AbsolutePath"]),
        ),
        "grep_search" | "find_by_name" | "list_dir" => {
            (tool_name.to_string(), ToolKind::Search, Vec::new())
        }
        "read_url_content" | "search_web" => (tool_name.to_string(), ToolKind::Fetch, Vec::new()),
        "call_mcp_tool" => {
            let server = param_str("ServerName").unwrap_or_default();
            let tool = param_str("ToolName").unwrap_or_default();
            let title = if server.is_empty() && tool.is_empty() {
                tool_name.to_string()
            } else {
                format!("{server}: {tool}")
            };
            (title, ToolKind::Other, Vec::new())
        }
        _ => (tool_name.to_string(), ToolKind::Other, Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{parse_line, Inbound};

    const CONV: &str = "__CONV__";

    fn frames(fixture: &str) -> Vec<Inbound> {
        fixture
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(parse_line)
            .collect()
    }

    /// Run a whole fixture through a mapper, collecting EVERY update (step
    /// updates first, then the turn's own finish updates) plus the outcome.
    fn run_fixture(fixture: &str, cancelled: bool) -> (Vec<SessionUpdate>, TurnOutcome) {
        let mut mapper = TurnMapper::new(CONV, false);
        let mut updates = Vec::new();
        for frame in frames(fixture) {
            match frame {
                Inbound::Step(step) => updates.extend(mapper.on_step(&step)),
                Inbound::Result(result) => {
                    let mut outcome = mapper.finish(&result, cancelled);
                    updates.append(&mut outcome.updates);
                    return (updates, outcome);
                }
                _ => {}
            }
        }
        panic!("fixture had no result frame");
    }

    fn chunk_text(update: &SessionUpdate) -> Option<&str> {
        match update {
            SessionUpdate::AgentMessageChunk(chunk) => match &chunk.content {
                agent_client_protocol::schema::v1::ContentBlock::Text(t) => Some(&t.text),
                _ => None,
            },
            _ => None,
        }
    }

    fn tool_update_fields(update: &SessionUpdate) -> Option<&ToolCallUpdate> {
        match update {
            SessionUpdate::ToolCallUpdate(u) => Some(u),
            _ => None,
        }
    }

    fn content_text(update: &ToolCallUpdate) -> String {
        update
            .fields
            .content
            .as_ref()
            .map(|c| {
                c.iter()
                    .filter_map(|item| match item {
                        ToolCallContent::Content(content) => match &content.content {
                            agent_client_protocol::schema::v1::ContentBlock::Text(t) => {
                                Some(t.text.clone())
                            }
                            _ => None,
                        },
                        _ => None,
                    })
                    .collect::<String>()
            })
            .unwrap_or_default()
    }

    #[test]
    fn text_turn_chunks_concatenate_to_response() {
        let (updates, outcome) =
            run_fixture(include_str!("../tests/fixtures/turn_text.jsonl"), false);
        let text: String = updates.iter().filter_map(chunk_text).collect();
        assert_eq!(text, "Hello world!");
        assert_eq!(outcome.stop, Ok(StopReason::EndTurn));
    }

    #[test]
    fn done_delta_turn_matches_response() {
        let (updates, outcome) = run_fixture(
            include_str!("../tests/fixtures/turn_done_delta.jsonl"),
            false,
        );
        let text: String = updates.iter().filter_map(chunk_text).collect();
        assert_eq!(text, "The quick brown fox jumps over the lazy dog.");
        assert_eq!(outcome.stop, Ok(StopReason::EndTurn));
    }

    #[test]
    fn tool_turn_orders_call_then_completed() {
        let (updates, outcome) =
            run_fixture(include_str!("../tests/fixtures/turn_tool.jsonl"), false);
        let call_pos = updates
            .iter()
            .position(|u| matches!(u, SessionUpdate::ToolCall(_)))
            .expect("a ToolCall must be emitted");
        let update_pos = updates
            .iter()
            .position(|u| tool_update_fields(u).is_some())
            .expect("a ToolCallUpdate must be emitted");
        assert!(call_pos < update_pos, "ToolCall must precede its update");

        let SessionUpdate::ToolCall(call) = &updates[call_pos] else {
            unreachable!();
        };
        assert_eq!(call.status, ToolCallStatus::InProgress);
        assert_eq!(call.kind, ToolKind::Execute);
        assert_eq!(call.title, "echo hi");
        assert_eq!(call.tool_call_id.0.as_ref(), "agy-__CONV__-2");
        assert_eq!(call.raw_input.as_ref().unwrap()["CommandLine"], "echo hi");

        let update = tool_update_fields(&updates[update_pos]).unwrap();
        assert_eq!(update.fields.status, Some(ToolCallStatus::Completed));
        assert!(content_text(update).contains("hi"));
        assert_eq!(outcome.stop, Ok(StopReason::EndTurn));
    }

    #[test]
    fn done_without_active_emits_call_first() {
        let step = parse_step_line(
            r#"{"event":"step_update","step_update":{"conversation_id":"__CONV__","step_index":5,"state":"DONE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/tmp/x"},"output":"contents"}}}"#,
        );
        let mut mapper = TurnMapper::new(CONV, false);
        let updates = mapper.on_step(&step);
        assert_eq!(updates.len(), 2);
        assert!(matches!(updates[0], SessionUpdate::ToolCall(_)));
        let update = tool_update_fields(&updates[1]).unwrap();
        assert_eq!(update.fields.status, Some(ToolCallStatus::Completed));
        assert!(content_text(update).contains("contents"));
    }

    #[test]
    fn tool_error_state_becomes_failed_with_message() {
        let (updates, outcome) = run_fixture(
            include_str!("../tests/fixtures/turn_tool_error.jsonl"),
            false,
        );
        let failed: Vec<&ToolCallUpdate> = updates.iter().filter_map(tool_update_fields).collect();
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].fields.status, Some(ToolCallStatus::Failed));
        assert!(content_text(failed[0]).contains("user denied permission"));
        let note = updates
            .iter()
            .filter_map(chunk_text)
            .find(|t| t.contains("Antigravity denied"))
            .expect("a denied-actions note chunk");
        assert!(note.starts_with("\n\nAntigravity denied: RunCommand"));
        assert_eq!(outcome.stop, Ok(StopReason::EndTurn));
    }

    #[test]
    fn turn_usage_is_step_sum_not_result_cumulative() {
        let (_, outcome) = run_fixture(
            include_str!("../tests/fixtures/turn_cumulative_usage.jsonl"),
            false,
        );
        let usage = outcome.usage.expect("turn usage");
        assert_eq!(usage.input_tokens, 7762);
        assert_eq!(usage.output_tokens, 22);
        assert_eq!(usage.thought_tokens, Some(21));
        assert_eq!(usage.total_tokens, 7784);
        assert_ne!(usage.input_tokens, 15303);
        assert_ne!(usage.total_tokens, 15336);
    }

    #[test]
    fn usage_falls_back_to_result_when_no_step_usage() {
        let step = parse_step_line(
            r#"{"event":"step_update","step_update":{"conversation_id":"__CONV__","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"hi"}}"#,
        );
        let result = parse_result_line(
            r#"{"event":"result","result":{"conversation_id":"__CONV__","status":"SUCCESS","response":"hi","usage":{"input_tokens":40,"output_tokens":2,"thinking_tokens":3,"cache_read_tokens":7,"total_tokens":45}}}"#,
        );
        let mut mapper = TurnMapper::new(CONV, false);
        let _ = mapper.on_step(&step);
        let outcome = mapper.finish(&result, false);
        let usage = outcome.usage.expect("result usage fallback");
        assert_eq!(usage.input_tokens, 40);
        assert_eq!(usage.output_tokens, 2);
        assert_eq!(usage.total_tokens, 45);
        assert_eq!(usage.thought_tokens, Some(3));
        assert_eq!(usage.cached_read_tokens, Some(7));
    }

    #[test]
    fn interrupted_result_is_cancelled_not_error() {
        let (_, outcome) = run_fixture(
            include_str!("../tests/fixtures/turn_interrupted.jsonl"),
            false,
        );
        assert_eq!(outcome.stop, Ok(StopReason::Cancelled));
        assert!(outcome.usage.is_some());
    }

    #[test]
    fn result_while_tool_open_fails_tool() {
        let (updates, outcome) = run_fixture(
            include_str!("../tests/fixtures/turn_open_tool_then_error.jsonl"),
            false,
        );
        let call_pos = updates
            .iter()
            .position(|u| matches!(u, SessionUpdate::ToolCall(_)))
            .expect("a ToolCall must be emitted for the open tool");
        let SessionUpdate::ToolCall(call) = &updates[call_pos] else {
            unreachable!();
        };
        assert_eq!(call.kind, ToolKind::Read);
        assert_eq!(call.locations.len(), 1);
        assert_eq!(call.locations[0].path, PathBuf::from("/tmp/a.rs"));

        let failed_pos = updates
            .iter()
            .position(|u| {
                tool_update_fields(u)
                    .is_some_and(|f| f.fields.status == Some(ToolCallStatus::Failed))
            })
            .expect("the open tool must be FAILED");
        assert!(
            call_pos < failed_pos,
            "the ToolCall must precede the failure"
        );
        assert_eq!(outcome.stop, Err("boom".to_string()));
    }

    #[test]
    fn on_exit_fails_open_tools() {
        let step = parse_step_line(
            r#"{"event":"step_update","step_update":{"conversation_id":"__CONV__","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"parameters":{"CommandLine":"sleep 1"}}}}"#,
        );
        let mut mapper = TurnMapper::new(CONV, false);
        let started = mapper.on_step(&step);
        assert!(matches!(started[0], SessionUpdate::ToolCall(_)));
        let failed = mapper.on_exit();
        assert_eq!(failed.len(), 1);
        let update = tool_update_fields(&failed[0]).unwrap();
        assert_eq!(update.fields.status, Some(ToolCallStatus::Failed));
        assert!(content_text(update).contains("agy exited"));
        assert!(mapper.on_exit().is_empty(), "each open tool fails once");
    }

    #[test]
    fn foreign_conversation_frames_dropped() {
        let step = parse_step_line(
            r#"{"event":"step_update","step_update":{"conversation_id":"someone-else","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"nope"}}"#,
        );
        let mut mapper = TurnMapper::new(CONV, false);
        assert_eq!(mapper.on_step(&step).len(), 0);
    }

    #[test]
    fn error_result_is_err_with_message() {
        let (_, outcome) = run_fixture(include_str!("../tests/fixtures/turn_error.jsonl"), false);
        assert_eq!(outcome.stop, Err("model overloaded".to_string()));
    }

    #[test]
    fn auto_approve_note_only_on_first_prompt_of_new_session() {
        let step = parse_step_line(
            r#"{"event":"step_update","step_update":{"conversation_id":"__CONV__","step_index":0,"state":"DONE","step_type":"user_input"}}"#,
        );
        let mut mapper = TurnMapper::new(CONV, true);
        let first = mapper.on_step(&step);
        assert_eq!(first.len(), 1);
        let note = chunk_text(&first[0]).expect("the note is a chunk");
        assert_eq!(note, AUTO_APPROVE_NOTE);
        assert!(note.ends_with("\n\n"));
        assert_eq!(mapper.on_step(&step).len(), 0, "note is emitted once");

        let mut loaded = TurnMapper::new(CONV, false);
        assert_eq!(loaded.on_step(&step).len(), 0, "no note on load/respawn");
    }

    #[test]
    fn tool_presentation_table() {
        let params = |v: Value| v;
        let (title, kind, locs) = tool_presentation(
            "run_command",
            &params(serde_json::json!({"CommandLine":"ls -la"})),
        );
        assert_eq!(
            (title.as_str(), kind, locs.len()),
            ("ls -la", ToolKind::Execute, 0)
        );
        let (title, kind, _) = tool_presentation("run_command", &Value::Null);
        assert_eq!((title.as_str(), kind), ("run_command", ToolKind::Execute));

        let (title, kind, locs) = tool_presentation(
            "view_file",
            &params(serde_json::json!({"AbsolutePath":"/tmp/a.rs"})),
        );
        assert_eq!((title.as_str(), kind), ("view_file", ToolKind::Read));
        assert_eq!(locs[0].path, PathBuf::from("/tmp/a.rs"));

        for tool in [
            "write_to_file",
            "replace_file_content",
            "multi_replace_file_content",
            "sed_file",
            "notebook_edit",
        ] {
            let (title, kind, locs) =
                tool_presentation(tool, &params(serde_json::json!({"TargetFile":"src/x.rs"})));
            assert_eq!((title.as_str(), kind), (tool, ToolKind::Edit));
            assert_eq!(locs[0].path, PathBuf::from("src/x.rs"));
        }

        for tool in ["grep_search", "find_by_name", "list_dir"] {
            let (title, kind, locs) = tool_presentation(tool, &Value::Null);
            assert_eq!(
                (title.as_str(), kind, locs.len()),
                (tool, ToolKind::Search, 0)
            );
        }

        for tool in ["read_url_content", "search_web"] {
            let (title, kind, locs) = tool_presentation(tool, &Value::Null);
            assert_eq!(
                (title.as_str(), kind, locs.len()),
                (tool, ToolKind::Fetch, 0)
            );
        }

        let (title, kind, locs) = tool_presentation(
            "call_mcp_tool",
            &params(serde_json::json!({"ServerName":"srv","ToolName":"tool"})),
        );
        assert_eq!(
            (title.as_str(), kind, locs.len()),
            ("srv: tool", ToolKind::Other, 0)
        );

        let (title, kind, locs) = tool_presentation("call_mcp_tool", &Value::Null);
        assert_eq!(
            (title.as_str(), kind, locs.len()),
            ("call_mcp_tool", ToolKind::Other, 0)
        );

        let (title, kind, locs) = tool_presentation("mystery_tool", &Value::Null);
        assert_eq!(
            (title.as_str(), kind, locs.len()),
            ("mystery_tool", ToolKind::Other, 0)
        );
    }

    fn parse_step_line(line: &str) -> Step {
        match parse_line(line) {
            Some(Inbound::Step(step)) => step,
            other => panic!("expected a step, got {other:?}"),
        }
    }

    fn parse_result_line(line: &str) -> AgyResult {
        match parse_line(line) {
            Some(Inbound::Result(result)) => result,
            other => panic!("expected a result, got {other:?}"),
        }
    }

    /// Steps of the real-shaped file-tool fixture, keyed by (index, state).
    fn file_tool_step(index: i64, state: &str) -> Step {
        include_str!("../tests/fixtures/turn_file_tools.jsonl")
            .lines()
            .filter_map(parse_line)
            .find_map(|frame| match frame {
                Inbound::Step(step)
                    if step.step_index == index
                        && step.step_type == StepType::Tool
                        && format!("{:?}", step.state).eq_ignore_ascii_case(state) =>
                {
                    Some(step)
                }
                _ => None,
            })
            .expect("fixture step")
    }

    fn tool_call_of(update: &SessionUpdate) -> &ToolCall {
        match update {
            SessionUpdate::ToolCall(call) => call,
            other => panic!("expected ToolCall, got {other:?}"),
        }
    }

    #[test]
    fn real_file_tool_lines_map_to_kinds_titles_and_locations() {
        let mut mapper = TurnMapper::new(CONV, false);
        let hello = PathBuf::from("/tmp/x/hello.txt");
        for (index, kind, title) in [
            (2, ToolKind::Edit, "write_file"),
            (4, ToolKind::Edit, "edit_file"),
            (6, ToolKind::Read, "read_file"),
        ] {
            let updates = mapper.on_step(&file_tool_step(index, "active"));
            let call = tool_call_of(&updates[0]);
            assert_eq!((call.kind, call.title.as_str()), (kind, title));
            assert_eq!(call.locations[0].path, hello);
        }
        let updates = mapper.on_step(&file_tool_step(8, "active"));
        let call = tool_call_of(&updates[0]);
        assert_eq!(call.title, "playwright: browser_navigate");
        assert_eq!(call.kind, ToolKind::Other);
        assert_eq!(call.locations.len(), 0);
    }

    #[test]
    fn edit_lookup_only_for_done_write_and_edit_tools() {
        let mapper = TurnMapper::new(CONV, false);
        assert!(mapper.edit_lookup(&file_tool_step(2, "active")).is_none());
        let write = mapper.edit_lookup(&file_tool_step(2, "done")).unwrap();
        assert_eq!(
            (write.tool_name.as_str(), write.path.as_str()),
            ("write_file", "/tmp/x/hello.txt")
        );
        assert!(mapper.edit_lookup(&file_tool_step(4, "done")).is_some());
        assert!(mapper.edit_lookup(&file_tool_step(6, "done")).is_none());
        assert!(mapper.edit_lookup(&file_tool_step(8, "done")).is_none());
        let other = TurnMapper::new("another", false);
        assert!(other.edit_lookup(&file_tool_step(2, "done")).is_none());
    }

    fn diff_of(update: &SessionUpdate) -> Option<&Diff> {
        tool_update_fields(update)?
            .fields
            .content
            .as_ref()?
            .iter()
            .find_map(|item| match item {
                ToolCallContent::Diff(diff) => Some(diff),
                _ => None,
            })
    }

    #[test]
    fn resolved_edit_adds_a_diff_and_marks_the_call_consumed() {
        let mut mapper = TurnMapper::new(CONV, false);
        let done = file_tool_step(4, "done");
        let resolved = ResolvedEdit {
            key: (3, 0),
            path: "/tmp/x/hello.txt".into(),
            pieces: vec![DiffPiece {
                old_text: Some("hi".into()),
                new_text: "bye".into(),
                starts: Some((3, 3)),
            }],
        };
        let updates = mapper.on_step_with_edit(&done, Some(resolved));
        let update = tool_update_fields(&updates[1]).unwrap();
        assert_eq!(update.fields.status, Some(ToolCallStatus::Completed));
        let diff = diff_of(&updates[1]).expect("a diff");
        assert_eq!(diff.path, PathBuf::from("/tmp/x/hello.txt"));
        assert_eq!(diff.old_text.as_deref(), Some("hi"));
        assert_eq!(diff.new_text, "bye");
        let meta = diff.meta.as_ref().expect("line starts in _meta");
        assert_eq!(meta["oldStart"], 3);
        assert_eq!(meta["newStart"], 3);
        assert_eq!(content_text(update), "", "empty output adds no text block");

        let next = mapper.edit_lookup(&file_tool_step(4, "done")).unwrap();
        assert!(next.consumed.contains(&(3, 0)));
    }

    #[test]
    fn unresolved_edit_is_a_plain_completed_update() {
        let mut mapper = TurnMapper::new(CONV, false);
        let updates = mapper.on_step_with_edit(&file_tool_step(2, "done"), None);
        assert!(diff_of(&updates[1]).is_none());
        let update = tool_update_fields(&updates[1]).unwrap();
        assert_eq!(update.fields.status, Some(ToolCallStatus::Completed));
    }

    #[test]
    fn resolved_edit_without_pieces_is_a_diffless_completed_update_and_consumed() {
        let mut mapper = TurnMapper::new(CONV, false);
        let resolved = ResolvedEdit {
            key: (3, 0),
            path: "/tmp/x/hello.txt".into(),
            pieces: Vec::new(),
        };
        let updates = mapper.on_step_with_edit(&file_tool_step(4, "done"), Some(resolved));
        assert!(diff_of(&updates[1]).is_none());
        let update = tool_update_fields(&updates[1]).unwrap();
        assert_eq!(update.fields.status, Some(ToolCallStatus::Completed));
        let next = mapper.edit_lookup(&file_tool_step(4, "done")).unwrap();
        assert!(next.consumed.contains(&(3, 0)));
    }

    #[test]
    fn whole_file_diff_has_no_meta() {
        let mut mapper = TurnMapper::new(CONV, false);
        let resolved = ResolvedEdit {
            key: (1, 0),
            path: "/tmp/x/hello.txt".into(),
            pieces: vec![DiffPiece {
                old_text: None,
                new_text: "hi".into(),
                starts: None,
            }],
        };
        let updates = mapper.on_step_with_edit(&file_tool_step(2, "done"), Some(resolved));
        assert!(diff_of(&updates[1]).unwrap().meta.is_none());
    }
}
