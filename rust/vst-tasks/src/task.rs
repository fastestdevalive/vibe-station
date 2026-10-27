//! Task rows and the pure state machine over them (no I/O, no locks, no
//! timers — `registry.rs` owns those). Every time is unix ms taken from event
//! `ts`, so replaying a transcript reproduces the live result.

use std::collections::VecDeque;

use vst_types::{NormalizedEvent, TaskKind, TaskOutputKind, TaskState, TaskSummary};

use crate::clock::{format_ms, parse_ts};
use crate::observation::TaskObservation;
use crate::output::lexical_ok;
use crate::{
    MAX_LABEL_CHARS, MAX_LAUNCHES, MAX_RING_LINES, MAX_TASKS, REASON_NO_END_SIGNAL,
    REASON_RESTARTED, REASON_TURN_ENDED, TASK_COMMAND_STALE_MS, TASK_EXPIRY_MS,
    TASK_SUBAGENT_STALE_MS,
};

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
        match self.kind {
            TaskKind::Command => Some(self.last_activity_ms + TASK_COMMAND_STALE_MS),
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

    fn end(&mut self, state: TaskState, reason: Option<String>, at: i64) {
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
        out_of_band: bool,
        obs: Vec<TaskObservation>,
    },
    TurnEnded(String),
    BumpEpoch,
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
    pub(crate) fn next_deadline(&self) -> Option<i64> {
        self.tasks
            .iter()
            .filter_map(|t| t.stale_deadline().or_else(|| t.expiry()))
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
        self.tasks.retain(|t| t.expiry().map_or(true, |e| e > now));
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
    }

    /// An out-of-band event proves the agent is alive: it counts as activity
    /// for running commands (no broadcast).
    pub(crate) fn bump_command_activity(&mut self, ts_ms: i64) {
        for t in &mut self.tasks {
            if t.is_running() && t.kind == TaskKind::Command && ts_ms > t.last_activity_ms {
                t.last_activity_ms = ts_ms;
            }
        }
    }

    pub(crate) fn apply(
        &mut self,
        obs: Vec<TaskObservation>,
        ts_ms: i64,
        turn_id: Option<&str>,
        out_of_band: bool,
    ) {
        for o in obs {
            self.apply_one(o, ts_ms, turn_id);
        }
        if out_of_band {
            self.bump_command_activity(ts_ms);
        }
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
                self.push_task(Task {
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
                });
            }
            TaskObservation::SubagentStarted {
                tool_id,
                label,
                background,
            } => {
                if tool_id.is_empty() || self.tasks.iter().any(|t| t.id == tool_id) {
                    return;
                }
                self.push_task(Task {
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
                });
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
            TaskObservation::Ended { id, state, reason } => {
                let Some(t) = self.find_mut(&id) else {
                    return;
                };
                if t.is_running() && state != TaskState::Running {
                    t.end(state, reason, ts);
                }
            }
        }
    }
}

/// Event time in unix ms, falling back to `now` for an unparseable `ts`.
pub(crate) fn event_ms(ev: &NormalizedEvent, now: i64) -> i64 {
    parse_ts(&ev.ts).unwrap_or(now)
}
