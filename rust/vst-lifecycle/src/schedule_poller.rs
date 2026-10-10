//! Scheduler tick — delivers pending `scheduled_messages` when their `fireAt` arrives.
//!
//! Runs on a 1s interval. Each tick atomically *claims* due rows one at a time
//! (`claim_next_due_scheduled_message`) and delivers each exactly as if the
//! user had pressed Send on freshly typed text (steer a running turn when
//! possible, otherwise queue). A claimed row is owned by this poller until it is
//! marked sent / failed, so "send now" can't race it into a double delivery.
//!
//! Restart behaviour: rows are SQLite-persisted. On boot, `recover_orphans`
//! (called before the listener serves) fails rows that were claimed but never
//! finished — the daemon died mid-delivery, so the turn may or may not have
//! reached the agent — *visibly* (the UI offers Retry) instead of silently
//! re-sending or dropping them; then, after a short delay so the HTTP
//! listener is up, `start`'s first sweep delivers everything that came due while the daemon
//! was down. Overdue messages are always delivered — the user's intent was
//! "send this", not "send this only if on time".

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use vst_agents::json_agent_chat::{broadcast_scheduled_meta, deliver_scheduled_message};
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;

use crate::util::now_iso;

pub const SCHEDULE_POLL_INTERVAL_MS: u64 = 1_000;

/// Most rows delivered per tick, so a backlog (e.g. after downtime) is drained
/// over successive ticks instead of one tick spawning every agent at once.
pub const DUE_BATCH_LIMIT: u32 = 50;

/// Longest one delivery may take before it is failed (visibly, with Retry).
pub const DELIVERY_TIMEOUT_SECS: u64 = 60;

/// After a delivery to a session times out (its agent is not answering), skip
/// that session's due rows for this long, so one wedged agent costs the poller a
/// single timeout — not one per queued message, every tick.
pub const WEDGED_SESSION_COOLDOWN: Duration = Duration::from_secs(5 * 60);

/// Delay before the boot sweep, so the daemon's HTTP listener is accepting
/// connections before agents it spawns call back into it.
pub const BOOT_SWEEP_DELAY_MS: u64 = 2_000;

/// Failure text for a delivery that hit `DELIVERY_TIMEOUT_SECS`.
pub fn delivery_timeout_reason() -> String {
    format!(
        "Delivery timed out after {DELIVERY_TIMEOUT_SECS}s — it may or may not have been sent. Retry to send it again."
    )
}

pub struct SchedulePollerHandle {
    store: StoreHandle,
    broadcaster: Broadcaster,
    json_registry: Arc<JsonAgentRegistry<JsonAgentSession>>,
    daemon_port: u16,
    /// Sessions whose last delivery timed out → when to try them again.
    wedged: Mutex<HashMap<String, Instant>>,
}

impl SchedulePollerHandle {
    pub fn new(
        store: StoreHandle,
        broadcaster: Broadcaster,
        json_registry: Arc<JsonAgentRegistry<JsonAgentSession>>,
        daemon_port: u16,
    ) -> Self {
        Self {
            store,
            broadcaster,
            json_registry,
            daemon_port,
            wedged: Mutex::new(HashMap::new()),
        }
    }

    /// Sessions currently in their wedged cooldown (expired entries are dropped).
    fn wedged_sessions(&self) -> Vec<String> {
        let mut wedged = self.wedged.lock().unwrap();
        let now = Instant::now();
        wedged.retain(|_, until| *until > now);
        wedged.keys().cloned().collect()
    }

    pub async fn run_poll_once(&self) {
        // Claim ONE row right before delivering it (see the store's doc), up to
        // the per-tick limit so a backlog drains across ticks.
        for _ in 0..DUE_BATCH_LIMIT {
            let exclude = self.wedged_sessions();
            let row = match self
                .store
                .claim_next_due_scheduled_message(&now_iso(), &exclude)
                .await
            {
                Ok(Some(row)) => row,
                Ok(None) => break,
                Err(e) => {
                    tracing::warn!("schedule_poller: store error: {e}");
                    break;
                }
            };
            // Bounded: one wedged agent must not stall every session's schedule.
            let result = match tokio::time::timeout(
                Duration::from_secs(DELIVERY_TIMEOUT_SECS),
                deliver_scheduled_message(
                    &row,
                    self.daemon_port,
                    &self.store,
                    &self.broadcaster,
                    &self.json_registry,
                ),
            )
            .await
            {
                Ok(r) => r,
                Err(_) => {
                    // The delivery future was dropped but the agent may still act
                    // on what it was sent — don't hammer this session again soon.
                    self.wedged.lock().unwrap().insert(
                        row.session_id.clone(),
                        Instant::now() + WEDGED_SESSION_COOLDOWN,
                    );
                    Err(delivery_timeout_reason())
                }
            };
            let fire_now = now_iso();
            match result {
                Ok(r) => {
                    if let Err(e) = self
                        .store
                        .mark_scheduled_message_sent(&row.id, &r.turn_id, &fire_now)
                        .await
                    {
                        tracing::error!(
                            "schedule_poller: delivered {} but could not mark it sent: {e}",
                            row.id
                        );
                    }
                    tracing::debug!(
                        "schedule_poller: delivered message {} → turn {} ({:?})",
                        row.id,
                        r.turn_id,
                        r.delivery
                    );
                }
                Err(reason) => {
                    if let Err(e) = self
                        .store
                        .mark_scheduled_message_failed(&row.id, &reason, &fire_now)
                        .await
                    {
                        tracing::error!("schedule_poller: could not mark {} failed: {e}", row.id);
                    }
                    tracing::warn!(
                        "schedule_poller: failed to deliver message {}: {reason}",
                        row.id
                    );
                }
            }
            // Tell clients NOW (not at the end of the batch): the row left the
            // pending list, and a slow later delivery must not leave the tray
            // offering actions on a message that is already gone.
            broadcast_scheduled_meta(&self.store, &self.broadcaster, &row.session_id).await;
        }
    }

    /// Fail rows claimed by a previous daemon that died mid-delivery (the turn
    /// may or may not have reached the agent, so they are surfaced with a
    /// Retry instead of being silently re-sent or dropped). Call this BEFORE
    /// the HTTP listener starts serving, so a "send now" arriving right after
    /// boot can't be mistaken for an orphan.
    pub async fn recover_orphans(&self) {
        // Rows of sessions that were deleted while the daemon was down (no FK —
        // see the schema comment) would otherwise linger forever.
        match self
            .store
            .purge_scheduled_messages_for_missing_sessions()
            .await
        {
            Ok(0) => {}
            Ok(n) => tracing::info!(
                "schedule_poller: purged {n} scheduled message(s) of deleted sessions"
            ),
            Err(e) => tracing::warn!("schedule_poller: purge failed: {e}"),
        }
        match self.store.fail_orphaned_scheduled_messages(&now_iso()).await {
            Ok(0) => {}
            Ok(n) => tracing::warn!(
                "schedule_poller: {n} scheduled message(s) were mid-delivery when the daemon last stopped — marked failed (retryable)"
            ),
            Err(e) => tracing::warn!("schedule_poller: orphan recovery failed: {e}"),
        }
    }

    pub fn start(self: Arc<Self>) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(BOOT_SWEEP_DELAY_MS)).await;
            // Boot sweep: deliver everything that came due while the daemon was down.
            self.run_poll_once().await;
            let mut interval = tokio::time::interval(tokio::time::Duration::from_millis(
                SCHEDULE_POLL_INTERVAL_MS,
            ));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                self.run_poll_once().await;
            }
        })
    }
}
