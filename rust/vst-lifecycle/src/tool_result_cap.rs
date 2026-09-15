//! Tool-result size capping — ports `services/toolResultCap.ts`.
//!
//! Invariants:
//! - `TOOL_RESULT_MAX_BYTES = 20_000`
//! - content > max → replaced with `(tool result omitted — N bytes)`; byte
//!   count measured as UTF-8 bytes (TS `.length` is UTF-16 code units, but all
//!   content in practice is ASCII — the TS tests use ASCII strings too).
//! - `is_error` is preserved on the replaced `ToolResult`.
//! - `tool_diffs`: cap `new_text` when > max; also drop `old_text` when > max.
//! - Non-tool_result events and events with absent/empty content: no-op.

use vst_types::domain::{NormalizedEvent, NormalizedEventKind, ToolResult};

pub const TOOL_RESULT_MAX_BYTES: usize = 20_000;

/// Cap oversized `tool_result` content and `tool_diffs` in-place.
pub fn cap_tool_result_content(ev: &mut NormalizedEvent) {
    if ev.kind != NormalizedEventKind::ToolResult {
        return;
    }

    if let Some(tr) = ev.tool_result.as_mut() {
        if let Some(content) = tr.content.as_ref() {
            let n = content.len();
            if n > TOOL_RESULT_MAX_BYTES {
                let is_error = tr.is_error;
                ev.tool_result = Some(ToolResult {
                    content: Some(format!("(tool result omitted — {n} bytes)")),
                    is_error,
                });
            }
        }
    }

    if let Some(diffs) = ev.tool_diffs.as_mut() {
        for diff in diffs.iter_mut() {
            let new_oversized = diff.new_text.len() > TOOL_RESULT_MAX_BYTES;
            let old_oversized = diff
                .old_text
                .as_ref()
                .map_or(false, |t| t.len() > TOOL_RESULT_MAX_BYTES);

            if new_oversized {
                diff.new_text = format!("(diff omitted — {} bytes)", diff.new_text.len());
                if old_oversized {
                    diff.old_text = None;
                }
            }
        }
    }
}
