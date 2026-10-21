//! 1-second lifecycle poller — ports `services/lifecycle.ts`.
//!
//! **Two-axis model** (Gotcha #3): this module is the **sole writer** of
//! `lifecycle.state`.  The setter is fully private — restricted to this module
//! only — so the compiler prevents pr_poller (or any other module) from calling it.
//!
//! Key behaviors:
//! - `POLL_INTERVAL_MS = 1_000`, `IDLE_THRESHOLD_MS = 4_000`, `CAPTURE_LINES = 20`
//! - `everWorked` seeded `true` unconditionally → idle-stable always lands on
//!   `WaitingForHuman`, never plain `Idle`.
//! - Idle detection: SHA-1 of the captured pane content.
//! - `stableSince` resets whenever the hash changes.
//! - Skipped states: `NotStarted`, `Done`, `Exited`, `Drafting`, plus `Json`-channel.
//! - Plain terminal sessions (`SessionType::Terminal`) get liveness only: a vanished
//!   tmux session still goes `Exited`, but there is no idle detection — no pane
//!   capture, no `Working` <-> `WaitingForHuman` flapping, no `session:state` noise.
//!   They stay `Working` until exited/done; a terminal found stuck at
//!   `WaitingForHuman`/`Idle` (written by an older daemon) is normalised back to
//!   `Working` once.
//! - Pane disappears from `list-sessions` snapshot → transition to `Exited` +
//!   broadcast `SessionState { state: Exited }`.
//! - `mark_session_exited`: idempotent — no-ops for already `Done`/`Exited`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use sha1::{Digest, Sha1};
use vst_proc::tmux::{CapturePaneOptions, Tmux};
use vst_store::StoreHandle;
use vst_types::domain::{Channel, LifecycleState, SessionLifecycle, SessionRecord, SessionType};
use vst_types::events::{Broadcaster, ServerEvent};

use crate::util::{now_iso, now_ms};

pub const POLL_INTERVAL_MS: u64 = 1_000;
pub const IDLE_THRESHOLD_MS: u64 = 4_000;
pub const CAPTURE_LINES: usize = 20;

/// Idle-tracking entry stored per tmux-session name.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(super) struct IdleTrack {
    pub(super) hash: [u8; 20],
    pub(super) stable_since_ms: u64,
    /// Seeded `true` unconditionally — means idle-stable always resolves to
    /// `WaitingForHuman` rather than plain `Idle`.
    pub(super) ever_worked: bool,
}

#[derive(Default)]
struct IdleTrackMap(HashMap<String, IdleTrack>);

fn sha1_of(s: &str) -> [u8; 20] {
    let mut hasher = Sha1::new();
    hasher.update(s.as_bytes());
    hasher.finalize().into()
}

fn should_skip(session: &SessionRecord) -> bool {
    matches!(
        session.lifecycle.state,
        LifecycleState::NotStarted
            | LifecycleState::Done
            | LifecycleState::Exited
            | LifecycleState::Drafting
    ) || session.channel == Some(Channel::Json)
        // Direct-pty ("plain terminal", useTmux: false) sessions have no tmux
        // pane at all — their `tmux_name` is a synthetic label that never
        // appears in `tmux list-sessions`. Without this guard, the very first
        // poll tick after creation/reattach found the name "missing" from the
        // tmux liveness snapshot below and immediately called
        // `mark_session_exited`, killing perfectly live plain terminals within
        // ~1s of open (surfaced as "terminal closes right after tap", since a
        // tap is roughly when the UI re-syncs and the frontend first notices
        // the already-stale `exited` state). Mirrors `daemon/src/services/
        // lifecycle.ts`'s `if (session.useTmux === false) { ... }` branch,
        // which never falls through to the tmux-liveness check at all. Exit
        // for direct-pty sessions is meant to be event-driven (PTY exit),
        // not detected by this poller.
        || !session.use_tmux
}

/// Idle-detection decision for an agent session, given whether the pane hash
/// changed this tick and how long it has been stable.
fn agent_next_state(
    current: LifecycleState,
    hash_changed: bool,
    stable_age_ms: u64,
) -> Option<LifecycleState> {
    if hash_changed {
        (current == LifecycleState::WaitingForHuman).then_some(LifecycleState::Working)
    } else if stable_age_ms >= IDLE_THRESHOLD_MS && current != LifecycleState::WaitingForHuman {
        // ever_worked is always true → always WaitingForHuman
        Some(LifecycleState::WaitingForHuman)
    } else {
        None
    }
}

/// Plain terminals have no idle/waiting state. The only transition is the
/// one-shot repair of a value an older daemon left behind.
fn terminal_next_state(current: LifecycleState) -> Option<LifecycleState> {
    matches!(
        current,
        LifecycleState::WaitingForHuman | LifecycleState::Idle
    )
    .then_some(LifecycleState::Working)
}

/// Private (this module only) lifecycle-state setter.
/// Only this module may write `lifecycle.state` — enforces the two-axis model.
async fn set_lifecycle_state(
    project_id: &str,
    session: &SessionRecord,
    new_state: LifecycleState,
    reason: Option<String>,
    store: &StoreHandle,
    broadcaster: &Broadcaster,
) {
    if session.lifecycle.state == new_state {
        return;
    }
    let lifecycle = SessionLifecycle {
        state: new_state,
        reason: reason.clone(),
        last_transition_at: now_iso(),
    };
    let _ = store
        .update_session_lifecycle(project_id, &session.id, lifecycle)
        .await;
    broadcaster.send(ServerEvent::SessionState {
        session_id: session.id.clone(),
        state: new_state,
        reason,
    });
}

/// Mark a session as exited. Idempotent — no-ops for `Done`/`Exited`.
pub async fn mark_session_exited(
    project_id: &str,
    session: &SessionRecord,
    store: &StoreHandle,
    broadcaster: &Broadcaster,
) {
    if matches!(
        session.lifecycle.state,
        LifecycleState::Done | LifecycleState::Exited
    ) {
        return;
    }
    let lifecycle = SessionLifecycle {
        state: LifecycleState::Exited,
        reason: None,
        last_transition_at: now_iso(),
    };
    let _ = store
        .update_session_lifecycle(project_id, &session.id, lifecycle)
        .await;
    broadcaster.send(ServerEvent::SessionState {
        session_id: session.id.clone(),
        state: LifecycleState::Exited,
        reason: None,
    });
}

/// Handle to the lifecycle poller.
#[derive(Clone)]
pub struct LifecyclePollerHandle {
    store: StoreHandle,
    broadcaster: Broadcaster,
    tracks: Arc<Mutex<IdleTrackMap>>,
}

impl LifecyclePollerHandle {
    pub fn new(store: StoreHandle, broadcaster: Broadcaster) -> Self {
        Self {
            store,
            broadcaster,
            tracks: Arc::new(Mutex::new(IdleTrackMap::default())),
        }
    }

    /// Clear idle tracking for a specific tmux name (e.g. after a mode toggle).
    pub fn clear_idle_tracking(&self, tmux_name: &str) {
        self.tracks
            .lock()
            .expect("idle tracks poisoned")
            .0
            .remove(tmux_name);
    }

    /// Run one poll tick — public for testing.
    pub async fn run_poll_once(&self) {
        let tmux = Tmux::new();
        // ONE snapshot per tick — not `has-session` per session.
        let live_names = {
            let tmux2 = tmux.clone();
            match tokio::task::spawn_blocking(move || tmux2.list_session_names()).await {
                Ok(Some(names)) => names,
                _ => return, // uninterpretable error — skip tick
            }
        };

        let projects = self.store.get_all_projects().await;
        let now = now_ms();

        for project in &projects {
            let all_sessions: Vec<_> = project
                .worktrees
                .iter()
                .flat_map(|wt| wt.sessions.iter())
                .chain(project.direct_sessions.iter())
                .collect();

            for session in all_sessions {
                if should_skip(session) {
                    continue;
                }

                if !live_names.contains(&session.tmux_name) {
                    {
                        let mut map = self.tracks.lock().expect("poisoned");
                        map.0.remove(&session.tmux_name);
                    }
                    mark_session_exited(&project.id, session, &self.store, &self.broadcaster).await;
                    continue;
                }

                // Liveness is all a plain terminal gets (checked above): no pane
                // capture and no idle tracking.
                if session.r#type == SessionType::Terminal {
                    if let Some(state) = terminal_next_state(session.lifecycle.state) {
                        set_lifecycle_state(
                            &project.id,
                            session,
                            state,
                            None,
                            &self.store,
                            &self.broadcaster,
                        )
                        .await;
                    }
                    continue;
                }

                let captured = {
                    let tmux2 = tmux.clone();
                    let name = session.tmux_name.clone();
                    tokio::task::spawn_blocking(move || {
                        tmux2
                            .capture_pane(
                                &name,
                                &CapturePaneOptions {
                                    escape: false,
                                    lines: Some(CAPTURE_LINES),
                                },
                            )
                            .unwrap_or_default()
                    })
                    .await
                    .unwrap_or_default()
                };

                let new_hash = sha1_of(&captured);

                let new_state = {
                    let mut map = self.tracks.lock().expect("poisoned");
                    let track =
                        map.0
                            .entry(session.tmux_name.clone())
                            .or_insert_with(|| IdleTrack {
                                hash: new_hash,
                                stable_since_ms: now,
                                ever_worked: true,
                            });

                    let hash_changed = track.hash != new_hash;
                    if hash_changed {
                        track.hash = new_hash;
                        track.stable_since_ms = now;
                    }
                    agent_next_state(
                        session.lifecycle.state,
                        hash_changed,
                        now.saturating_sub(track.stable_since_ms),
                    )
                };

                if let Some(state) = new_state {
                    set_lifecycle_state(
                        &project.id,
                        session,
                        state,
                        None,
                        &self.store,
                        &self.broadcaster,
                    )
                    .await;
                }
            }
        }
    }

    /// Start the 1s background polling loop.
    pub fn start(self: Arc<Self>) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(tokio::time::Duration::from_millis(POLL_INTERVAL_MS));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                self.run_poll_once().await;
            }
        })
    }
}

#[cfg(test)]
mod should_skip_tests {
    use super::should_skip;
    use vst_types::domain::{
        Channel, LifecycleState, SessionLifecycle, SessionRecord, SessionType,
    };

    fn base_session() -> SessionRecord {
        SessionRecord {
            id: "proj-1-t-11112222".into(),
            worktree_id: None,
            project_id: "proj-1".into(),
            is_main: false,
            sort_order: 0.0,
            r#type: SessionType::Terminal,
            mode_id: None,
            mode_icon: None,
            name: None,
            name_source: None,
            tmux_name: "__direct__-proj-1-t-11112222".into(),
            use_tmux: true,
            channel: None,
            lifecycle: SessionLifecycle {
                state: LifecycleState::Working,
                reason: None,
                last_transition_at: "2024-01-01T00:00:00.000Z".into(),
            },
            transcript_ref: None,
            agent_chat_id: None,
            acp_session_id: None,
            model_override: None,
            pinned_at: None,
            initial_prompt: None,
            archived_at: None,
            handoff_summary: None,
            draft_prompt: None,
            draft_config: None,
            parent_session_id: None,
            superseded_by: None,
            pr: None,
        }
    }

    #[test]
    fn tmux_backed_working_session_is_not_skipped() {
        let session = base_session();
        assert!(!should_skip(&session));
    }

    #[test]
    fn json_channel_session_is_skipped() {
        let mut session = base_session();
        session.channel = Some(Channel::Json);
        assert!(should_skip(&session));
    }

    #[test]
    fn exited_session_is_skipped() {
        let mut session = base_session();
        session.lifecycle.state = LifecycleState::Exited;
        assert!(should_skip(&session));
    }

    /// Regression test for the "plain terminal closes right after tap" bug:
    /// a direct-pty (`useTmux: false`) session's `tmux_name` is a synthetic
    /// label that never appears in a real `tmux list-sessions` snapshot, so
    /// without this guard `run_poll_once` treated every such session as dead
    /// on its very first poll tick and called `mark_session_exited` on a
    /// perfectly live terminal. Mirrors `daemon/src/services/lifecycle.ts`'s
    /// `if (session.useTmux === false) { ... }` branch, which never falls
    /// through to the tmux-liveness check either.
    #[test]
    fn direct_pty_working_session_is_skipped_even_though_tmux_name_is_synthetic() {
        let mut session = base_session();
        session.use_tmux = false;
        assert!(should_skip(&session));
    }

    #[test]
    fn direct_pty_waiting_for_human_session_is_still_skipped() {
        let mut session = base_session();
        session.use_tmux = false;
        session.lifecycle.state = LifecycleState::WaitingForHuman;
        assert!(should_skip(&session));
    }
}

#[cfg(test)]
mod next_state_tests {
    use super::{agent_next_state, terminal_next_state, IDLE_THRESHOLD_MS};
    use vst_types::domain::LifecycleState::{Done, Exited, Idle, WaitingForHuman, Working};

    #[test]
    fn terminal_never_enters_waiting_or_idle() {
        assert_eq!(terminal_next_state(Working), None);
        assert_eq!(terminal_next_state(Done), None);
        assert_eq!(terminal_next_state(Exited), None);
    }

    #[test]
    fn terminal_stuck_at_waiting_or_idle_is_repaired_to_working() {
        assert_eq!(terminal_next_state(WaitingForHuman), Some(Working));
        assert_eq!(terminal_next_state(Idle), Some(Working));
    }

    #[test]
    fn agent_idle_detection_is_unchanged() {
        // Stable long enough → waiting for human.
        assert_eq!(
            agent_next_state(Working, false, IDLE_THRESHOLD_MS),
            Some(WaitingForHuman)
        );
        // Not stable long enough → no change.
        assert_eq!(
            agent_next_state(Working, false, IDLE_THRESHOLD_MS - 1),
            None
        );
        // Already waiting and still stable → no change.
        assert_eq!(
            agent_next_state(WaitingForHuman, false, IDLE_THRESHOLD_MS),
            None
        );
        // Output resumed while waiting → working.
        assert_eq!(agent_next_state(WaitingForHuman, true, 0), Some(Working));
        // Output changed while already working → no change.
        assert_eq!(agent_next_state(Working, true, 0), None);
    }
}
