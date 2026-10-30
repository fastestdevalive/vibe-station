//! The JSON-channel lifecycle: the single writer plus the single decider.
//!
//! The lifecycle of a Rich Chat session is a pure function of evidence:
//! a drain running (human or notice turn), an out-of-band cycle window
//! (`bg_working`), and live background tasks (`TaskRegistry::hold()`).
//! [`reconcile_lifecycle_locked`] re-derives it from fresh inputs under
//! `lifecycle_lock` every time an input changes (drain end, window open/settle,
//! task-hold change pushed by the registry's watch channel), so correctness
//! never depends on the interleaving of those events.
//!
//! Grace after the last hold ends is owned by the registry
//! (`TaskHold::grace_active`); there is no session-side timer or clock.
//! Every write goes through [`write_lifecycle_locked`] (released sessions
//! write nothing).

use std::collections::HashSet;
use std::sync::Arc;

use vst_tasks::{HoldLapse, LapsedTask, TaskHold};
use vst_types::{LifecycleState, ServerEvent, SessionLifecycle};

use super::JsonAgentSession;
use crate::json_agent_chat::{
    BACKGROUND_REASON, BACKGROUND_SETTLED_REASON, BACKGROUND_TURN_ENDED_REASON,
};

/// What `derive` wants written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Target(pub LifecycleState, pub Option<&'static str>);

/// Evidence read fresh under `lifecycle_lock`.
#[derive(Clone, Copy, Debug)]
pub(super) struct Inputs {
    pub cycle_open: bool,
    pub holding: usize,
    /// Copied from `TaskHold.grace_active` (registry-computed).
    pub grace_active: bool,
    pub turn_end_unannounced: bool,
}

/// Pure derivation (State table, rows for `running == false`). A running or
/// queued turn owns the lifecycle, so the caller never derives then.
pub(super) fn derive(i: &Inputs) -> Target {
    if i.cycle_open || i.holding > 0 || i.grace_active {
        // While the turn's `waiting_for_human(None)` is still owed, say so in the
        // persisted reason so a restart can settle it visibly (boot sweep).
        let reason = if i.turn_end_unannounced {
            BACKGROUND_TURN_ENDED_REASON
        } else {
            BACKGROUND_REASON
        };
        return Target(LifecycleState::Working, Some(reason));
    }
    let reason = if i.turn_end_unannounced {
        None
    } else {
        Some(BACKGROUND_SETTLED_REASON)
    };
    Target(LifecycleState::WaitingForHuman, reason)
}

fn lapse_text(label: &str, why: HoldLapse) -> String {
    match why {
        HoldLapse::AliveCap => format!(
            "Background task \u{201c}{label}\u{201d} is still running after 60 min \u{2014} no longer shown as agent work."
        ),
        HoldLapse::Unverified => format!(
            "Background task \u{201c}{label}\u{201d} showed no sign of life for 10 min \u{2014} no longer shown as agent work."
        ),
    }
}

/// Ids of `lapsed` not announced yet (marking them announced). Ids that left
/// the lapsed set are forgotten first, so a task that re-arms and lapses again
/// is announced again and the set stays bounded by the live lapsed tasks.
pub(super) fn take_fresh_lapses<'a>(
    announced: &mut HashSet<String>,
    lapsed: &'a [LapsedTask],
) -> Vec<&'a LapsedTask> {
    announced.retain(|id| lapsed.iter().any(|l| l.id == *id));
    lapsed
        .iter()
        .filter(|l| announced.insert(l.id.clone()))
        .collect()
}

impl JsonAgentSession {
    /// The single JSON-channel lifecycle writer. Takes `lifecycle_lock`,
    /// then no-ops if released (checked INSIDE the lock).
    pub(super) async fn write_lifecycle(&self, new_state: LifecycleState, reason: Option<&str>) {
        let _guard = self.0.lifecycle_lock.lock().await;
        self.write_lifecycle_locked(new_state, reason).await;
    }

    /// Body of [`Self::write_lifecycle`]; the caller MUST hold `lifecycle_lock`.
    pub(super) async fn write_lifecycle_locked(
        &self,
        new_state: LifecycleState,
        reason: Option<&str>,
    ) {
        if self.is_released() {
            return;
        }
        let (project_id, session_id) = {
            let mut s = self.0.state.lock().unwrap();
            s.last_written = new_state;
            s.last_written_reason = reason.map(str::to_string);
            (s.project.id.clone(), s.session.id.clone())
        };
        let lifecycle = SessionLifecycle {
            state: new_state,
            reason: reason.map(str::to_string),
            last_transition_at: crate::util::now_iso_8601(),
        };
        let _ = self
            .0
            .store_handle
            .update_session_lifecycle(&project_id, &session_id, lifecycle)
            .await;
        self.0.broadcaster.send(ServerEvent::SessionState {
            session_id,
            state: new_state,
            reason: reason.map(str::to_string),
        });
    }

    /// `working` for a human-originated turn (send / chat / resubmit / create /
    /// scheduled delivery), reason `None`. Skipped unless a turn is running or
    /// queued: a fast turn may already have finished (drain's final
    /// settle) before the caller got here, and a late `working`
    /// would then stick.
    pub async fn write_working_for_human_turn(&self) {
        let _guard = self.0.lifecycle_lock.lock().await;
        let live = {
            let s = self.0.state.lock().unwrap();
            s.running || !s.queue.is_empty()
        };
        if live {
            self.write_lifecycle_locked(LifecycleState::Working, None)
                .await;
        }
    }

    /// Re-derive and persist the lifecycle; takes `lifecycle_lock`.
    pub(super) async fn reconcile_lifecycle(&self) {
        let _guard = self.0.lifecycle_lock.lock().await;
        self.reconcile_lifecycle_locked().await;
    }

    /// Fire-and-forget [`Self::reconcile_lifecycle`] for synchronous callers.
    pub(super) fn spawn_reconcile(&self) {
        let this = self.clone();
        tokio::spawn(async move { this.reconcile_lifecycle().await });
    }

    /// The only prompt-less lifecycle decider. The caller MUST hold
    /// `lifecycle_lock`. Inputs are read fresh; the `state` lock is dropped
    /// before the registry is consulted (order: `lifecycle_lock` -> registry).
    pub(super) async fn reconcile_lifecycle_locked(&self) {
        if self.is_released() {
            return;
        }
        let (running, cycle_open, unann, last, last_reason) = {
            let s = self.0.state.lock().unwrap();
            (
                // A queued turn is about to own the lifecycle as well.
                s.running || !s.queue.is_empty(),
                s.bg_working,
                s.turn_end_unannounced,
                s.last_written,
                s.last_written_reason.clone(),
            )
        };
        if running {
            return;
        }
        let hold = self.0.tasks.hold();
        let Target(st, reason) = derive(&Inputs {
            cycle_open,
            holding: hold.holding,
            grace_active: hold.grace_active,
            turn_end_unannounced: unann,
        });
        if st == LifecycleState::WaitingForHuman {
            // Already waiting and nothing new to announce: leave the stored
            // reason alone (e.g. `ready` on a never-prompted session).
            if last == LifecycleState::WaitingForHuman && !unann {
                return;
            }
            if reason.is_none() {
                self.0.state.lock().unwrap().turn_end_unannounced = false;
            }
        }
        if st == last && reason.map(str::to_string) == last_reason {
            return;
        }
        self.write_lifecycle_locked(st, reason).await;
    }

    /// Follow the registry's hold watch: announce each lapse once, then
    /// reconcile. Exits when the registry closes or the session is released.
    pub(super) fn start_hold_follower(&self) {
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            tracing::warn!(
                "no tokio runtime: JSON lifecycle will not follow background-task holds"
            );
            return;
        };
        let weak = Arc::downgrade(&self.0);
        let mut rx = self.0.tasks.subscribe_hold();
        handle.spawn(async move {
            // A hold published before the subscription is not a "change":
            // pick it up once now (an untouched registry needs no write).
            let mut pending = *rx.borrow() != TaskHold::default();
            loop {
                if !pending && rx.changed().await.is_err() {
                    return;
                }
                pending = false;
                let Some(inner) = weak.upgrade() else { return };
                let this = JsonAgentSession(inner);
                if this.is_released() {
                    return;
                }
                let hold = rx.borrow_and_update().clone();
                let texts: Vec<String> = {
                    let mut s = this.0.state.lock().unwrap();
                    take_fresh_lapses(&mut s.lapse_announced, &hold.lapsed)
                        .into_iter()
                        .map(|l| lapse_text(&l.label, l.why))
                        .collect()
                };
                for t in texts {
                    this.emit_status(&t);
                }
                this.reconcile_lifecycle().await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lapsed(ids: &[&str]) -> Vec<LapsedTask> {
        ids.iter()
            .map(|id| LapsedTask {
                id: (*id).into(),
                label: (*id).into(),
                why: HoldLapse::Unverified,
            })
            .collect()
    }

    #[test]
    fn lapse_is_announced_once_but_again_after_a_re_arm() {
        let mut seen = HashSet::new();
        let ids = |v: Vec<&LapsedTask>| v.iter().map(|l| l.id.clone()).collect::<Vec<_>>();
        let a = lapsed(&["a"]);
        assert_eq!(ids(take_fresh_lapses(&mut seen, &a)), ["a"]);
        assert!(take_fresh_lapses(&mut seen, &a).is_empty(), "no repeat");
        let ab = lapsed(&["a", "b"]);
        assert_eq!(ids(take_fresh_lapses(&mut seen, &ab)), ["b"]);
        // `a` re-armed (left the lapsed set), `b` still lapsed.
        let b = lapsed(&["b"]);
        assert!(take_fresh_lapses(&mut seen, &b).is_empty());
        assert_eq!(seen.len(), 1, "set tracks only currently lapsed ids");
        // `a` lapses again: announced again.
        assert_eq!(ids(take_fresh_lapses(&mut seen, &ab)), ["a"]);
        take_fresh_lapses(&mut seen, &[]);
        assert!(seen.is_empty());
    }

    #[test]
    fn derive_table() {
        for cycle_open in [false, true] {
            for holding in [0usize, 2] {
                for grace_active in [false, true] {
                    for unann in [false, true] {
                        let i = Inputs {
                            cycle_open,
                            holding,
                            grace_active,
                            turn_end_unannounced: unann,
                        };
                        let want = if cycle_open || holding > 0 || grace_active {
                            Target(
                                LifecycleState::Working,
                                Some(if unann {
                                    "background-turn-ended"
                                } else {
                                    "background"
                                }),
                            )
                        } else if unann {
                            Target(LifecycleState::WaitingForHuman, None)
                        } else {
                            Target(LifecycleState::WaitingForHuman, Some("background-settled"))
                        };
                        assert_eq!(derive(&i), want, "{i:?}");
                    }
                }
            }
        }
    }
}
