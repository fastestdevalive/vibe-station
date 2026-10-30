//! Claude background-task detection — the ONE file that knows the vendored
//! adapter's (0.98.0) unstable task surface (plan Findings F2/F4/F9, gaps K1-K5):
//!
//! - background Bash: the launch is a tool call whose PERSISTED input has
//!   `command` + `run_in_background: true`; the confirmation is free text in
//!   the tool result ("Command running in background with ID: <id>. Output is
//!   being written to: <path>. ..."). There is no end signal (K1).
//! - subagents (`Task`/`Agent`): keyed on the input shape (`subagent_type`),
//!   NOT the tool name — the normalized `tool_name` is the ACP title (the
//!   command / the description), not the tool's name (F9). Nested calls carry
//!   `parent_tool_use_id` (set by [`claude_enrich_hook`]).
//!
//! - a turn that spawned BACKGROUND subagents is held open by the adapter
//!   (`Turn.deferredSettle` / `turnAwaitingSubagents(turn)`) until they settle,
//!   so that turn's persisted `Result` marks their end: it yields
//!   [`TaskObservation::TurnSettled`]. Limits of this inference (the persisted
//!   `Result` row has no stop reason / `is_error` / cancelled field, so they
//!   cannot be told apart here): (1) a `Result` from a turn that ended
//!   `cancelled`, `refusal` or `max_tokens` also settles; the adapter has
//!   interrupted/ended the query then, so its subagents are over, but they are
//!   marked `Done` rather than `Stopped`. (2) A failed turn emits an `error`
//!   row and no `Result`, and a user cancel emits none either; their background
//!   subagents then end by the 10 min stale bound. (3) This relies on our ACP
//!   client NOT declaring the adapter's `backgroundSubagents` capability: such
//!   a client's turns end at their `Result` while subagents keep running, and
//!   `TurnSettled` would then end them early. Revisit if that is ever declared.
//!
//! - raw SDK task messages (structured, authoritative): `acp_meta` opts the
//!   adapter into `emitRawSDKMessages` ([`CLAUDE_RAW_SDK_FILTER`]); it then
//!   forwards each matching SDK message verbatim as the ext notification
//!   `_claude/sdkMessage {sessionId, message}`. [`claude_task_signal_event`]
//!   whitelists one into a persisted `task_signal` row and
//!   [`claude_task_observations`] turns that row into `Confirmed` / `Ended`
//!   (running / paused / over, per task). This is NOT the AIR `async_task_*`
//!   path: declaring any AIR capability would rewrite every tool-call shape we
//!   normalize (see `acp_connection.rs`). Fixtures under
//!   `tests/fixtures/claude_tasks/raw_*.json` were captured from the REAL
//!   adapter by `scripts/claude-acp-raw-harness`. `TurnSettled` stays as the
//!   fallback when the raw signals are missing (older adapter, filter ignored):
//!   the registry skips subagents the raw signals already confirmed
//!   (authoritative), so only the structured `Ended` decides those.
//!
//! Everything here is a pure function of one persisted [`NormalizedEvent`]
//! and is tolerant of surrounding text, code fences and malformed input.
//! Vendor text that drifts degrades to "no observation", never an error.

use std::sync::Arc;

use agent_client_protocol::schema::v1::SessionUpdate;
use serde_json::Value;
use vst_tasks::TaskObservation;
use vst_types::{
    AcpToolKind, NormalizedEvent, NormalizedEventKind, NormalizedEventProvider, TaskState,
    ToolStatus,
};

use crate::normalize::AcpEnrichHook;
use crate::tool_activity::tool_activity_from_event;

/// `_meta.claudeCode.emitRawSDKMessages` filter: the three task lifecycle SDK
/// messages (`{type, subtype}` equality in the adapter's `shouldEmitRawMessage`).
pub const CLAUDE_RAW_SDK_FILTER: &str = r#"[
  {"type":"system","subtype":"task_started"},
  {"type":"system","subtype":"task_updated"},
  {"type":"system","subtype":"task_notification"}]"#;

/// Wire method of a forwarded raw SDK message.
const RAW_SDK_METHOD: &str = "_claude/sdkMessage";

const ID_MARKER: &str = "running in background with id:";
const PATH_MARKER: &str = "output is being written to:";

/// Enrich hook copying `_meta.claudeCode.parentToolUseId` onto
/// `parent_tool_use_id`. Touches nothing else (in particular not `tool_name`).
#[must_use]
pub fn claude_enrich_hook() -> Arc<AcpEnrichHook> {
    Arc::new(|update: &SessionUpdate, ev: &NormalizedEvent| {
        let meta = match update {
            SessionUpdate::ToolCall(c) => c.meta.as_ref(),
            SessionUpdate::ToolCallUpdate(u) => u.meta.as_ref(),
            _ => None,
        }?;
        let parent = meta
            .get("claudeCode")?
            .get("parentToolUseId")?
            .as_str()
            .filter(|s| !s.is_empty())?;
        let mut enriched = ev.clone();
        enriched.parent_tool_use_id = Some(parent.to_string());
        Some(enriched)
    })
}

/// All task observations for one persisted event.
#[must_use]
pub fn claude_task_observations(ev: &NormalizedEvent) -> Vec<TaskObservation> {
    let mut out = Vec::new();
    if ev.kind == NormalizedEventKind::TaskSignal {
        return signal_observations(ev);
    }
    if ev.kind == NormalizedEventKind::Result {
        return vec![TaskObservation::TurnSettled];
    }
    if !matches!(
        ev.kind,
        NormalizedEventKind::ToolUse | NormalizedEventKind::ToolResult
    ) {
        return out;
    }
    let Some(tool_id) = ev.tool_id.as_deref().filter(|t| !t.is_empty()) else {
        return out;
    };

    // Nested call under a subagent: a line for that subagent's activity log.
    if ev.kind == NormalizedEventKind::ToolUse {
        if let Some(parent) = ev.parent_tool_use_id.as_deref().filter(|p| !p.is_empty()) {
            if let Some(act) = tool_activity_from_event(ev) {
                let line = match act.detail {
                    Some(d) if !d.is_empty() => format!("{} {}", act.name, d),
                    _ => act.name,
                };
                out.push(TaskObservation::SubagentNested {
                    parent_tool_id: parent.to_string(),
                    line,
                });
            }
        }
    }

    if let Some(input) = ev.tool_input.as_ref().and_then(Value::as_object) {
        if let Some(command) = background_command(ev, input) {
            out.push(TaskObservation::CommandLaunched {
                tool_id: tool_id.to_string(),
                command,
            });
        }
        // A nested call is never itself a subagent launch we track.
        if ev.parent_tool_use_id.is_none() {
            if let Some(sub) = subagent_start(ev, tool_id, input) {
                out.push(sub);
            }
        }
    }

    if ev.kind == NormalizedEventKind::ToolResult {
        let text = ev.tool_result.as_ref().and_then(|r| {
            if r.is_error == Some(true) {
                None
            } else {
                r.content.as_deref()
            }
        });
        if let Some((task_id, output_path)) = text.and_then(parse_background_marker) {
            out.push(TaskObservation::CommandBackgrounded {
                tool_id: tool_id.to_string(),
                task_id,
                output_path,
            });
        }
        if matches!(
            ev.tool_status,
            Some(ToolStatus::Completed | ToolStatus::Failed)
        ) {
            out.push(TaskObservation::SubagentFinished {
                tool_id: tool_id.to_string(),
                ok: ev.tool_status == Some(ToolStatus::Completed)
                    && ev.tool_result.as_ref().and_then(|r| r.is_error) != Some(true),
                final_text: ev.tool_result.as_ref().and_then(|r| r.content.clone()),
            });
        }
    }
    out
}

/// `Some(command)` for a Bash-shaped call with `run_in_background: true`.
/// The tool kind is `execute` on the first update but absent on refinements,
/// so an absent kind is accepted; any other explicit kind is not Bash.
fn background_command(
    ev: &NormalizedEvent,
    input: &serde_json::Map<String, Value>,
) -> Option<String> {
    if ev.tool_kind.is_some_and(|k| k != AcpToolKind::Execute) {
        return None;
    }
    if input.get("run_in_background")?.as_bool() != Some(true) {
        return None;
    }
    let command = input.get("command")?.as_str()?.trim();
    (!command.is_empty()).then(|| command.to_string())
}

fn subagent_start(
    ev: &NormalizedEvent,
    tool_id: &str,
    input: &serde_json::Map<String, Value>,
) -> Option<TaskObservation> {
    input
        .get("subagent_type")?
        .as_str()
        .filter(|s| !s.trim().is_empty())?;
    let label = input
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            ev.tool_name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })
        .unwrap_or("Subagent");
    Some(TaskObservation::SubagentStarted {
        tool_id: tool_id.to_string(),
        label: label.to_string(),
        background: input.get("run_in_background").and_then(Value::as_bool) == Some(true),
    })
}

/// Parse the adapter's background-launch confirmation. Exactly one id marker
/// is required (two ids are ambiguous -> nothing); the path is optional.
fn parse_background_marker(text: &str) -> Option<(String, Option<String>)> {
    // ASCII lowercasing keeps byte offsets valid for slicing `text`.
    let lower = text.to_ascii_lowercase();
    if lower.matches(ID_MARKER).count() != 1 {
        return None;
    }
    let at = lower.find(ID_MARKER)? + ID_MARKER.len();
    let id: String = text[at..]
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    if id.is_empty() {
        return None;
    }
    let path = lower.find(PATH_MARKER).and_then(|p| {
        let rest = text[p + PATH_MARKER.len()..]
            .trim_start_matches(|c: char| c.is_whitespace() || matches!(c, '`' | '"' | '\''));
        let end = rest
            .find(|c: char| c.is_whitespace() || matches!(c, '`' | '"' | '\''))
            .unwrap_or(rest.len());
        let path = rest[..end].trim_end_matches(['.', ',', ';', ':', ')', ']']);
        (!path.is_empty()).then(|| path.to_string())
    });
    Some((id, path))
}

fn clip_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// Copy a clipped string field `key` from `src` to `dst` when present.
fn copy_str(
    src: &serde_json::Map<String, Value>,
    dst: &mut serde_json::Map<String, Value>,
    key: &str,
    max: usize,
) {
    if let Some(v) = src.get(key).and_then(Value::as_str) {
        dst.insert(key.to_string(), Value::String(clip_chars(v, max)));
    }
}

fn copy_bool(
    src: &serde_json::Map<String, Value>,
    dst: &mut serde_json::Map<String, Value>,
    key: &str,
) {
    if let Some(v) = src.get(key).and_then(Value::as_bool) {
        dst.insert(key.to_string(), Value::Bool(v));
    }
}

/// A `task_signal` row from one `_claude/sdkMessage` ext notification, or
/// `None` for any other method / message. Only a whitelist of fields is kept
/// (never `prompt`, `usage`, `resource_links`, `uuid`, `session_id`). The
/// session stamps id / ts / turn on the returned event.
#[must_use]
pub fn claude_task_signal_event(method: &str, params: &Value) -> Option<NormalizedEvent> {
    if method != RAW_SDK_METHOD {
        return None;
    }
    let msg = params.get("message")?.as_object()?;
    if msg.get("type")?.as_str()? != "system" {
        return None;
    }
    let subtype = msg.get("subtype")?.as_str()?;
    if !matches!(
        subtype,
        "task_started" | "task_updated" | "task_notification"
    ) {
        return None;
    }
    let task_id = msg.get("task_id")?.as_str().filter(|s| !s.is_empty())?;
    let mut sig = serde_json::Map::new();
    sig.insert("subtype".into(), Value::String(subtype.to_string()));
    sig.insert("task_id".into(), Value::String(clip_chars(task_id, 128)));
    for key in ["tool_use_id", "task_type", "status", "reason"] {
        copy_str(msg, &mut sig, key, 128);
    }
    copy_str(msg, &mut sig, "output_file", 512);
    copy_str(msg, &mut sig, "description", 200);
    copy_str(msg, &mut sig, "summary", 500);
    for key in ["is_backgrounded", "ambient", "skip_transcript"] {
        copy_bool(msg, &mut sig, key);
    }
    if let Some(patch) = msg.get("patch").and_then(Value::as_object) {
        let mut p = serde_json::Map::new();
        copy_str(patch, &mut p, "status", 64);
        copy_bool(patch, &mut p, "is_backgrounded");
        copy_str(patch, &mut p, "error", 500);
        copy_str(patch, &mut p, "description", 200);
        sig.insert("patch".into(), Value::Object(p));
    }
    Some(NormalizedEvent {
        provider: NormalizedEventProvider::Claude,
        kind: NormalizedEventKind::TaskSignal,
        task_signal: Some(Value::Object(sig)),
        ..NormalizedEvent::default()
    })
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// Observations for one persisted `task_signal` row (plan A-D6). Tolerant:
/// anything unexpected yields none, which leaves the OS-probe fallback in charge.
fn signal_observations(ev: &NormalizedEvent) -> Vec<TaskObservation> {
    let Some(sig) = ev.task_signal.as_ref() else {
        return Vec::new();
    };
    let (Some(subtype), Some(id)) = (str_of(sig, "subtype"), str_of(sig, "task_id")) else {
        return Vec::new();
    };
    let id = id.to_string();
    let flag = |v: &Value, k: &str| v.get(k).and_then(Value::as_bool) == Some(true);
    let end_state = |s: &str| match s {
        "completed" => Some(TaskState::Done),
        "failed" => Some(TaskState::Failed),
        "killed" | "stopped" => Some(TaskState::Stopped),
        _ => None,
    };
    match subtype {
        "task_started" => {
            if flag(sig, "ambient") || flag(sig, "skip_transcript") {
                return Vec::new();
            }
            let tool_id = str_of(sig, "tool_use_id").map(str::to_string);
            let confirm = match str_of(sig, "task_type") {
                Some("local_bash") => flag(sig, "is_backgrounded"),
                Some("local_agent") => tool_id.is_some(),
                _ => false,
            };
            if confirm {
                vec![TaskObservation::Confirmed {
                    id,
                    tool_id,
                    paused: false,
                }]
            } else {
                Vec::new()
            }
        }
        "task_updated" => {
            let Some(patch) = sig.get("patch") else {
                return Vec::new();
            };
            let status = str_of(patch, "status");
            if let Some(state) = status.filter(|s| *s != "stopped").and_then(end_state) {
                let reason = (state == TaskState::Failed)
                    .then(|| str_of(patch, "error").map(str::to_string))
                    .flatten();
                return vec![TaskObservation::Ended {
                    id,
                    tool_id: None,
                    state,
                    reason,
                }];
            }
            let paused = status == Some("paused");
            if paused
                || matches!(status, Some("pending" | "running"))
                || flag(patch, "is_backgrounded")
            {
                vec![TaskObservation::Confirmed {
                    id,
                    tool_id: None,
                    paused,
                }]
            } else {
                Vec::new()
            }
        }
        "task_notification" => match str_of(sig, "status").and_then(end_state) {
            Some(state) => vec![TaskObservation::Ended {
                id,
                tool_id: str_of(sig, "tool_use_id").map(str::to_string),
                state,
                reason: None,
            }],
            None => Vec::new(),
        },
        _ => Vec::new(),
    }
}
