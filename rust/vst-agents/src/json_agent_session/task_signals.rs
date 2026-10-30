//! Vendor ext notifications -> persisted `task_signal` rows (structured
//! background-task state, plan A-D5).
//!
//! `AcpConnection` forwards every ext notification for the current ACP session
//! to an ext sink (`acp_connection.rs`); the plugin decides whether one means
//! anything (`AgentPlugin::acp_ext_notification_event`, claude: raw SDK `task_*`
//! messages). A signal becomes a persisted + broadcast `task_signal` row whose
//! ONLY consumer is the task registry (`TaskRegistry::observe`), so rebuild ==
//! live. It is deliberately inert for everything else: no `turn_state`, no
//! activity ping, no out-of-band burst/cycle window, never rendered.

use tokio::sync::mpsc;
use vst_types::{NormalizedEvent, NormalizedEventKind};

use crate::acp_connection::{AcpConnection, AcpExtNotification};

use super::JsonAgentSession;

impl JsonAgentSession {
    /// Ingest one ext notification (released sessions and notifications the
    /// plugin does not understand are dropped).
    pub fn ingest_ext_notification(&self, n: &AcpExtNotification) {
        if self.is_released() {
            return;
        }
        let Some(mut ev) = self
            .0
            .plugin
            .acp_ext_notification_event(&n.method, &n.params)
        else {
            return;
        };
        // Stamp the running turn (if any) so a subagent signal can be tied to it;
        // an idle session's signal carries none. Read BEFORE `new_event`, which
        // takes the same lock.
        let turn_id = {
            let s = self.0.state.lock().unwrap();
            s.active_turn.as_ref().map(|t| t.turn_id.clone())
        };
        ev.turn_id = turn_id;
        let mut ev: NormalizedEvent = self.new_event(NormalizedEventKind::TaskSignal, &mut ev);
        self.persist_event(&mut ev);
        self.0.stream.emit_message(&ev);
        self.0.tasks.observe(&ev);
    }

    /// Attach the ext-notification sink and spawn the task draining it into
    /// [`Self::ingest_ext_notification`].
    ///
    /// **Ordering trap:** like the out-of-band sink, MUST be attached only
    /// AFTER `session/load` completed (history replay is never ingested).
    pub(super) fn attach_ext_notification_sink(&self, conn: &AcpConnection) {
        let (tx, rx) = mpsc::unbounded_channel::<AcpExtNotification>();
        conn.set_ext_notification_sink(Some(tx));
        self.spawn_ext_drain(rx);
    }

    fn spawn_ext_drain(&self, mut rx: mpsc::UnboundedReceiver<AcpExtNotification>) {
        // Called after this connection's `bump_epoch`, so this is its epoch.
        let epoch = self.0.tasks.epoch();
        let session = self.clone();
        tokio::spawn(async move {
            while let Some(n) = rx.recv().await {
                session.ingest_ext_notification(&n);
            }
            // The sender was dropped: the adapter actor exited, or the sink
            // was replaced/cleared. A confirmed (authoritative) task is never
            // probed, so without this it would hold the session until the
            // alive cap. A newer connection has a newer epoch: no-op then.
            if !session.is_released() {
                session.0.tasks.adapter_gone(epoch);
            }
        });
    }

    /// Test seam: attach a fake ext sink as a connection would and return its
    /// sender (dropping it simulates the adapter exiting).
    #[doc(hidden)]
    pub fn attach_ext_sink_for_test(&self) -> mpsc::UnboundedSender<AcpExtNotification> {
        let (tx, rx) = mpsc::unbounded_channel::<AcpExtNotification>();
        self.spawn_ext_drain(rx);
        tx
    }

    /// Test seam: ingest as the connection's ext sink would.
    #[doc(hidden)]
    pub fn ingest_ext_notification_for_test(&self, n: &AcpExtNotification) {
        self.ingest_ext_notification(n);
    }
}
