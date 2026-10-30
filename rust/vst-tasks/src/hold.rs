//! The hold rule: which running tasks count as agent work right now. Pure
//! over `Task` + `now`; the registry owns grace (`last_hold_end_ms`) so the
//! mutation that drops `holding` to 0 stamps it synchronously.

use vst_types::TaskKind;

use crate::task::{Inner, Task, TaskLiveness};
use crate::{TASK_END_GRACE_MS, TASK_HOLD_CAP_MS, TASK_UNVERIFIED_HOLD_MS};

/// Why a running task no longer counts as agent work.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HoldLapse {
    /// Output writer still alive, but the 60 min cap passed.
    AliveCap,
    /// No liveness evidence and no activity for 10 min.
    Unverified,
}

/// A running task whose hold lapsed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LapsedTask {
    pub id: String,
    pub label: String,
    pub why: HoldLapse,
}

/// Snapshot of the registry's contribution to a session's lifecycle.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TaskHold {
    /// Running tasks (current epoch) that count as agent work right now.
    pub holding: usize,
    /// Running tasks whose hold lapsed, in start order.
    pub lapsed: Vec<LapsedTask>,
    /// Registry-clock unix ms at which `holding` last dropped from >0 to 0.
    pub last_hold_end_ms: Option<i64>,
    /// `now < last_hold_end_ms + TASK_END_GRACE_MS` on the registry clock. Part
    /// of the value so grace EXPIRY is a real change that wakes subscribers.
    pub grace_active: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HoldState {
    Holds,
    Lapsed(HoldLapse),
    No,
}

/// A command whose liveness is backed by a probeable output file.
fn verified(t: &Task) -> bool {
    t.output_path.is_some() && matches!(t.liveness, TaskLiveness::Pending | TaskLiveness::Alive)
}

pub(crate) fn hold_of(t: &Task, now: i64) -> HoldState {
    if !t.is_running() {
        return HoldState::No;
    }
    if t.authoritative && t.kind != TaskKind::Monitor {
        // The harness said it runs: its state beats the probe. Still bounded.
        return if t.paused {
            HoldState::No
        } else if now >= t.started_ms + TASK_HOLD_CAP_MS {
            HoldState::Lapsed(HoldLapse::AliveCap)
        } else {
            HoldState::Holds
        };
    }
    match t.kind {
        TaskKind::Subagent => HoldState::Holds,
        TaskKind::Command => {
            if t.liveness == TaskLiveness::Dead {
                HoldState::No
            } else if now >= t.started_ms + TASK_HOLD_CAP_MS {
                // The cap bounds every command, verified or not: an unverified
                // one whose output keeps growing must not hold forever.
                HoldState::Lapsed(HoldLapse::AliveCap)
            } else if verified(t) || now < t.last_activity_ms + TASK_UNVERIFIED_HOLD_MS {
                HoldState::Holds
            } else {
                HoldState::Lapsed(HoldLapse::Unverified)
            }
        }
        TaskKind::Monitor => HoldState::No,
    }
}

/// Instant at which a currently-holding task's hold lapses (None once lapsed).
pub(crate) fn hold_deadline(t: &Task) -> Option<i64> {
    if !t.is_running() || t.lapse.is_some() {
        return None;
    }
    let cap = t.started_ms + TASK_HOLD_CAP_MS;
    if t.authoritative && t.kind != TaskKind::Monitor {
        return (!t.paused).then_some(cap);
    }
    if t.kind != TaskKind::Command || t.liveness == TaskLiveness::Dead {
        return None;
    }
    Some(if verified(t) {
        cap
    } else {
        cap.min(t.last_activity_ms + TASK_UNVERIFIED_HOLD_MS)
    })
}

impl Inner {
    fn count_holding(&self, now: i64) -> usize {
        self.tasks
            .iter()
            .filter(|t| hold_of(t, now) == HoldState::Holds)
            .count()
    }

    /// Recompute `holding`; on a `>0 -> 0` edge stamp `last_hold_end_ms` when
    /// `grace` says the end can be followed by a task-notification cycle
    /// (probe death, stale, cap lapse, adapter replaced, a structured `Ended`
    /// signal: the harness wakes the model with a task notification). Ends the
    /// session already knows about (`TurnSettled`, `turn_ended`, in-turn
    /// subagent results) pass `false`: no phantom background.
    pub(crate) fn note_hold(&mut self, now: i64, grace: bool) {
        let holding = self.count_holding(now);
        if grace && self.prev_holding > 0 && holding == 0 {
            self.last_hold_end_ms = Some(now);
        }
        self.prev_holding = holding;
    }

    /// Instant the grace window ends, if it is still in the future.
    pub(crate) fn grace_deadline(&self, now: i64) -> Option<i64> {
        self.last_hold_end_ms
            .map(|e| e + TASK_END_GRACE_MS)
            .filter(|d| *d > now)
    }

    pub(crate) fn hold(&self, now: i64) -> TaskHold {
        let mut running: Vec<&Task> = self.tasks.iter().filter(|t| t.is_running()).collect();
        running.sort_by_key(|t| t.started_ms);
        let mut holding = 0;
        let mut lapsed = Vec::new();
        for t in running {
            match hold_of(t, now) {
                HoldState::Holds => holding += 1,
                HoldState::Lapsed(why) => lapsed.push(LapsedTask {
                    id: t.id.clone(),
                    label: t.label.clone(),
                    why,
                }),
                HoldState::No => {}
            }
        }
        TaskHold {
            holding,
            lapsed,
            last_hold_end_ms: self.last_hold_end_ms,
            grace_active: self
                .last_hold_end_ms
                .is_some_and(|e| now < e + TASK_END_GRACE_MS),
        }
    }
}
