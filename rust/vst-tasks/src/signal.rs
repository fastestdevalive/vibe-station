//! Structured task signals (`TaskObservation::Confirmed` / `Ended`): the
//! harness SAYS a task is running / paused / over, which beats the OS probe.
//!
//! Signals and the tool rows that create tasks reach the registry from
//! different sinks, so their relative order is not guaranteed. A signal that
//! matches no task yet is parked in a bounded early queue and adopted when the
//! task is created (or when a later `Confirmed` teaches us its second id), so
//! the result is order-independent and a transcript rebuild equals live
//! observation.

use vst_types::{TaskKind, TaskState};

use crate::hold::HoldLapse;
use crate::task::{Inner, Task};
use crate::{MAX_LAUNCHES, REASON_HOLD_CAP, REASON_PAUSED, REASON_UNVERIFIED};

/// A parked `Confirmed`: `(id, tool_id, paused)`.
pub(crate) type EarlyConfirmed = (String, Option<String>, bool);
/// A parked `Ended`: `(id, tool_id, state, reason)`.
pub(crate) type EarlyEnded = (String, Option<String>, TaskState, Option<String>);

/// A signal `(id, tool_id)` names a task iff it equals the task's own id, the
/// id the harness gave it (`ext_id`), or its originating tool call id.
fn matches(t: &Task, id: &str, tool_id: Option<&str>) -> bool {
    t.id == id
        || t.ext_id.as_deref() == Some(id)
        || tool_id.is_some_and(|tid| !tid.is_empty() && t.tool_id == tid)
}

fn lapse_reason(lapse: Option<HoldLapse>) -> Option<String> {
    lapse.map(|w| {
        match w {
            HoldLapse::AliveCap => REASON_HOLD_CAP,
            HoldLapse::Unverified => REASON_UNVERIFIED,
        }
        .to_string()
    })
}

fn push_bounded<T>(q: &mut std::collections::VecDeque<T>, v: T) {
    if q.len() >= MAX_LAUNCHES {
        q.pop_front();
    }
    q.push_back(v);
}

impl Task {
    /// Record the harness's state for this task. A finished one is never
    /// re-opened, except a subagent the harness resumed: its `Confirmed`
    /// carries a NEW tool call id for the same harness task id.
    fn confirm(&mut self, id: &str, tool_id: Option<&str>, paused: bool) {
        if id != self.id {
            self.ext_id = Some(id.to_string());
        }
        let resumed = !self.is_running()
            && self.kind == TaskKind::Subagent
            && tool_id.is_some_and(|tid| !tid.is_empty() && tid != self.tool_id);
        if resumed {
            self.state = TaskState::Running;
            self.reason = None;
            self.ended_ms = None;
            self.stale_ms = None;
            self.background = true;
            self.lapse = None;
        }
        if !self.is_running() {
            return;
        }
        self.authoritative = true;
        self.paused = paused;
        self.next_probe_ms = None;
        if paused {
            self.reason = Some(REASON_PAUSED.to_string());
        } else if self.reason.as_deref() == Some(REASON_PAUSED) {
            self.reason = lapse_reason(self.lapse);
        }
    }
}

impl Inner {
    /// `Confirmed`: mark a matching task authoritative; park it if none matches.
    /// Never creates a task (monitors / workflows / foreground Bash stay invisible).
    pub(crate) fn apply_confirmed(
        &mut self,
        id: String,
        tool_id: Option<String>,
        paused: bool,
        ts: i64,
    ) {
        let mut hit = None;
        for t in &mut self.tasks {
            if matches(t, &id, tool_id.as_deref()) {
                t.confirm(&id, tool_id.as_deref(), paused);
                hit = Some(t.id.clone());
                break;
            }
        }
        match hit {
            // The task now answers to a second id: an `Ended` that arrived
            // under that id before we knew it can be applied now.
            Some(task_id) => self.apply_parked_ends(&task_id, ts),
            None => push_bounded(&mut self.confirmed_early, (id, tool_id, paused)),
        }
    }

    /// `Ended`: end a matching running task; park it if none matches.
    pub(crate) fn apply_ended(
        &mut self,
        id: String,
        tool_id: Option<String>,
        state: TaskState,
        reason: Option<String>,
        ts: i64,
    ) {
        if state == TaskState::Running {
            return;
        }
        let mut found = false;
        for t in &mut self.tasks {
            if matches(t, &id, tool_id.as_deref()) {
                found = true;
                // A real end also wins over a "Stale" guess (restart / no
                // signal), exactly as a transcript rebuild would conclude.
                if t.is_running() || t.state == TaskState::Stale {
                    t.end(state, reason.clone(), ts);
                }
                break;
            }
        }
        if !found {
            push_bounded(&mut self.ended_early, (id, tool_id, state, reason));
        }
    }

    fn apply_parked_ends(&mut self, task_id: &str, ts: i64) {
        let Some(pos) = self.tasks.iter().position(|t| t.id == task_id) else {
            return;
        };
        let mut i = 0;
        while i < self.ended_early.len() {
            let hit = {
                let (id, tool_id, _, _) = &self.ended_early[i];
                matches(&self.tasks[pos], id, tool_id.as_deref())
            };
            if hit {
                let (_, _, state, reason) = self.ended_early.remove(i).expect("index in range");
                let t = &mut self.tasks[pos];
                if t.is_running() {
                    t.end(state, reason, ts);
                }
            } else {
                i += 1;
            }
        }
    }

    /// Called for a freshly built task before it is stored: adopt any parked
    /// `Confirmed`, then any parked `Ended` (a task that finished before its
    /// own tool result was seen is created already ended, so it never holds).
    pub(crate) fn adopt_early(&mut self, t: &mut Task, ts: i64) {
        let mut i = 0;
        while i < self.confirmed_early.len() {
            let hit = {
                let (id, tool_id, _) = &self.confirmed_early[i];
                matches(t, id, tool_id.as_deref())
            };
            if hit {
                let (id, tool_id, paused) = self.confirmed_early.remove(i).expect("index in range");
                t.confirm(&id, tool_id.as_deref(), paused);
            } else {
                i += 1;
            }
        }
        let mut i = 0;
        while i < self.ended_early.len() {
            let hit = {
                let (id, tool_id, _, _) = &self.ended_early[i];
                matches(t, id, tool_id.as_deref())
            };
            if hit {
                let (_, _, state, reason) = self.ended_early.remove(i).expect("index in range");
                if t.is_running() && t.kind != TaskKind::Monitor {
                    t.end(state, reason, ts);
                }
            } else {
                i += 1;
            }
        }
    }
}
