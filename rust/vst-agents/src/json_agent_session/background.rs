//! Out-of-band ("background") lifecycle window.
//!
//! When content arrives from the agent with no prompt in flight (adapter
//! autonomous cycle, background-command wake-up, subagent notification) the
//! session is *working* even though no drain runs. This module owns that
//! window: the first content writes `Working(background)`, every further
//! content re-arms a quiet timer, and the timer settles the window back to
//! `WaitingForHuman(background-settled)`.
//!
//! The settle is a quiet-timer heuristic (the vendored adapter exposes no
//! cycle-end signal; plan K6). `turn_state` is never touched: Stop/steer stay
//! tied to real prompts. A real drain start (`kick_drain`) invalidates the
//! window, and the drain's own final write is then authoritative.
//!
//! All writes go through `write_lifecycle_locked` under `lifecycle_lock`.
//! The timer is ONE long-lived task per window, never aborted (aborting could
//! drop it between the in-memory flip and the store write); it re-reads its
//! deadline each wake and exits itself under the `state` lock.

use std::time::Duration;

use tokio::time::Instant;
use vst_types::{LifecycleState, NormalizedEvent, NormalizedEventKind, ToolStatus};

use super::{JsonAgentSession, BACKGROUND_HEARTBEAT_CAP_MS, BACKGROUND_QUIET_MS};
use crate::json_agent_chat::{BACKGROUND_REASON, BACKGROUND_SETTLED_REASON};

/// A heartbeat is a progress update for a still-running tool (carries no new
/// content); it extends a window only within `BACKGROUND_HEARTBEAT_CAP_MS`.
fn is_heartbeat(ev: &NormalizedEvent) -> bool {
    ev.kind == NormalizedEventKind::ToolResult && ev.tool_status == Some(ToolStatus::InProgress)
}

impl JsonAgentSession {
    /// Called by `handle_out_of_band_event` after the event is persisted.
    pub(super) fn note_background_activity(&self, ev: &NormalizedEvent) {
        let now = Instant::now();
        let quiet = Duration::from_millis(BACKGROUND_QUIET_MS);
        let cap = Duration::from_millis(BACKGROUND_HEARTBEAT_CAP_MS);
        let heartbeat = is_heartbeat(ev);

        let (gen, need_write, spawn_timer) = {
            let mut s = self.0.state.lock().unwrap();
            if s.running {
                // A drain owns the lifecycle.
                return;
            }
            if !s.bg_working {
                if heartbeat {
                    // A heartbeat carries no new content: it may extend an open
                    // window but never opens one (else a tool running past the
                    // cap would flap working/waiting every cap + quiet gap).
                    return;
                }
                s.bg_working = true;
                s.bg_gen += 1;
                s.bg_last_content = Some(now);
                s.bg_deadline = Some(now + quiet);
            } else if !heartbeat {
                s.bg_last_content = Some(now);
                s.bg_deadline = Some(now + quiet);
            } else if s
                .bg_last_content
                .is_some_and(|t| now.saturating_duration_since(t) < cap)
            {
                s.bg_deadline = Some(now + quiet);
            }
            let spawn_timer = !s.bg_timer_active;
            s.bg_timer_active = true;
            (
                s.bg_gen,
                s.last_written != LifecycleState::Working,
                spawn_timer,
            )
        };

        self.note_activity(ev);

        if need_write {
            let this = self.clone();
            tokio::spawn(async move {
                let _guard = this.0.lifecycle_lock.lock().await;
                let still = {
                    let s = this.0.state.lock().unwrap();
                    s.bg_working && s.bg_gen == gen && s.last_written != LifecycleState::Working
                };
                if still {
                    this.write_lifecycle_locked(LifecycleState::Working, Some(BACKGROUND_REASON))
                        .await;
                }
            });
        }
        if spawn_timer {
            let this = self.clone();
            tokio::spawn(async move { this.run_background_timer().await });
        }
    }

    /// Quiet-timer loop; exits (clearing `bg_timer_active`) when the window
    /// is closed or the session is released.
    async fn run_background_timer(&self) {
        loop {
            let (gen, deadline) = {
                let mut s = self.0.state.lock().unwrap();
                match (s.bg_working, s.bg_deadline) {
                    (true, Some(d)) if !self.is_released() => (s.bg_gen, d),
                    _ => {
                        s.bg_timer_active = false;
                        return;
                    }
                }
            };
            if Instant::now() < deadline {
                tokio::time::sleep_until(deadline).await;
                continue;
            }
            self.settle_background(gen).await;
            // Loop: window closed -> exit; deadline moved -> sleep again.
        }
    }

    /// Settle the window opened as generation `gen`, if it is still current,
    /// still quiet, and no drain/release intervened.
    async fn settle_background(&self, gen: u64) {
        let _guard = self.0.lifecycle_lock.lock().await;
        let settle = {
            let mut s = self.0.state.lock().unwrap();
            let expired = s.bg_deadline.is_some_and(|d| Instant::now() >= d);
            if s.bg_working && s.bg_gen == gen && !s.running && expired && !self.is_released() {
                s.bg_working = false;
                true
            } else {
                false
            }
        };
        if settle {
            self.write_lifecycle_locked(
                LifecycleState::WaitingForHuman,
                Some(BACKGROUND_SETTLED_REASON),
            )
            .await;
        }
    }
}
