//! Behavior contract for `normalize::normalize_session_update` — ports
//! `daemon/src/__tests__/acpNormalize.test.ts` (1.T3).
//!
//! Pure `session/update` → `NormalizedEvent` mapping. Per-CLI quirks go
//! through the optional enrich hook, never by branching on `provider` inside
//! `normalize.rs` (Gotcha #2). No state, no I/O.

use agent_client_protocol::schema::v1::{
    AvailableCommand, AvailableCommandInput, AvailableCommandsUpdate, Content, ContentBlock,
    ContentChunk, CurrentModeUpdate, Diff, ImageContent, Plan, PlanEntry, PlanEntryPriority,
    PlanEntryStatus, SessionUpdate, TextContent, ToolCall, ToolCallContent, ToolCallStatus,
    ToolCallUpdate, ToolCallUpdateFields, UnstructuredCommandInput,
};
use vst_agents::normalize::normalize_session_update;
use vst_types::{NormalizedEvent, NormalizedEventKind, NormalizedEventProvider};

const SID: &str = "sess1";
const PROVIDER: NormalizedEventProvider = NormalizedEventProvider::Claude;

fn norm(update: SessionUpdate) -> Option<NormalizedEvent> {
    normalize_session_update(&update, SID, PROVIDER, None)
}

#[test]
fn maps_agent_message_chunk_to_text_event() {
    let ev = norm(SessionUpdate::AgentMessageChunk(ContentChunk::new(
        ContentBlock::Text(TextContent::new("hi")),
    )));
    let ev = ev.expect("a text chunk should map to a text event");
    assert_eq!(ev.kind, NormalizedEventKind::Text);
    assert_eq!(ev.text.as_deref(), Some("hi"));
    assert_eq!(ev.role, Some(vst_types::Role::Assistant));
}

#[test]
fn maps_agent_thought_chunk_to_thinking_event() {
    let ev = norm(SessionUpdate::AgentThoughtChunk(ContentChunk::new(
        ContentBlock::Text(TextContent::new("hmm")),
    )));
    let ev = ev.expect("a thought chunk should map to a thinking event");
    assert_eq!(ev.kind, NormalizedEventKind::Thinking);
}

#[test]
fn drops_user_message_chunk() {
    let ev = norm(SessionUpdate::UserMessageChunk(ContentChunk::new(
        ContentBlock::Text(TextContent::new("hi")),
    )));
    assert!(
        ev.is_none(),
        "user_message_chunk is daemon-owned; must be dropped"
    );
}

#[test]
fn maps_tool_call_then_tool_call_update_same_tool_id() {
    let tool_use = norm(SessionUpdate::ToolCall(
        ToolCall::new("tc-1", "Bash").raw_input(serde_json::json!({ "command": "ls" })),
    ))
    .expect("tool_call maps to tool_use");
    assert_eq!(tool_use.kind, NormalizedEventKind::ToolUse);
    assert_eq!(tool_use.tool_id.as_deref(), Some("tc-1"));
    assert_eq!(
        tool_use
            .tool_input
            .as_ref()
            .and_then(|v| v.get("command").and_then(|c| c.as_str())),
        Some("ls")
    );

    let tool_result = norm(SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
        "tc-1",
        ToolCallUpdateFields::new()
            .status(ToolCallStatus::Completed)
            .content(vec![ToolCallContent::Content(Content::new(
                ContentBlock::Text(TextContent::new("file1\nfile2")),
            ))]),
    )))
    .expect("tool_call_update maps to tool_result");
    assert_eq!(tool_result.kind, NormalizedEventKind::ToolResult);
    assert_eq!(tool_result.tool_id.as_deref(), Some("tc-1"));
    assert!(tool_result
        .tool_result
        .as_ref()
        .and_then(|t| t.content.as_deref())
        .unwrap_or_default()
        .contains("file1"));
}

#[test]
fn in_progress_tool_call_update_has_no_tool_result() {
    let ev = norm(SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
        "tc-1",
        ToolCallUpdateFields::new().status(ToolCallStatus::InProgress),
    )))
    .expect("an in-progress update still emits an event");
    assert_eq!(ev.kind, NormalizedEventKind::ToolResult);
    assert_eq!(ev.tool_status, Some(vst_types::ToolStatus::InProgress));
    assert!(ev.tool_result.is_none());
}

#[test]
fn agent_message_chunk_with_non_text_block_populates_blocks() {
    let ev = norm(SessionUpdate::AgentMessageChunk(ContentChunk::new(
        ContentBlock::Image(ImageContent::new("abc123", "image/png")),
    )))
    .expect("image chunk maps to a text-kind event with blocks");
    assert_eq!(ev.kind, NormalizedEventKind::Text);
    assert!(ev.text.is_none());
    let blocks = ev.blocks.expect("blocks populated");
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].r#type, vst_types::ContentBlockType::Image);
    assert_eq!(blocks[0].mime_type.as_deref(), Some("image/png"));
    assert_eq!(blocks[0].data.as_deref(), Some("abc123"));
}

#[test]
fn tool_call_with_diff_content_populates_tool_diffs() {
    let ev = norm(SessionUpdate::ToolCall(
        ToolCall::new("tc-2", "Edit").content(vec![ToolCallContent::Diff(
            Diff::new("/a.ts", "new").old_text("old"),
        )]),
    ))
    .expect("tool_call with a diff maps to tool_use");
    let diffs = ev.tool_diffs.expect("toolDiffs populated");
    assert_eq!(diffs.len(), 1);
    assert_eq!(diffs[0].path, "/a.ts");
    assert_eq!(diffs[0].old_text.as_deref(), Some("old"));
    assert_eq!(diffs[0].new_text, "new");
}

#[test]
fn tool_call_with_write_tool_input_populates_tool_diffs_with_empty_old_text() {
    let ev = norm(SessionUpdate::ToolCall(
        ToolCall::new("tc-3", "Write").raw_input(
            serde_json::json!({ "file_path": "/src/index.ts", "content": "console.log('hello');" }),
        ),
    ))
    .expect("tool_call with a write-shaped input maps to tool_use");
    let diffs = ev
        .tool_diffs
        .expect("toolDiffs populated from raw_input fallback");
    assert_eq!(diffs.len(), 1);
    assert_eq!(diffs[0].path, "/src/index.ts");
    assert_eq!(diffs[0].old_text.as_deref(), Some(""));
    assert_eq!(diffs[0].new_text, "console.log('hello');");
}

#[test]
fn tool_call_edit_kind_without_edit_shaped_input_is_treated_as_a_write() {
    // Some ACP agents send `kind: "edit"` with a create/write-shaped raw
    // input (no old_string/oldText/edits) instead of a claude-style write
    // tool name — the TS fallback treats that as a write too.
    let ev = norm(SessionUpdate::ToolCall(
        ToolCall::new("tc-4", "apply_patch")
            .kind(agent_client_protocol::schema::v1::ToolKind::Edit)
            .raw_input(serde_json::json!({ "path": "/b.ts", "text": "whole file" })),
    ))
    .expect("tool_call maps to tool_use");
    let diffs = ev.tool_diffs.expect("toolDiffs populated");
    assert_eq!(diffs[0].path, "/b.ts");
    assert_eq!(diffs[0].old_text.as_deref(), Some(""));
    assert_eq!(diffs[0].new_text, "whole file");
}

#[test]
fn tool_call_edit_kind_with_old_string_input_is_not_treated_as_a_write() {
    // `kind: "edit"` with an edit-shaped input (has old_string/new_string)
    // must NOT be reinterpreted by the write fallback — the `hasEdit` guard
    // exists precisely to keep real edits from being misdetected as writes.
    let ev = norm(SessionUpdate::ToolCall(
        ToolCall::new("tc-5", "apply_patch")
            .kind(agent_client_protocol::schema::v1::ToolKind::Edit)
            .raw_input(
                serde_json::json!({ "file_path": "/c.ts", "old_string": "a", "new_string": "b" }),
            ),
    ))
    .expect("tool_call maps to tool_use");
    assert!(
        ev.tool_diffs.is_none(),
        "an edit-kind tool call with edit-shaped input must not synthesize a write diff"
    );
}

#[test]
fn current_mode_update_maps_to_mode_update() {
    let ev = norm(SessionUpdate::CurrentModeUpdate(CurrentModeUpdate::new(
        "build",
    )))
    .expect("current_mode_update maps to mode_update");
    assert_eq!(ev.kind, NormalizedEventKind::ModeUpdate);
    assert_eq!(ev.mode_id.as_deref(), Some("build"));
}

#[test]
fn available_commands_update_strips_one_leading_slash() {
    let ev = norm(SessionUpdate::AvailableCommandsUpdate(
        AvailableCommandsUpdate::new(vec![AvailableCommand::new("/plan", "Plan mode")]),
    ))
    .expect("available_commands_update maps to commands_update");
    assert_eq!(ev.kind, NormalizedEventKind::CommandsUpdate);
    let cmds = ev.commands.expect("commands populated");
    // Catalog names are BARE — downstream prepends its own "/".
    assert_eq!(cmds.len(), 1);
    assert_eq!(cmds[0].name, "plan");
    assert_eq!(cmds[0].description, "Plan mode");
}

#[test]
fn available_commands_update_preserves_hint_as_argument_hint() {
    let ev = norm(SessionUpdate::AvailableCommandsUpdate(
        AvailableCommandsUpdate::new(vec![
            AvailableCommand::new("code-review", "Review the diff").input(
                AvailableCommandInput::Unstructured(UnstructuredCommandInput::new(
                    "[effort] [target]",
                )),
            ),
            AvailableCommand::new("/plan", "Plan mode"),
        ]),
    ))
    .expect("available_commands_update maps to commands_update");
    let cmds = ev.commands.expect("commands populated");
    assert_eq!(cmds.len(), 2);
    assert_eq!(cmds[0].name, "code-review");
    assert_eq!(cmds[0].description, "Review the diff");
    assert_eq!(cmds[0].argument_hint.as_deref(), Some("[effort] [target]"));
    assert_eq!(cmds[1].name, "plan");
    assert_eq!(cmds[1].description, "Plan mode");
}

#[test]
fn maps_plan_to_status_event() {
    let ev = norm(SessionUpdate::Plan(Plan::new(vec![
        PlanEntry::new("step 1", PlanEntryPriority::High, PlanEntryStatus::Pending),
        PlanEntry::new(
            "step 2",
            PlanEntryPriority::Medium,
            PlanEntryStatus::Pending,
        ),
    ])))
    .expect("plan maps to status");
    assert_eq!(ev.kind, NormalizedEventKind::Status);
    let text = ev.text.expect("status text present");
    assert!(text.contains("step 1"));
    assert!(text.contains("step 2"));
}

#[test]
fn empty_plan_maps_to_status_with_default_text() {
    let ev = norm(SessionUpdate::Plan(Plan::new(vec![]))).expect("empty plan maps to status");
    assert_eq!(ev.kind, NormalizedEventKind::Status);
    assert_eq!(ev.text.as_deref(), Some("plan updated"));
}

#[test]
fn unknown_update_kind_is_dropped_not_thrown() {
    // SessionInfoUpdate / ConfigOptionUpdate / UsageUpdate are not rendered.
    use agent_client_protocol::schema::v1::SessionInfoUpdate;
    let ev = norm(SessionUpdate::SessionInfoUpdate(SessionInfoUpdate::new()));
    assert!(ev.is_none(), "unmapped update kinds are dropped");
}

#[test]
fn the_enrich_hook_can_replace_the_default_mapping() {
    let ev = normalize_session_update(
        &SessionUpdate::Plan(Plan::new(vec![])),
        SID,
        PROVIDER,
        Some(&|_raw, base| {
            let mut replaced = base.clone();
            replaced.text = Some("overridden".to_string());
            Some(replaced)
        }),
    );
    assert_eq!(
        ev.expect("enrich hook should produce an event")
            .text
            .as_deref(),
        Some("overridden")
    );
}
