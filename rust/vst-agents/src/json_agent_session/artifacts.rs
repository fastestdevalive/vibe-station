//! Artifact capture for a Rich Chat session.
//!
//! Tool-call events (in-band AND out-of-band) feed ONE per-session
//! [`ToolCallTracker`]; a call that completes (or fails: shell calls only) is turned into file effects by the
//! plugin (`extract_file_effects`) and handed to the injected `ArtifactSink`
//! (`vst-artifacts` implements it; this crate never depends on it). Secondary
//! path: ACP `fs/write_text_file` writes reach the same sink through the
//! connection's write observer. Fire-and-forget: nothing here blocks or fails
//! a turn, and with no sink installed everything is a no-op.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use vst_types::artifacts::{ArtifactSink, FileEffect, WriteContext};
use vst_types::{NormalizedEvent, NormalizedEventKind, Role};

use super::JsonAgentSession;
use crate::acp_connection::AcpConnection;
use crate::tool_call_tracker::ToolCallTracker;

/// Sink slot + merge state for one session.
#[derive(Default)]
pub(crate) struct ArtifactCapture {
    sink: OnceLock<Arc<dyn ArtifactSink>>,
    tracker: Mutex<ToolCallTracker>,
}

impl JsonAgentSession {
    /// Attach the artifact sink (first call wins).
    pub fn attach_artifact_sink(&self, sink: Arc<dyn ArtifactSink>) {
        let _ = self.0.artifacts.sink.set(sink);
    }

    /// Feed a tool event to the tracker; record the effects of a completed call.
    /// Called from BOTH `handle_event` and `handle_out_of_band_event`.
    pub(super) fn note_artifacts(&self, ev: &NormalizedEvent) {
        let Some(sink) = self.0.artifacts.sink.get() else {
            return;
        };
        if ev.role == Some(Role::User)
            || !matches!(
                ev.kind,
                NormalizedEventKind::ToolUse | NormalizedEventKind::ToolResult
            )
        {
            return;
        }
        let finished = self.0.artifacts.tracker.lock().unwrap().on_event(ev);
        let Some(call) = finished else {
            return;
        };
        if crate::file_effects::ignores_failed(&call) {
            return;
        }
        let effects = self.0.plugin.extract_file_effects(&call);
        self.record_effects(sink.as_ref(), effects);
    }

    /// Route `fs/write_text_file` writes of `conn` to the sink (secondary path).
    /// A weak handle keeps the connection (owned by the session) from keeping
    /// the session alive.
    pub(super) fn attach_fs_write_observer(&self, conn: &AcpConnection) {
        if self.0.artifacts.sink.get().is_none() {
            return;
        }
        let weak = Arc::downgrade(&self.0);
        conn.set_fs_write_observer(Some(Arc::new(move |path: PathBuf| {
            let Some(inner) = weak.upgrade() else {
                return;
            };
            let session = JsonAgentSession(inner);
            if let Some(sink) = session.0.artifacts.sink.get() {
                session.record_effects(
                    sink.as_ref(),
                    vec![FileEffect::write(path.display().to_string())],
                );
            }
        })));
    }

    fn record_effects(&self, sink: &dyn ArtifactSink, effects: Vec<FileEffect>) {
        if effects.is_empty() {
            return;
        }
        let ctx = {
            let s = self.0.state.lock().unwrap();
            WriteContext {
                project_id: s.project.id.clone(),
                worktree_id: s.worktree.as_ref().map(|w| w.id.clone()),
                session_id: s.session.id.clone(),
                cwd: self.0.cwd.clone(),
            }
        };
        sink.record(ctx, effects);
    }
}
