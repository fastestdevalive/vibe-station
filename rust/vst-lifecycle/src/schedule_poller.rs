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
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use vst_agents::json_agent_chat::{broadcast_scheduled_meta, deliver_scheduled_message};
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_store::StoreHandle;
use vst_types::domain::Channel;
use vst_types::events::Broadcaster;
use vst_types::rest::sessions::ScheduledMessageRow;

use crate::channel::session_channel;
use crate::util::now_iso;

/// Hands a claimed row to Terminal (tmux) delivery. The daemon injects a closure
/// over `vst-review`'s `TerminalDeliveryHandle::fire`, so this crate takes no
/// dependency on it. The future resolves once the row's delivery phase is
/// `waiting` (a fast store write); the handle itself records every failure.
pub type TerminalFire =
    Arc<dyn Fn(ScheduledMessageRow) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// Does a scheduled message for `session_id` go to Terminal delivery? Decided on
/// the session's CURRENT channel (a row's own `channel` is advisory: a toggle may
/// have happened since it was created): anything but Rich Chat is Terminal. A
/// session that no longer exists stays on the json path, which fails the row with
/// today's "The session no longer exists.". Shared by the poller and "send now".
pub async fn is_terminal_session(store: &StoreHandle, session_id: &str) -> bool {
    match store.find_session(session_id).await {
        Some((_, s)) => session_channel(s.channel, Some(s.use_tmux)) != Channel::Json,
        None => false,
    }
}

/// Failure text for a Terminal row when no [`TerminalFire`] is wired.
const TERMINAL_UNAVAILABLE: &str = "Terminal delivery is not available";

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
    /// Terminal (tmux) delivery; `None` fails a Terminal row visibly.
    terminal_fire: Option<TerminalFire>,
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
            terminal_fire: None,
        }
    }

    /// Route rows of Terminal sessions to `fire` instead of the Rich Chat path.
    pub fn with_terminal_fire(mut self, fire: TerminalFire) -> Self {
        self.terminal_fire = Some(fire);
        self
    }

    async fn is_terminal_row(&self, row: &ScheduledMessageRow) -> bool {
        is_terminal_session(&self.store, &row.session_id).await
    }

    /// Terminal rows: the handle owns the whole outcome (and notifies clients).
    /// Without one the row fails visibly, written here.
    async fn dispatch_terminal(&self, row: ScheduledMessageRow) {
        if let Some(fire) = &self.terminal_fire {
            fire(row).await;
            return;
        }
        let kind = vst_types::terminal_delivery::FailureKind::Error;
        match self
            .store
            .mark_scheduled_message_failed(
                &row.id,
                TERMINAL_UNAVAILABLE,
                Some(kind.as_str()),
                &now_iso(),
            )
            .await
        {
            Ok(_) => {}
            Err(e) => tracing::error!("schedule_poller: could not mark {} failed: {e}", row.id),
        }
        tracing::warn!(
            "schedule_poller: no terminal delivery for message {}",
            row.id
        );
        broadcast_scheduled_meta(&self.store, &self.broadcaster, &row.session_id).await;
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
            // Terminal sessions are not delivered here: the handle waits for the
            // agent to be ready (up to minutes), which must not hold this serial
            // tick, and it never enters the wedged-session cooldown.
            if self.is_terminal_row(&row).await {
                self.dispatch_terminal(row).await;
                continue;
            }
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
                        .mark_scheduled_message_failed(&row.id, &reason, None, &fire_now)
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

    /// Recover rows claimed by a previous daemon that died mid-delivery: rows
    /// that were only `waiting` to be pasted are re-armed, everything else
    /// (the turn may or may not have reached the agent) is surfaced failed with
    /// a Retry instead of being silently re-sent or dropped. Returns the row ids
    /// per outcome. Call this BEFORE the HTTP listener starts serving, so a
    /// "send now" arriving right after boot can't be mistaken for an orphan.
    pub async fn recover_orphans(&self) -> vst_store::RecoveryOutcome {
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
        match self
            .store
            .recover_orphaned_scheduled_messages(&now_iso())
            .await
        {
            Ok(outcome) => {
                let failed = outcome.failed_mid_paste.len() + outcome.failed_other_tmux.len();
                if failed > 0 || !outcome.rearmed.is_empty() {
                    tracing::warn!(
                        "schedule_poller: orphan recovery: {} re-armed, {} marked failed (retryable)",
                        outcome.rearmed.len(),
                        failed
                    );
                }
                outcome
            }
            Err(e) => {
                tracing::warn!("schedule_poller: orphan recovery failed: {e}");
                vst_store::RecoveryOutcome::default()
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use vst_types::{
        LifecycleState, ProjectRecord, SessionLifecycle, SessionNameSource, SessionRecord,
        SessionType,
    };

    const PAST: &str = "2000-01-01T00:00:00Z";

    fn session(id: &str, channel: Channel) -> SessionRecord {
        SessionRecord {
            id: id.into(),
            worktree_id: None,
            project_id: "p1".into(),
            is_main: false,
            sort_order: 1.0,
            r#type: SessionType::Agent,
            mode_id: Some("m".into()),
            mode_icon: None,
            name: Some("Agent".into()),
            name_source: Some(SessionNameSource::Auto),
            tmux_name: format!("vst-{id}"),
            use_tmux: channel == Channel::Tmux,
            channel: Some(channel),
            lifecycle: SessionLifecycle {
                state: LifecycleState::Working,
                reason: None,
                last_transition_at: "2026-01-01T00:00:00.000Z".into(),
            },
            transcript_ref: None,
            agent_chat_id: None,
            acp_session_id: None,
            model_override: None,
            pinned_at: None,
            initial_prompt: None,
            draft_prompt: None,
            draft_config: None,
            archived_at: None,
            handoff_summary: None,
            carry_over: None,
            parent_session_id: None,
            superseded_by: None,
            pr: None,
            last_activity_at: None,
            last_line: None,
            last_tool: None,
        }
    }

    async fn setup(
        sessions: Vec<SessionRecord>,
    ) -> (tempfile::TempDir, StoreHandle, SchedulePollerHandle) {
        let dir = tempfile::tempdir().unwrap();
        let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
        store
            .add_project(ProjectRecord {
                id: "p1".into(),
                absolute_path: "/repos/p1".into(),
                prefix: "vs".into(),
                is_git: true,
                default_branch: Some("main".into()),
                created_at: "2026-01-01T00:00:00.000Z".into(),
                hidden: None,
                direct_sessions: sessions,
                direct_session_seq: Some(1),
                worktrees: vec![],
                next_worktree_num: Some(1),
                lsp_enabled: None,
                open_files: vec![],
            })
            .await
            .unwrap();
        let poller = SchedulePollerHandle::new(
            store.clone(),
            Broadcaster::new(16),
            Arc::new(JsonAgentRegistry::new()),
            3999,
        );
        (dir, store, poller)
    }

    async fn add_row(store: &StoreHandle, id: &str, session_id: &str, channel: &str) {
        store
            .insert_scheduled_message(
                id,
                session_id,
                "hello",
                None,
                PAST,
                PAST,
                Some(channel),
                None,
                Some("schedule"),
            )
            .await
            .unwrap();
    }

    fn counting_fire(n: Arc<AtomicUsize>, seen: Arc<Mutex<Vec<String>>>) -> TerminalFire {
        Arc::new(move |row| {
            let (n, seen) = (n.clone(), seen.clone());
            Box::pin(async move {
                n.fetch_add(1, Ordering::SeqCst);
                seen.lock().unwrap().push(row.id.clone());
            })
        })
    }

    #[tokio::test]
    async fn tmux_row_goes_to_terminal_fire_and_never_wedges_or_delays_json_rows() {
        // The json row's session does not exist, so the json path fails it
        // quickly (no agent is started); it must still be handled in the SAME
        // tick as the terminal row.
        let (_d, store, poller) = setup(vec![session("tty", Channel::Tmux)]).await;
        let (n, seen) = (Arc::new(AtomicUsize::new(0)), Arc::new(Mutex::new(vec![])));
        let poller = poller.with_terminal_fire(counting_fire(n.clone(), seen.clone()));
        add_row(&store, "t1", "tty", "tmux").await;
        add_row(&store, "j1", "ghost", "json").await;

        poller.run_poll_once().await;

        assert_eq!(n.load(Ordering::SeqCst), 1);
        assert_eq!(*seen.lock().unwrap(), vec!["t1".to_string()]);
        let j = store.get_scheduled_message("j1").await.unwrap().unwrap();
        assert_eq!(j.status, "failed", "json row handled in the same tick");
        // The poller never writes a tmux failure when a handle exists, and a
        // terminal row never enters the wedged cooldown.
        let t = store.get_scheduled_message("t1").await.unwrap().unwrap();
        assert_eq!(
            (t.status.as_str(), t.claimed_at.is_some()),
            ("pending", true)
        );
        assert!(poller.wedged_sessions().is_empty());
    }

    #[tokio::test]
    async fn tmux_row_without_terminal_fire_fails_visibly() {
        let (_d, store, poller) = setup(vec![session("tty", Channel::Tmux)]).await;
        add_row(&store, "t1", "tty", "tmux").await;
        poller.run_poll_once().await;
        let t = store.get_scheduled_message("t1").await.unwrap().unwrap();
        assert_eq!(t.status, "failed");
        assert_eq!(
            t.failure_reason.as_deref(),
            Some("Terminal delivery is not available")
        );
        assert_eq!(t.failure_kind.as_deref(), Some("error"));
        assert!(t.claimed_at.is_none());
    }

    #[tokio::test]
    async fn missing_session_stays_on_the_json_path() {
        let (_d, store, poller) = setup(vec![]).await;
        let (n, seen) = (Arc::new(AtomicUsize::new(0)), Arc::new(Mutex::new(vec![])));
        let poller = poller.with_terminal_fire(counting_fire(n.clone(), seen));
        // Even a row stamped `tmux` follows the session's current channel; a
        // missing session is the json path's "no longer exists" failure.
        add_row(&store, "t1", "ghost", "tmux").await;
        poller.run_poll_once().await;
        let t = store.get_scheduled_message("t1").await.unwrap().unwrap();
        assert_eq!(t.status, "failed");
        assert_eq!(
            t.failure_reason.as_deref(),
            Some("The session no longer exists.")
        );
        assert_eq!(t.failure_kind, None);
        assert_eq!(n.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn dispatch_follows_the_current_channel_not_the_row_stamp() {
        // A row created on a tmux session whose channel was since toggled to
        // json is delivered through the json path (here: fails, no agent), not
        // handed to Terminal delivery.
        let (_d, store, poller) = setup(vec![session("rich", Channel::Json)]).await;
        let (n, seen) = (Arc::new(AtomicUsize::new(0)), Arc::new(Mutex::new(vec![])));
        let poller = poller.with_terminal_fire(counting_fire(n.clone(), seen));
        add_row(&store, "t1", "rich", "tmux").await;
        // No real agent can start under test; bound the json attempt.
        tokio::time::timeout(Duration::from_secs(20), poller.run_poll_once())
            .await
            .expect("json path fails fast without a mode");
        assert_eq!(n.load(Ordering::SeqCst), 0);
        // The json path settled it (no failureKind: that is the terminal path's).
        let t = store.get_scheduled_message("t1").await.unwrap().unwrap();
        assert_ne!(t.status, "pending");
        assert_eq!(t.failure_kind, None);
    }

    #[tokio::test]
    async fn pty_session_rows_go_to_terminal_delivery_which_fails_them_there() {
        let (_d, store, poller) = setup(vec![session("pty", Channel::Pty)]).await;
        let (n, seen) = (Arc::new(AtomicUsize::new(0)), Arc::new(Mutex::new(vec![])));
        let poller = poller.with_terminal_fire(counting_fire(n.clone(), seen));
        add_row(&store, "t1", "pty", "tmux").await;
        poller.run_poll_once().await;
        assert_eq!(n.load(Ordering::SeqCst), 1);
    }
}
