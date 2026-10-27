//! Claude background-task detection — the ONE file that knows the vendored
//! adapter's (0.70.0) unstable task surface (plan Findings F2/F4/F9, gaps K1-K5):
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
//! Everything here is a pure function of one persisted [`NormalizedEvent`]
//! and is tolerant of surrounding text, code fences and malformed input.
//! Vendor text that drifts degrades to "no observation", never an error.

use std::sync::Arc;

use agent_client_protocol::schema::v1::SessionUpdate;
use serde_json::Value;
use vst_tasks::TaskObservation;
use vst_types::{AcpToolKind, NormalizedEvent, NormalizedEventKind, ToolStatus};

use crate::normalize::AcpEnrichHook;
use crate::tool_activity::tool_activity_from_event;

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
