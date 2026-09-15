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
//! - Pane disappears from `list-sessions` snapshot → transition to `Exited` +
//!   broadcast `SessionState { state: Exited }`.
//! - `mark_session_exited`: idempotent — no-ops for already `Done`/`Exited`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use sha1::{Digest, Sha1};
use vst_proc::tmux::{CapturePaneOptions, Tmux};
use vst_store::StoreHandle;
use vst_types::domain::{Channel, LifecycleState, SessionLifecycle, SessionRecord};
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
                let current_state = session.lifecycle.state;

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

                    if track.hash != new_hash {
                        track.hash = new_hash;
                        track.stable_since_ms = now;
                        if current_state == LifecycleState::WaitingForHuman {
                            Some(LifecycleState::Working)
                        } else {
                            None
                        }
                    } else {
                        let stable_age = now.saturating_sub(track.stable_since_ms);
                        if stable_age >= IDLE_THRESHOLD_MS
                            && current_state != LifecycleState::WaitingForHuman
                        {
                            // ever_worked is always true → always WaitingForHuman
                            Some(LifecycleState::WaitingForHuman)
                        } else {
                            None
                        }
                    }
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
