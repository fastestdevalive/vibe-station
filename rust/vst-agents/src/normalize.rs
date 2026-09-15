//! Pure `session/update` → [`NormalizedEvent`] mapping — ports
//! `daemon/src/services/acp/normalize.ts`. No state, no I/O. Per-CLI quirks
//! are handled by an optional [`AcpEnrichHook`] the plugin supplies, never by
//! branching on `provider` in here (AGENTS.md § Agent plugin / Gotcha #2).
//!
//! `AcpTransport` streams the raw ACP `SessionUpdate` (see
//! `acp_transport.rs`'s doc comment on why that split exists); this module is
//! what turns those into `vst_types::NormalizedEvent`s.
//!
//! The only update kinds that render nothing are those the daemon has no use
//! for (`user_message_chunk` is daemon-owned; `session_info_update`,
//! `config_option_update`, `usage_update` are not rendered) — they count as
//! "handled", not an error.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use agent_client_protocol::schema::v1::{
    AudioContent, AvailableCommand, AvailableCommandInput, Content, ContentBlock, ContentChunk,
    CurrentModeUpdate, Diff, EmbeddedResource, ImageContent, Plan, ResourceLink, SessionUpdate,
    TextContent, ToolCall, ToolCallContent, ToolCallLocation, ToolCallStatus, ToolCallUpdate,
    ToolKind, UnstructuredCommandInput,
};
use vst_types::{
    AcpToolKind, ContentBlockType, NormalizedContentBlock, NormalizedEvent, NormalizedEventKind,
    NormalizedEventProvider, Role, ToolDiff, ToolLocation, ToolStatus,
};

/// Per-plugin enrichment hook: given the raw update and the event this module
/// already produced, optionally return a REPLACEMENT event (e.g. mapping a
/// claude-specific `plan` update onto a richer `status`). Return `None` to
/// accept the default mapping unchanged.
pub type AcpEnrichHook =
    dyn Fn(&SessionUpdate, &NormalizedEvent) -> Option<NormalizedEvent> + Send + Sync;

static EVENT_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Generate a unique id for a normalized event (the TS uses `randomUUID()`).
fn event_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let n = EVENT_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{nanos:x}-{n:x}")
}

/// Gap 1 — single-block mapper for `agent_message_chunk`/`agent_thought_chunk`.
/// Text-only content is unchanged: `{ text }`, no `blocks` field, matching the
/// TS exactly.
fn to_normalized_block(block: &ContentBlock) -> Option<NormalizedContentBlock> {
    match block {
        ContentBlock::Text(TextContent { text, .. }) => Some(NormalizedContentBlock {
            r#type: ContentBlockType::Text,
            text: Some(text.clone()),
            mime_type: None,
            data: None,
            uri: None,
            name: None,
        }),
        ContentBlock::Image(ImageContent {
            mime_type, data, ..
        }) => Some(NormalizedContentBlock {
            r#type: ContentBlockType::Image,
            text: None,
            mime_type: Some(mime_type.clone()),
            data: Some(data.clone()),
            uri: None,
            name: None,
        }),
        ContentBlock::Audio(AudioContent {
            mime_type, data, ..
        }) => Some(NormalizedContentBlock {
            r#type: ContentBlockType::Audio,
            text: None,
            mime_type: Some(mime_type.clone()),
            data: Some(data.clone()),
            uri: None,
            name: None,
        }),
        ContentBlock::ResourceLink(ResourceLink {
            uri,
            name,
            mime_type,
            ..
        }) => Some(NormalizedContentBlock {
            r#type: ContentBlockType::ResourceLink,
            text: None,
            mime_type: mime_type.clone(),
            data: None,
            uri: Some(uri.clone()),
            name: Some(name.clone()),
        }),
        ContentBlock::Resource(EmbeddedResource { resource, .. }) => {
            // TS reads the nested resource's `uri` and optional `mimeType`.
            let (uri, mime_type) = match resource {
                agent_client_protocol::schema::v1::EmbeddedResourceResource::TextResourceContents(
                    t,
                ) => (Some(t.uri.clone()), t.mime_type.clone()),
                agent_client_protocol::schema::v1::EmbeddedResourceResource::BlobResourceContents(
                    b,
                ) => (Some(b.uri.clone()), b.mime_type.clone()),
                _ => (None, None),
            };
            Some(NormalizedContentBlock {
                r#type: ContentBlockType::Resource,
                text: None,
                mime_type,
                data: None,
                uri,
                name: None,
            })
        }
        _ => None,
    }
}

/// `contentFromChunk`: returns `(text, blocks)` where exactly one is `Some` for
/// a mappable block and both are `None` when the block maps to nothing.
fn content_from_chunk(
    block: &ContentBlock,
) -> (Option<String>, Option<Vec<NormalizedContentBlock>>) {
    match to_normalized_block(block) {
        Some(mapped) if mapped.r#type == ContentBlockType::Text => (mapped.text, None),
        Some(mapped) => (None, Some(vec![mapped])),
        None => (None, None),
    }
}

/// Unwrap one `ToolCallContent` entry: `{type:"content",content}` → the inner
/// `ContentBlock`; other entries are returned as-is.
fn unwrap_tool_call_content(entry: &ToolCallContent) -> Option<&ContentBlock> {
    match entry {
        ToolCallContent::Content(Content { content, .. }) => Some(content),
        _ => None,
    }
}

/// Extract `{type:"diff"}` entries from a `tool_call`/`tool_call_update.content`
/// array.
fn tool_diffs_from_content(content: &[ToolCallContent]) -> Option<Vec<ToolDiff>> {
    let diffs: Vec<ToolDiff> = content
        .iter()
        .filter_map(|entry| match entry {
            ToolCallContent::Diff(Diff {
                path,
                old_text,
                new_text,
                ..
            }) => Some(ToolDiff {
                path: path.to_string_lossy().into_owned(),
                old_text: old_text.clone(),
                new_text: new_text.clone(),
            }),
            _ => None,
        })
        .collect();
    if diffs.is_empty() {
        None
    } else {
        Some(diffs)
    }
}

/// Extract text blocks from a `tool_call`/`tool_call_update.content` array
/// (existing behavior).
fn text_from_tool_call_content(content: &[ToolCallContent]) -> Option<String> {
    let parts: Vec<String> = content
        .iter()
        .filter_map(unwrap_tool_call_content)
        .filter_map(|block| content_from_chunk(block).0)
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

/// `tool_call`/`tool_call_update.locations` → `toolLocations`.
fn tool_locations_from(raw: &[ToolCallLocation]) -> Option<Vec<ToolLocation>> {
    if raw.is_empty() {
        return None;
    }
    Some(
        raw.iter()
            .map(|loc| ToolLocation {
                path: loc.path.to_string_lossy().into_owned(),
                line: loc.line.map(i64::from),
            })
            .collect(),
    )
}

/// ACP `ToolKind` → `AcpToolKind`, or `None` for the catch-all `other` / future
/// kinds.
fn tool_kind_from(kind: &ToolKind) -> Option<AcpToolKind> {
    match kind {
        ToolKind::Read => Some(AcpToolKind::Read),
        ToolKind::Edit => Some(AcpToolKind::Edit),
        ToolKind::Delete => Some(AcpToolKind::Delete),
        ToolKind::Move => Some(AcpToolKind::Move),
        ToolKind::Search => Some(AcpToolKind::Search),
        ToolKind::Execute => Some(AcpToolKind::Execute),
        ToolKind::Think => Some(AcpToolKind::Think),
        ToolKind::Fetch => Some(AcpToolKind::Fetch),
        ToolKind::SwitchMode => Some(AcpToolKind::SwitchMode),
        ToolKind::Other | _ => None,
    }
}

/// ACP `ToolCallStatus` → `ToolStatus`, or `None` when not one of the four.
fn tool_status_from(status: &ToolCallStatus) -> Option<ToolStatus> {
    match status {
        ToolCallStatus::Pending => Some(ToolStatus::Pending),
        ToolCallStatus::InProgress => Some(ToolStatus::InProgress),
        ToolCallStatus::Completed => Some(ToolStatus::Completed),
        ToolCallStatus::Failed => Some(ToolStatus::Failed),
        _ => None,
    }
}

/// True iff the raw_input value is "empty" (null, or an object with no keys) —
/// the TS's `refinedInput` guard.
fn is_empty_input(value: &serde_json::Value) -> bool {
    matches!(value, serde_json::Value::Null)
        || matches!(value, serde_json::Value::Object(m) if m.is_empty())
}

/// Map ONE `session/update` payload into zero-or-one `NormalizedEvent`. Returns
/// `None` for update kinds this daemon has nothing useful to render.
pub fn normalize_session_update(
    update: &SessionUpdate,
    session_id: &str,
    provider: NormalizedEventProvider,
    enrich: Option<&AcpEnrichHook>,
) -> Option<NormalizedEvent> {
    let stamp = |kind: NormalizedEventKind, extra: NormalizedEvent| {
        let mut ev = extra;
        ev.id = event_id();
        ev.session_id = session_id.to_string();
        ev.ts = iso_now();
        ev.provider = provider;
        ev.kind = kind;
        ev
    };
    let base: Option<NormalizedEvent>;

    match update {
        SessionUpdate::AgentMessageChunk(ContentChunk { content, .. }) => {
            let (text, blocks) = content_from_chunk(content);
            if text.is_none() && blocks.is_none() {
                return None;
            }
            let mut ev = NormalizedEvent::default();
            ev.role = Some(Role::Assistant);
            ev.text = text;
            ev.blocks = blocks;
            base = Some(stamp(NormalizedEventKind::Text, ev));
        }
        SessionUpdate::AgentThoughtChunk(ContentChunk { content, .. }) => {
            let (text, blocks) = content_from_chunk(content);
            if text.is_none() && blocks.is_none() {
                return None;
            }
            let mut ev = NormalizedEvent::default();
            ev.role = Some(Role::Assistant);
            ev.text = text;
            ev.blocks = blocks;
            base = Some(stamp(NormalizedEventKind::Thinking, ev));
        }
        SessionUpdate::UserMessageChunk(_) => {
            // Daemon-owned in the existing model — the daemon already
            // synthesizes `user` events at enqueue time, so an agent-echoed
            // user chunk is redundant. Skip it rather than double-rendering.
            return None;
        }
        SessionUpdate::ToolCall(ToolCall {
            tool_call_id,
            title,
            kind,
            status,
            content,
            locations,
            raw_input,
            ..
        }) => {
            let tool_name = if !title.is_empty() {
                Some(title.clone())
            } else {
                None
            };
            let mut ev = NormalizedEvent::default();
            ev.role = Some(Role::Assistant);
            ev.tool_id = Some(tool_call_id.to_string());
            ev.tool_name = tool_name;
            ev.tool_input = raw_input.clone();
            ev.tool_locations = tool_locations_from(locations);
            ev.tool_kind = tool_kind_from(kind);
            ev.tool_diffs = tool_diffs_from_content(content);
            ev.tool_status = tool_status_from(status);
            base = Some(stamp(NormalizedEventKind::ToolUse, ev));
        }
        SessionUpdate::ToolCallUpdate(ToolCallUpdate {
            tool_call_id,
            fields,
            ..
        }) => {
            let status =
                tool_status_from(fields.status.as_ref().unwrap_or(&ToolCallStatus::Pending));
            let text = text_from_tool_call_content(fields.content.as_deref().unwrap_or_default());
            // Propagate rawInput from refinement events; a non-empty object is
            // the refined input, otherwise leave it unset.
            let refined_input = fields.raw_input.clone().filter(|v| !is_empty_input(v));
            let tool_result = fields.content.as_ref().map(|_| vst_types::ToolResult {
                content: text.clone(),
                is_error: Some(fields.status.as_ref() == Some(&ToolCallStatus::Failed)),
            });
            let mut ev = NormalizedEvent::default();
            ev.tool_id = Some(tool_call_id.to_string());
            ev.tool_input = refined_input;
            ev.tool_result = tool_result;
            ev.tool_status = status;
            ev.tool_diffs = tool_diffs_from_content(fields.content.as_deref().unwrap_or_default());
            ev.tool_locations =
                tool_locations_from(fields.locations.as_deref().unwrap_or_default());
            ev.tool_kind = fields.kind.as_ref().and_then(tool_kind_from);
            base = Some(stamp(NormalizedEventKind::ToolResult, ev));
        }
        SessionUpdate::CurrentModeUpdate(CurrentModeUpdate {
            current_mode_id, ..
        }) => {
            let mut ev = NormalizedEvent::default();
            ev.mode_id = Some(current_mode_id.to_string());
            base = Some(stamp(NormalizedEventKind::ModeUpdate, ev));
        }
        SessionUpdate::AvailableCommandsUpdate(update) => {
            let commands: Vec<vst_types::Command> = update
                .available_commands
                .iter()
                .map(map_available_command)
                .collect();
            let mut ev = NormalizedEvent::default();
            ev.commands = Some(commands);
            base = Some(stamp(NormalizedEventKind::CommandsUpdate, ev));
        }
        SessionUpdate::Plan(Plan { entries, .. }) => {
            let summary: Vec<String> = entries
                .iter()
                .map(|e| e.content.clone())
                .filter(|c| !c.is_empty())
                .collect();
            let text = if summary.is_empty() {
                "plan updated".to_string()
            } else {
                summary.join("; ")
            };
            let mut ev = NormalizedEvent::default();
            ev.text = Some(text);
            base = Some(stamp(NormalizedEventKind::Status, ev));
        }
        SessionUpdate::SessionInfoUpdate(_)
        | SessionUpdate::ConfigOptionUpdate(_)
        | SessionUpdate::UsageUpdate(_) => return None,
        // `#[non_exhaustive]` — unknown future update kinds are dropped, not
        // thrown, matching the TS default arm.
        _ => return None,
    }

    let base = base?;
    let enriched = enrich.and_then(|hook| hook(update, &base));
    Some(enriched.unwrap_or(base))
}

fn map_available_command(command: &AvailableCommand) -> vst_types::Command {
    // Strip ONE leading "/" here — the single choke point where an ACP command
    // entry is built. Names flow downstream into a catalog of BARE names
    // (matchLongestName prepends its own "/").
    let raw_name = command.name.clone();
    let name = raw_name.strip_prefix('/').unwrap_or(&raw_name).to_string();
    let argument_hint = match &command.input {
        Some(AvailableCommandInput::Unstructured(UnstructuredCommandInput { hint, .. })) => {
            Some(hint.clone())
        }
        _ => None,
    };
    vst_types::Command {
        name,
        description: command.description.clone(),
        argument_hint,
    }
}

/// ISO8601 timestamp (the daemon stamps events itself; normalize only needs a
/// well-formed value).
fn iso_now() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    let millis = (now.subsec_millis()) as i64;
    // Naive UTC ISO8601 with millis — sufficient for a stamped value.
    format!("{secs}.{millis:03}Z")
}
