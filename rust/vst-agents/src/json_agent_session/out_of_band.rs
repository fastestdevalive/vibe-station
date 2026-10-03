//! `JsonAgentSession` out-of-band update handling — autonomous ACP
//! notifications that arrive when no prompt is in flight (subagent
//! task-notification / scheduled wake-ups).
//!
//! `AcpConnection` routes such updates to an out-of-band sink (see
//! `acp_connection.rs`); this module owns that sink's attach point and the
//! ingest + classify of each update per Decision 2/3: content kinds are
//! persisted + broadcast under a `notif-*` turn (via
//! `events::handle_out_of_band_event`), usage and commands updates mutate
//! session meta only, everything else is dropped. No lifecycle / `turn_state`
//! change, no timers.

use std::sync::Arc;

use agent_client_protocol::schema::v1::SessionUpdate;
use tokio::sync::mpsc;
use vst_types::NormalizedEventKind;

use crate::{
    acp_connection::AcpConnection,
    acp_transport::AcpTransport,
    normalize::{normalize_session_update, AcpEnrichHook},
};

use super::JsonAgentSession;

impl JsonAgentSession {
    /// Ingest one out-of-band `session/update`: normalize it, stamp it with the
    /// vst session id (NOT the ACP id), and classify per Decision 3.
    pub fn ingest_out_of_band_update(
        &self,
        update: &SessionUpdate,
        acp_session_id: &str,
        enrich: Option<&AcpEnrichHook>,
    ) {
        if self.is_released() {
            return;
        }
        let Some(mut ev) = normalize_session_update(update, acp_session_id, self.0.cli, enrich)
        else {
            return;
        };
        ev.session_id = self.0.state.lock().unwrap().session.id.clone();

        match ev.kind {
            // Content kinds — persist + broadcast under a notif-* turn.
            NormalizedEventKind::Text
            | NormalizedEventKind::Thinking
            | NormalizedEventKind::ToolUse
            | NormalizedEventKind::ToolResult
            | NormalizedEventKind::Status => {
                self.handle_out_of_band_event(ev);
            }
            // Usage / commands — session meta only, never persisted as rows.
            NormalizedEventKind::Usage => {
                self.merge_usage_into_state(&mut ev);
                self.emit_meta();
            }
            NormalizedEventKind::CommandsUpdate => {
                let cmds = ev.commands.clone();
                {
                    let mut s = self.0.state.lock().unwrap();
                    s.commands = cmds;
                }
                self.emit_meta();
            }
            // ModeUpdate and anything else — dropped.
            _ => {}
        }
    }

    /// Attach the out-of-band sink to a connection and spawn the task that
    /// drains it into `ingest_out_of_band_update`.
    ///
    /// **Ordering trap:** MUST be called only AFTER the connection's
    /// `session/load` has completed, because `session/load` replays the whole
    /// history as `session/update` notifications which must NOT be ingested.
    pub(super) fn attach_out_of_band_sink(
        &self,
        conn: &AcpConnection,
        enrich: Option<Arc<AcpEnrichHook>>,
    ) {
        let Some(acp_id) = conn.current_session_id() else {
            return;
        };
        let (tx, mut rx) = mpsc::unbounded_channel::<SessionUpdate>();
        conn.set_out_of_band_sink(Some(tx));
        let session = self.clone();
        tokio::spawn(async move {
            while let Some(u) = rx.recv().await {
                session.ingest_out_of_band_update(&u, &acp_id, enrich.as_deref());
            }
        });
    }

    /// Test-only: force the out-of-band burst clock to a value, so a test can
    /// deterministically start a NEW `notif-*` burst. `with_state_locked_for_test`
    /// does NOT expose `state`, hence this dedicated seam.
    #[doc(hidden)]
    pub fn set_out_of_band_last_at_ms_for_test(&self, ms: u64) {
        self.0.state.lock().unwrap().out_of_band_last_at_ms = ms;
    }
}
