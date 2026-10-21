//! Activity reporting for a Rich Chat session.
//!
//! Every in-band event that proves the agent is alive is reported to the
//! daemon-wide `ActivitySink` (throttling, persistence and broadcast live in
//! `vst-activity`). Only the tool call is carried; no message text is captured.

use std::sync::Arc;

use vst_types::activity::{ActivitySink, ToolActivity};
use vst_types::{NormalizedEvent, NormalizedEventKind, Role};

use super::JsonAgentSession;
use crate::tool_activity::{refined_detail, tool_activity_from_event};

impl JsonAgentSession {
    /// Attach the activity sink (first call wins).
    pub fn attach_activity_sink(&self, sink: Arc<dyn ActivitySink>) {
        let _ = self.0.activity.set(sink);
    }

    /// Report `ev` to the activity sink. Fire-and-forget; never blocks.
    pub(super) fn note_activity(&self, ev: &NormalizedEvent) {
        let Some(sink) = self.0.activity.get() else {
            return;
        };
        if ev.role == Some(Role::User) {
            return;
        }
        let (project_id, session_id, tool) = {
            let mut s = self.0.state.lock().unwrap();
            let mut tool: Option<ToolActivity> = None;
            match ev.kind {
                NormalizedEventKind::Text
                | NormalizedEventKind::Thinking
                | NormalizedEventKind::Result
                | NormalizedEventKind::Error => {}
                NormalizedEventKind::ToolUse => {
                    if let Some(t) = tool_activity_from_event(ev) {
                        s.last_tool = Some((ev.tool_id.clone(), t.clone()));
                        tool = Some(t);
                    }
                }
                NormalizedEventKind::ToolResult => {
                    // ACP delivers the real arguments in a follow-up update:
                    // refine the detail of the tool call it belongs to.
                    if let (Some((id, cur)), Some(input)) = (&mut s.last_tool, &ev.tool_input) {
                        if id.is_some() && *id == ev.tool_id {
                            let detail = refined_detail(
                                &cur.name,
                                Some(input),
                                ev.tool_locations.as_deref().unwrap_or_default(),
                            );
                            if detail.is_some() && detail != cur.detail {
                                cur.detail = detail;
                                tool = Some(cur.clone());
                            }
                        }
                    }
                }
                _ => return,
            }
            (s.project.id.clone(), s.session.id.clone(), tool)
        };
        match tool {
            Some(t) => sink.record_tool(&project_id, &session_id, t),
            None => sink.record(&project_id, &session_id),
        }
    }
}
