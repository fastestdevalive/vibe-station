//! Task rows and the pure state machine over them (no I/O, no locks, no
//! timers — `registry.rs` owns those). Every time is unix ms taken from event
//! `ts`, so replaying a transcript reproduces the live result.

use std::collections::VecDeque;

use vst_types::{NormalizedEvent, TaskKind, TaskOutputKind, TaskState, TaskSummary};

use crate::clock::{format_ms, parse_ts};
use crate::hold::{hold_deadline, hold_of, HoldLapse, HoldState};
use crate::liveness::Liveness;
use crate::observation::TaskObservation;
use crate::output::lexical_ok;
use crate::signal::{EarlyConfirmed, EarlyEnded};
use crate::{
    MAX_LABEL_CHARS, MAX_LAUNCHES, MAX_RING_LINES, MAX_TASKS, REASON_EXITED, REASON_HOLD_CAP,
    REASON_NO_END_SIGNAL, REASON_RESTARTED, REASON_TURN_ENDED, REASON_UNVERIFIED,
    TASK_COMMAND_STALE_MS, TASK_DEAD_CONFIRMATIONS, TASK_EXPIRY_MS, TASK_HOLD_CAP_MS,
    TASK_PROBE_FIRST_MS, TASK_PROBE_INTERVAL_MS, TASK_SUBAGENT_STALE_MS,
};

/// Stored per-task liveness (probe results are mapped onto this).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TaskLiveness {
    /// Output path known, no probe result yet (held under the alive rule).
    Pending,
    Alive,
    Unknown,
    /// Probe confirmed the command exited.
    Dead,
}

pub(crate) struct Task {
    pub id: String,
    pub tool_id: String,
    pub kind: TaskKind,
    pub label: String,
    pub state: TaskState,
    pub reason: Option<String>,
    pub started_ms: i64,
    pub ended_ms: Option<i64>,
    pub stale_ms: Option<i64>,
    pub last_activity_ms: i64,
    pub output_kind: TaskOutputKind,
    pub output_rev: u64,
    pub output_path: Option<String>,
    pub background: bool,
    pub turn_id: Option<String>,
    pub ring: VecDeque<String>,
    pub ring_dropped: bool,
    pub final_text: Option<String>,
    pub liveness: TaskLiveness,
    pub no_writer_count: u8,
    pub next_probe_ms: Option<i64>,
    /// A probe for this task is in flight.
    pub probing: bool,
    /// Why the hold lapsed (drives `reason` on the still-running row).
    pub lapse: Option<HoldLapse>,
    /// The harness's own id for this task when it differs from `id`
    /// (a subagent's agent id; our `id` is the Agent tool call id).
    pub ext_id: Option<String>,
    /// The harness said this task is running: its state beats the liveness probe.
    pub authoritative: bool,
    /// The harness said this task is paused (does not hold).
    pub paused: bool,
}

/// Initial liveness + first probe time for a command.
fn initial_liveness(path: Option<&str>, ts: i64) -> (TaskLiveness, Option<i64>) {
    match path {
        Some(_) => (TaskLiveness::Pending, Some(ts + TASK_PROBE_FIRST_MS)),
        None => (TaskLiveness::Unknown, None),
    }
}

impl Task {
    pub(crate) fn is_running(&self) -> bool {
        self.state == TaskState::Running
    }

    /// When a running task goes `Stale` for lack of activity.
    fn stale_deadline(&self) -> Option<i64> {
        if !self.is_running() {
            return None;
        }
        if self.authoritative && self.kind != TaskKind::Monitor {
            // The harness said it runs: the same shape as a verified command
            // (full cap, then one stale window), for subagents too.
            let by_activity = self.last_activity_ms
                + if self.kind == TaskKind::Command {
                    TASK_COMMAND_STALE_MS
                } else {
                    TASK_SUBAGENT_STALE_MS
                };
            return Some(
                by_activity.max(self.started_ms + TASK_HOLD_CAP_MS + TASK_COMMAND_STALE_MS),
            );
        }
        match self.kind {
            TaskKind::Command => {
                let by_activity = self.last_activity_ms + TASK_COMMAND_STALE_MS;
                // A command whose output file still has a live writer holds
                // for the full cap, and its lapse stays visible as a running
                // row for one stale window, before the no-end-signal guess.
                if self.output_path.is_some()
                    && matches!(self.liveness, TaskLiveness::Pending | TaskLiveness::Alive)
                {
                    Some(
                        by_activity.max(self.started_ms + TASK_HOLD_CAP_MS + TASK_COMMAND_STALE_MS),
                    )
                } else {
                    Some(by_activity)
                }
            }
            // Every running subagent is bounded, sync ones too: their normal
            // fallback is `turn_ended(turn_id)`, but a subagent started under
            // an out-of-band `notif-*` turn id is never covered by that call.
            TaskKind::Subagent => Some(self.last_activity_ms + TASK_SUBAGENT_STALE_MS),
            _ => None,
        }
    }

    /// When a non-running task is dropped.
    fn expiry(&self) -> Option<i64> {
        match self.state {
            TaskState::Running => None,
            TaskState::Stale => self.stale_ms.map(|t| t + TASK_EXPIRY_MS),
            _ => self.ended_ms.map(|t| t + TASK_EXPIRY_MS),
        }
    }

    pub(crate) fn summary(&self) -> TaskSummary {
        TaskSummary {
            id: self.id.clone(),
            tool_id: self.tool_id.clone(),
            kind: self.kind,
            label: self.label.clone(),
            state: self.state,
            reason: self.reason.clone(),
            started_at: format_ms(self.started_ms),
            ended_at: self.ended_ms.map(format_ms),
            last_activity_at: Some(format_ms(self.last_activity_ms)),
            output_kind: self.output_kind,
            output_rev: self.output_rev,
            output_path: if self.output_kind == TaskOutputKind::File {
                self.output_path.clone()
            } else {
                None
            },
            can_stop: false,
        }
    }

    pub(crate) fn end(&mut self, state: TaskState, reason: Option<String>, at: i64) {
        self.state = state;
        self.reason = reason;
        if state == TaskState::Stale {
            self.stale_ms = Some(at);
        } else {
            self.ended_ms = Some(at);
        }
    }
}

/// A buffered operation received while a rebuild was in flight.
pub(crate) enum Op {
    Obs {
        event_id: String,
        ts_ms: i64,
        turn_id: Option<String>,
        obs: Vec<TaskObservation>,
    },
    TurnEnded(String),
    BumpEpoch,
    /// The adapter of this epoch went away (see `TaskRegistry::adapter_gone`).
    AdapterGone(u64),
}

#[derive(Default)]
pub(crate) struct Inner {
    pub tasks: Vec<Task>,
    /// `(tool_id, command)` of background launches, oldest first.
    pub launches: VecDeque<(String, String)>,
    pub rev: u64,
    /// Last broadcast summaries with `last_activity_at` cleared.
    pub last_sent: Option<Vec<TaskSummary>>,
    pub rebuilding: bool,
    pub pending: Vec<Op>,
    pub epoch: u64,
    pub closed: bool,
    pub flush_scheduled: bool,
    pub timer_spawned: bool,
    /// `holding` as of the last `note_hold` (edge detection).
    pub prev_holding: usize,
    /// When `holding` last dropped from >0 to 0 (grace source of truth).
    pub last_hold_end_ms: Option<i64>,
    /// `Confirmed` signals that matched no task yet (bounded, FIFO).
    pub confirmed_early: VecDeque<EarlyConfirmed>,
    /// `Ended` signals that matched no task yet (bounded, FIFO).
    pub ended_early: VecDeque<EarlyEnded>,
}

pub(crate) fn clip(s: &str, max: usize) -> String {
    let one_line = s.lines().next().unwrap_or("").trim();
    if one_line.chars().count() <= max {
        one_line.to_string()
    } else {
        let mut out: String = one_line.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

impl Inner {
    pub(crate) fn find_mut(&mut self, id: &str) -> Option<&mut Task> {
        self.tasks.iter_mut().find(|t| t.id == id)
    }

    /// Summaries as sent on the wire (`last_activity_at` set).
    pub(crate) fn summaries(&self) -> Vec<TaskSummary> {
        self.tasks.iter().map(Task::summary).collect()
    }

    /// Summaries with `last_activity_at` cleared: the broadcast-change key.
    pub(crate) fn key(&self) -> Vec<TaskSummary> {
        self.tasks
            .iter()
            .map(|t| {
                let mut s = t.summary();
                s.last_activity_at = None;
                s
            })
            .collect()
    }

    /// True when the key differs from what was last broadcast (never-sent and
    /// empty counts as unchanged).
    pub(crate) fn changed_since_sent(&self) -> bool {
        let key = self.key();
        match &self.last_sent {
            Some(sent) => *sent != key,
            None => !key.is_empty(),
        }
    }

    /// Earliest instant at which `evaluate` would change something.
    pub(crate) fn next_deadline(&self, now: i64) -> Option<i64> {
        self.tasks
            .iter()
            .flat_map(|t| {
                let probe = t.next_probe_ms.filter(|_| t.is_running() && !t.probing);
                [
                    t.stale_deadline().or_else(|| t.expiry()),
                    hold_deadline(t),
                    probe,
                ]
            })
            .flatten()
            .chain(self.grace_deadline(now))
            .min()
    }

    /// Lazy staleness + expiry as of `now`.
    pub(crate) fn evaluate(&mut self, now: i64) {
        for t in &mut self.tasks {
            if let Some(d) = t.stale_deadline() {
                if d <= now {
                    t.end(TaskState::Stale, Some(REASON_NO_END_SIGNAL.into()), d);
                }
            }
        }
        for t in &mut self.tasks {
            if !t.is_running() {
                continue;
            }
            match hold_of(t, now) {
                HoldState::Lapsed(why) if t.lapse != Some(why) => {
                    t.lapse = Some(why);
                    t.reason = Some(
                        match why {
                            HoldLapse::AliveCap => REASON_HOLD_CAP,
                            HoldLapse::Unverified => REASON_UNVERIFIED,
                        }
                        .into(),
                    );
                }
                HoldState::Holds if t.lapse.is_some() => {
                    // Activity or a probe re-armed the hold.
                    t.lapse = None;
                    t.reason = None;
                }
                _ => {}
            }
        }
        self.tasks.retain(|t| t.expiry().map_or(true, |e| e > now));
        self.note_hold(now, true);
    }

    /// Apply one liveness probe result to a running command.
    pub(crate) fn apply_probe(&mut self, id: &str, result: Liveness, now: i64) {
        if let Some(t) = self.find_mut(id) {
            t.probing = false;
            // The harness's own state beats the probe: ignore a late result.
            if t.authoritative {
                self.note_hold(now, true);
                return;
            }
            if t.is_running() && t.kind == TaskKind::Command {
                match result {
                    // No probe actually ran: change nothing, retry soon.
                    Liveness::Skipped => {
                        t.next_probe_ms = Some(now + TASK_PROBE_FIRST_MS);
                        self.note_hold(now, true);
                        return;
                    }
                    Liveness::Alive => {
                        t.liveness = TaskLiveness::Alive;
                        t.no_writer_count = 0;
                    }
                    Liveness::Unknown => {
                        t.liveness = TaskLiveness::Unknown;
                        t.no_writer_count = 0;
                    }
                    Liveness::NoWriter => {
                        t.no_writer_count = t.no_writer_count.saturating_add(1);
                        if t.no_writer_count >= TASK_DEAD_CONFIRMATIONS {
                            t.liveness = TaskLiveness::Dead;
                            t.end(TaskState::Done, Some(REASON_EXITED.into()), now);
                        }
                    }
                }
                t.next_probe_ms = t.is_running().then_some(now + TASK_PROBE_INTERVAL_MS);
            }
        }
        self.note_hold(now, true);
    }

    fn push_task(&mut self, task: Task) {
        if self.tasks.len() >= MAX_TASKS {
            // Prefer evicting the oldest finished row; else the oldest running.
            let victim = self
                .tasks
                .iter()
                .enumerate()
                .filter(|(_, t)| !t.is_running())
                .min_by_key(|(_, t)| t.ended_ms.or(t.stale_ms).unwrap_or(t.started_ms))
                .or_else(|| {
                    self.tasks
                        .iter()
                        .enumerate()
                        .min_by_key(|(_, t)| t.started_ms)
                })
                .map(|(i, _)| i);
            if let Some(i) = victim {
                self.tasks.remove(i);
            }
        }
        self.tasks.push(task);
    }

    /// Mark every still-running task stale because its adapter process is gone.
    pub(crate) fn stale_all_running(&mut self, now: i64) {
        for t in &mut self.tasks {
            if t.is_running() {
                t.end(TaskState::Stale, Some(REASON_RESTARTED.into()), now);
            }
        }
        self.note_hold(now, true);
    }

    /// The turn ended: its synchronous subagents can no longer finish.
    pub(crate) fn turn_ended(&mut self, turn_id: &str, now: i64) {
        for t in &mut self.tasks {
            if t.is_running()
                && t.kind == TaskKind::Subagent
                && !t.background
                && t.turn_id.as_deref() == Some(turn_id)
            {
                t.end(TaskState::Stopped, Some(REASON_TURN_ENDED.into()), now);
            }
        }
        self.note_hold(now, false);
    }

    /// Any event from the agent (in-band or out-of-band) proves it is alive:
    /// it counts as activity for running commands (no broadcast). Returns
    /// whether a command whose hold had lapsed for lack of activity was
    /// touched, i.e. whether the hold decision may now differ.
    pub(crate) fn bump_command_activity(&mut self, ts_ms: i64) -> bool {
        let mut may_rearm = false;
        for t in &mut self.tasks {
            if t.is_running() && t.kind == TaskKind::Command && ts_ms > t.last_activity_ms {
                t.last_activity_ms = ts_ms;
                may_rearm |= t.lapse == Some(HoldLapse::Unverified);
            }
        }
        may_rearm
    }

    pub(crate) fn apply(
        &mut self,
        obs: Vec<TaskObservation>,
        ts_ms: i64,
        turn_id: Option<&str>,
        now: i64,
    ) {
        // A time-based lapse/stale edge that is already due belongs to the
        // time, not to this observation: record it (with grace) first.
        self.note_hold(now, true);
        // A structured `Ended` (the harness's own end signal) arms grace: the
        // model is woken with a task notification, so a cycle usually follows.
        let had_ended = obs
            .iter()
            .any(|o| matches!(o, TaskObservation::Ended { .. }));
        for o in obs {
            self.apply_one(o, ts_ms, turn_id);
        }
        self.bump_command_activity(ts_ms);
        // Other edges caused by observations (subagent result, `TurnSettled`)
        // carry no grace.
        self.note_hold(now, had_ended);
    }

    fn apply_one(&mut self, o: TaskObservation, ts: i64, turn_id: Option<&str>) {
        match o {
            TaskObservation::CommandLaunched { tool_id, command } => {
                if self.launches.iter().any(|(t, _)| *t == tool_id) {
                    return;
                }
                if self.launches.len() >= MAX_LAUNCHES {
                    self.launches.pop_front();
                }
                self.launches.push_back((tool_id, command));
            }
            TaskObservation::CommandBackgrounded {
                tool_id,
                task_id,
                output_path,
            } => {
                let Some(command) = self
                    .launches
                    .iter()
                    .find(|(t, _)| *t == tool_id)
                    .map(|(_, c)| c.clone())
                else {
                    return;
                };
                if task_id.is_empty()
                    || task_id.len() > 128
                    || self.tasks.iter().any(|t| t.id == task_id)
                {
                    return;
                }
                let path = output_path.filter(|p| lexical_ok(p, &task_id));
                let (liveness, next_probe_ms) = initial_liveness(path.as_deref(), ts);
                let mut task = Task {
                    id: task_id,
                    tool_id,
                    kind: TaskKind::Command,
                    label: clip(&command, MAX_LABEL_CHARS),
                    state: TaskState::Running,
                    reason: None,
                    started_ms: ts,
                    ended_ms: None,
                    stale_ms: None,
                    last_activity_ms: ts,
                    output_kind: if path.is_some() {
                        TaskOutputKind::File
                    } else {
                        TaskOutputKind::None
                    },
                    output_rev: 0,
                    output_path: path,
                    background: true,
                    turn_id: None,
                    ring: VecDeque::new(),
                    ring_dropped: false,
                    final_text: None,
                    liveness,
                    no_writer_count: 0,
                    next_probe_ms,
                    probing: false,
                    lapse: None,
                    ext_id: None,
                    authoritative: false,
                    paused: false,
                };
                self.adopt_early(&mut task, ts);
                self.push_task(task);
            }
            TaskObservation::SubagentStarted {
                tool_id,
                label,
                background,
            } => {
                if tool_id.is_empty() || self.tasks.iter().any(|t| t.id == tool_id) {
                    return;
                }
                let mut task = Task {
                    id: tool_id.clone(),
                    tool_id,
                    kind: TaskKind::Subagent,
                    label: clip(&label, MAX_LABEL_CHARS),
                    state: TaskState::Running,
                    reason: None,
                    started_ms: ts,
                    ended_ms: None,
                    stale_ms: None,
                    last_activity_ms: ts,
                    output_kind: TaskOutputKind::Events,
                    output_rev: 0,
                    output_path: None,
                    background,
                    turn_id: turn_id.map(str::to_string),
                    ring: VecDeque::new(),
                    ring_dropped: false,
                    final_text: None,
                    liveness: TaskLiveness::Unknown,
                    no_writer_count: 0,
                    next_probe_ms: None,
                    probing: false,
                    lapse: None,
                    ext_id: None,
                    authoritative: false,
                    paused: false,
                };
                self.adopt_early(&mut task, ts);
                self.push_task(task);
            }
            TaskObservation::SubagentNested {
                parent_tool_id,
                line,
            } => {
                let Some(t) = self.find_mut(&parent_tool_id) else {
                    return;
                };
                if t.kind != TaskKind::Subagent || !t.is_running() {
                    return;
                }
                if t.ring.len() >= MAX_RING_LINES {
                    t.ring.pop_front();
                    t.ring_dropped = true;
                }
                t.ring.push_back(clip(&line, 500));
                t.output_rev += 1;
                t.last_activity_ms = t.last_activity_ms.max(ts);
            }
            TaskObservation::SubagentFinished {
                tool_id,
                ok,
                final_text,
            } => {
                let Some(t) = self.find_mut(&tool_id) else {
                    return;
                };
                // A subagent that went Stale (no nested activity for the bound) may still finish later:
                // the real end wins over the "no end signal" guess, matching a transcript rebuild.
                if t.kind != TaskKind::Subagent || !(t.is_running() || t.state == TaskState::Stale)
                {
                    return;
                }
                if t.background && ok {
                    // The call only returned the launch receipt (plan K3): the
                    // real finish is internal to the adapter; stays running
                    // until the stale bound.
                    return;
                }
                t.final_text = final_text.clone();
                t.output_rev += 1;
                t.last_activity_ms = t.last_activity_ms.max(ts);
                if ok {
                    t.end(TaskState::Done, None, ts);
                } else {
                    let why = final_text
                        .as_deref()
                        .map(|s| clip(s, MAX_LABEL_CHARS))
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| "Subagent failed".into());
                    t.end(TaskState::Failed, Some(why), ts);
                }
            }
            TaskObservation::TurnSettled => {
                // The turn was held open until its background subagents
                // settled, so its `Result` marks their end. Fallback only: an
                // authoritative subagent (the harness confirmed it) is ended by
                // its own structured `Ended`, never by this guess.
                let Some(turn) = turn_id else { return };
                for t in &mut self.tasks {
                    if t.is_running()
                        && t.kind == TaskKind::Subagent
                        && t.background
                        && !t.authoritative
                        && t.turn_id.as_deref() == Some(turn)
                    {
                        t.end(TaskState::Done, None, ts);
                    }
                }
            }
            TaskObservation::Confirmed {
                id,
                tool_id,
                paused,
            } => self.apply_confirmed(id, tool_id, paused, ts),
            TaskObservation::Ended {
                id,
                tool_id,
                state,
                reason,
            } => self.apply_ended(id, tool_id, state, reason, ts),
        }
    }
}

/// Event time in unix ms, falling back to `now` for an unparseable `ts`.
pub(crate) fn event_ms(ev: &NormalizedEvent, now: i64) -> i64 {
    parse_ts(&ev.ts).unwrap_or(now)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch(i: &mut Inner, id: &str, ts: i64) {
        i.apply(
            vec![
                TaskObservation::CommandLaunched {
                    tool_id: format!("t-{id}"),
                    command: "sleep 9".into(),
                },
                TaskObservation::CommandBackgrounded {
                    tool_id: format!("t-{id}"),
                    task_id: id.into(),
                    output_path: None,
                },
            ],
            ts,
            None,
            ts,
        );
    }

    fn sub_started(i: &mut Inner, tool: &str, turn: &str) {
        i.apply(
            vec![TaskObservation::SubagentStarted {
                tool_id: tool.into(),
                label: "work".into(),
                background: true,
            }],
            0,
            Some(turn),
            0,
        );
    }

    fn confirm(i: &mut Inner, id: &str, tool: &str) {
        i.apply(
            vec![TaskObservation::Confirmed {
                id: id.into(),
                tool_id: Some(tool.into()),
                paused: false,
            }],
            1,
            None,
            1,
        );
    }

    /// `TurnSettled` is only the fallback: an authoritative background
    /// subagent stays running until its own structured `Ended`.
    #[test]
    fn turn_settled_does_not_end_an_authoritative_subagent() {
        let mut i = Inner::default();
        sub_started(&mut i, "s1", "t1");
        sub_started(&mut i, "s2", "t1");
        confirm(&mut i, "agent-1", "s1");
        i.apply(vec![TaskObservation::TurnSettled], 2, Some("t1"), 2);
        assert_eq!(i.tasks[0].state, TaskState::Running);
        // The unconfirmed one still falls back to the turn's end.
        assert_eq!(i.tasks[1].state, TaskState::Done);
        i.apply(
            vec![TaskObservation::Ended {
                id: "agent-1".into(),
                tool_id: Some("s1".into()),
                state: TaskState::Done,
                reason: None,
            }],
            3,
            None,
            3,
        );
        assert_eq!(i.tasks[0].state, TaskState::Done);
    }

    /// A subagent resumed outside a turn re-confirms the same harness task id
    /// under a NEW tool call id: the ended row re-opens and holds again.
    #[test]
    fn resumed_subagent_reopens_and_holds() {
        let mut i = Inner::default();
        sub_started(&mut i, "s1", "t1");
        confirm(&mut i, "agent-1", "s1");
        i.apply(
            vec![TaskObservation::Ended {
                id: "agent-1".into(),
                tool_id: None,
                state: TaskState::Done,
                reason: None,
            }],
            2,
            None,
            2,
        );
        assert_eq!(i.tasks[0].state, TaskState::Done);
        // Same tool id again (a replayed signal) does NOT re-open.
        confirm(&mut i, "agent-1", "s1");
        assert_eq!(i.tasks[0].state, TaskState::Done);
        confirm(&mut i, "agent-1", "s2");
        assert_eq!(i.tasks[0].state, TaskState::Running);
        assert!(i.tasks[0].authoritative);
        assert!(i.tasks[0].ended_ms.is_none());
        assert_eq!(i.hold(3).holding, 1);
    }

    /// A lapse that is already due when an unrelated observation lands first
    /// still arms grace (the edge belongs to the clock, not the observation).
    #[test]
    fn due_lapse_arms_grace_even_if_an_observation_lands_first() {
        let mut i = Inner::default();
        launch(&mut i, "a", 0);
        assert_eq!(i.prev_holding, 1);
        let due = crate::TASK_UNVERIFIED_HOLD_MS + 1;
        // Unrelated launch observed with an OLD event ts (no activity bump
        // for the lapsed command), `now` past the lapse.
        i.apply(
            vec![TaskObservation::CommandLaunched {
                tool_id: "other".into(),
                command: "x".into(),
            }],
            0,
            None,
            due,
        );
        assert_eq!(i.last_hold_end_ms, Some(due));
        assert!(i.hold(due).grace_active);
    }
}
