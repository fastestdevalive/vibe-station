//! `TaskRegistry` — the handle. Locking, scheduling (one coalescing flush, one
//! deadline timer, bounded watchers) and the rebuild/buffer protocol live
//! here; the state machine itself is pure and lives in `task.rs`.
//!
//! Lock order: `emit_lock` -> `inner` -> (released) -> `watchers`. `inner` is
//! never held across an await, a callback or a watcher operation.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use notify::RecommendedWatcher;
use tokio::runtime::Handle;
use tokio::sync::{watch, Notify};
use vst_types::{NormalizedEvent, TaskKind, TaskOutput, TaskOutputKind, TaskSummary};

use crate::clock::{format_ms, Clock};
use crate::hold::{HoldLapse, TaskHold};
use crate::liveness::{Liveness, LivenessProbe, OsWriterProbe};
use crate::observation::ObservationsFn;
use crate::output::{default_roots, read_output_file, resolve};
use crate::task::{event_ms, Inner, Op};
use crate::watch::watch_file;
use crate::{
    COALESCE_MS, MAX_PENDING_OPS, MAX_PROBES_PER_TICK, MAX_RING_LINES, MAX_TAIL_LINES, MAX_WATCHERS,
};

/// Called with `(rev, full snapshot)` when the task list visibly changed.
pub type OnChange = Arc<dyn Fn(u64, Vec<TaskSummary>) + Send + Sync>;

/// Why `output()` produced nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskOutputError {
    /// No such task (route: 404 `TASK_NOT_FOUND`).
    NotFound,
    /// Known task, but its output cannot be read (route: 409 `OUTPUT_UNAVAILABLE`).
    Unavailable,
}

struct Shared {
    inner: Mutex<Inner>,
    /// Serialises "compute rev + call `on_change`" so revs reach the callback in order.
    emit_lock: Mutex<()>,
    observe_fn: Arc<ObservationsFn>,
    on_change: OnChange,
    clock: Clock,
    timer_notify: Arc<Notify>,
    handle: Mutex<Option<Handle>>,
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
    roots: Vec<PathBuf>,
    probe: Mutex<Arc<dyn LivenessProbe>>,
    hold_tx: watch::Sender<TaskHold>,
}

impl Drop for Shared {
    fn drop(&mut self) {
        // Let the deadline timer observe the dropped registry and exit.
        self.timer_notify.notify_one();
    }
}

/// Cheap-to-clone handle to one session's task registry.
#[derive(Clone)]
pub struct TaskRegistry(Arc<Shared>);

impl TaskRegistry {
    /// `observe_fn` is the harness detector; `on_change` receives coalesced
    /// full snapshots. Spawns nothing until the first call made inside a tokio
    /// runtime.
    pub fn new(observe_fn: Arc<ObservationsFn>, on_change: OnChange) -> Self {
        Self::with_roots(observe_fn, on_change, default_roots())
    }

    /// As [`Self::new`] with explicit output roots (tests).
    pub fn with_roots(
        observe_fn: Arc<ObservationsFn>,
        on_change: OnChange,
        roots: Vec<PathBuf>,
    ) -> Self {
        let clock = Clock::new();
        let inner = Inner {
            rev: u64::try_from(clock.now_ms()).unwrap_or(0),
            ..Inner::default()
        };
        Self(Arc::new(Shared {
            inner: Mutex::new(inner),
            emit_lock: Mutex::new(()),
            observe_fn,
            on_change,
            clock,
            timer_notify: Arc::new(Notify::new()),
            handle: Mutex::new(None),
            watchers: Mutex::new(HashMap::new()),
            roots,
            probe: Mutex::new(Arc::new(OsWriterProbe)),
            hold_tx: watch::channel(TaskHold::default()).0,
        }))
    }

    /// What the registry contributes to the session lifecycle right now:
    /// evaluated synchronously, so it reflects every mutation that has
    /// returned. `TaskHold::default()` while rebuilding or closed.
    #[must_use]
    pub fn hold(&self) -> TaskHold {
        self.0.current_hold()
    }

    /// Push channel for [`Self::hold`]: fires on every change of the value.
    #[must_use]
    pub fn subscribe_hold(&self) -> watch::Receiver<TaskHold> {
        self.0.hold_tx.subscribe()
    }

    /// Replace the liveness probe (tests).
    #[doc(hidden)]
    pub fn set_probe_for_test(&self, p: Arc<dyn LivenessProbe>) {
        *self.0.probe.lock().unwrap() = p;
    }

    /// Registry clock, unix ms (SystemTime at construction + tokio time).
    #[must_use]
    pub fn now_ms(&self) -> i64 {
        self.0.clock.now_ms()
    }

    /// Registry clock as an event-style timestamp.
    #[must_use]
    pub fn now_iso(&self) -> String {
        format_ms(self.now_ms())
    }

    /// Start buffering live observations until [`Self::rebuild`] runs.
    pub fn begin_rebuild(&self) {
        let mut g = self.0.lock();
        g.rebuilding = true;
        g.pending.clear();
    }

    /// Observe an event of the agent. Every event also counts as activity for
    /// running commands: the agent is demonstrably alive (this is what keeps a
    /// probe-less command held through a long turn; its 10 min no-activity
    /// timer starts at the last event).
    pub fn observe(&self, ev: &NormalizedEvent) {
        self.0.observe(ev);
    }

    /// Observe an out-of-band (no prompt in flight) event. Same as
    /// [`Self::observe`]; kept as a distinct entry point for call-site clarity.
    pub fn observe_out_of_band(&self, ev: &NormalizedEvent) {
        self.0.observe(ev);
    }

    /// A turn ended: its synchronous subagents become `Stopped("Turn ended")`.
    pub fn turn_ended(&self, turn_id: &str) {
        let mut g = self.0.lock();
        if g.closed {
            return;
        }
        if g.rebuilding {
            g.push_pending(Op::TurnEnded(turn_id.to_string()));
            return;
        }
        g.turn_ended(turn_id, self.0.clock.now_ms());
        self.0.settle(g);
    }

    /// The session's ACP connection was replaced: every running task belongs
    /// to a dead adapter process and becomes `Stale("Agent restarted")`.
    pub fn bump_epoch(&self) {
        let mut g = self.0.lock();
        if g.closed {
            return;
        }
        if g.rebuilding {
            g.push_pending(Op::BumpEpoch);
            return;
        }
        g.epoch += 1;
        g.stale_all_running(self.0.clock.now_ms());
        self.0.settle(g);
    }

    /// The current adapter epoch (bumped per new ACP connection).
    #[must_use]
    pub fn epoch(&self) -> u64 {
        self.0.lock().epoch
    }

    /// The adapter that was current at `epoch` exited (its ext-notification
    /// channel closed without a release): its running tasks can no longer be
    /// tracked, so they become `Stale("Agent restarted")`. A no-op when the
    /// epoch moved on (a replaced connection closing late must not stale the
    /// new adapter's tasks).
    pub fn adapter_gone(&self, epoch: u64) {
        let mut g = self.0.lock();
        if g.closed {
            return;
        }
        if g.rebuilding {
            g.push_pending(Op::AdapterGone(epoch));
            return;
        }
        if g.epoch != epoch {
            return;
        }
        g.stale_all_running(self.0.clock.now_ms());
        self.0.settle(g);
    }

    /// Rebuild from transcript rows (oldest first). Everything still running
    /// afterwards is from an earlier adapter and becomes `Stale("Agent
    /// restarted")`; buffered live observations are then replayed, skipping
    /// events the rows already contained. Broadcasts the first snapshot
    /// immediately.
    pub fn rebuild(&self, rows: &[NormalizedEvent]) {
        let now = self.0.clock.now_ms();
        let mut staged = Inner::default();
        let mut consumed: HashSet<String> = HashSet::new();
        for ev in rows {
            let obs = (self.0.observe_fn)(ev);
            if obs.is_empty() {
                continue;
            }
            consumed.insert(ev.id.clone());
            staged.apply(obs, event_ms(ev, now), ev.turn_id.as_deref(), now);
        }
        staged.stale_all_running(now);
        staged.evaluate(now);
        // Rows made stale by the rebuild itself are not a fresh hold end.
        staged.last_hold_end_ms = None;

        let mut g = self.0.lock();
        if g.closed {
            return;
        }
        g.tasks = staged.tasks;
        g.launches = staged.launches;
        g.confirmed_early = staged.confirmed_early;
        g.ended_early = staged.ended_early;
        g.prev_holding = staged.prev_holding;
        g.last_hold_end_ms = staged.last_hold_end_ms;
        g.rebuilding = false;
        let pending = std::mem::take(&mut g.pending);
        for op in pending {
            match op {
                Op::Obs {
                    event_id,
                    ts_ms,
                    turn_id,
                    obs,
                } => {
                    if !consumed.contains(&event_id) {
                        g.apply(obs, ts_ms, turn_id.as_deref(), now);
                    }
                }
                Op::TurnEnded(t) => g.turn_ended(&t, now),
                Op::BumpEpoch => {
                    g.epoch += 1;
                    g.stale_all_running(now);
                }
                Op::AdapterGone(e) => {
                    if g.epoch == e {
                        g.stale_all_running(now);
                    }
                }
            }
        }
        g.evaluate(now);
        let want = watch_targets(&g);
        drop(g);
        self.0.after_unlock(want);
        // Always broadcast: `snapshot()` was `None` while rebuilding, so the
        // client is owed a first snapshot even when the list is empty.
        self.0.flush(true);
    }

    /// Current `(rev, tasks)`, or `None` while a rebuild is in flight (the
    /// list is not yet known; `rebuild` broadcasts when it finishes). `rev` is
    /// the last broadcast rev (or the registry's birth time before any), so a
    /// client dropping `rev <=` its own never discards a newer broadcast.
    #[must_use]
    pub fn snapshot(&self) -> Option<(u64, Vec<TaskSummary>)> {
        let mut g = self.0.lock();
        if g.rebuilding {
            return None;
        }
        g.evaluate(self.0.clock.now_ms());
        Some((g.rev, g.summaries()))
    }

    /// Output of one task: the tail of a command's file, or a subagent's
    /// nested-call lines (+ final message).
    pub async fn output(&self, task_id: &str, tail: usize) -> Result<TaskOutput, TaskOutputError> {
        enum Plan {
            File(String),
            Done(TaskOutput),
        }
        let plan = {
            let mut g = self.0.lock();
            g.evaluate(self.0.clock.now_ms());
            let Some(t) = g.tasks.iter().find(|t| t.id == task_id) else {
                return Err(TaskOutputError::NotFound);
            };
            match (t.kind, t.output_kind) {
                (TaskKind::Command, TaskOutputKind::File) => {
                    Plan::File(t.output_path.clone().unwrap_or_default())
                }
                (TaskKind::Subagent, _) => {
                    let n = tail.clamp(1, MAX_RING_LINES);
                    let skip = t.ring.len().saturating_sub(n);
                    Plan::Done(TaskOutput {
                        lines: t.ring.iter().skip(skip).cloned().collect(),
                        truncated: t.ring_dropped || skip > 0,
                        total_bytes: None,
                        output_kind: TaskOutputKind::Events,
                        path: None,
                        final_text: t.final_text.clone(),
                    })
                }
                _ => return Err(TaskOutputError::Unavailable),
            }
        };
        match plan {
            Plan::Done(o) => Ok(o),
            Plan::File(path) => {
                let n = tail.clamp(1, MAX_TAIL_LINES);
                let tail = read_output_file(&path, task_id, &self.0.roots, n)
                    .await
                    .map_err(|_| TaskOutputError::Unavailable)?;
                Ok(TaskOutput {
                    lines: tail.lines,
                    truncated: tail.truncated,
                    total_bytes: Some(tail.total_bytes),
                    output_kind: TaskOutputKind::File,
                    path: Some(path),
                    final_text: None,
                })
            }
        }
    }

    /// Release: stop watchers and the timer; later calls are no-ops.
    pub fn shutdown(&self) {
        // One final empty snapshot so open clients drop this session's rows.
        {
            let _emit = self.0.emit_lock.lock().unwrap();
            let rev = {
                let mut g = self.0.lock();
                if g.closed {
                    None
                } else {
                    let now = u64::try_from(self.0.clock.now_ms()).unwrap_or(0);
                    g.rev = g.rev.saturating_add(1).max(now);
                    g.last_sent = Some(Vec::new());
                    Some(g.rev)
                }
            };
            if let Some(rev) = rev {
                (self.0.on_change)(rev, Vec::new());
            }
        }
        self.0.lock().closed = true;
        self.0.send_hold(TaskHold::default());
        self.0.watchers.lock().unwrap().clear();
        self.0.timer_notify.notify_one();
    }

    /// Number of live output watchers (tests).
    #[doc(hidden)]
    #[must_use]
    pub fn watcher_count_for_test(&self) -> usize {
        self.0.watchers.lock().unwrap().len()
    }
}

impl Inner {
    fn push_pending(&mut self, op: Op) {
        if self.pending.len() >= MAX_PENDING_OPS {
            self.pending.remove(0);
        }
        self.pending.push(op);
    }
}

/// Running file-output commands that should have a watcher, capped.
fn watch_targets(g: &Inner) -> Vec<(String, String)> {
    if g.closed {
        return Vec::new();
    }
    g.tasks
        .iter()
        .filter(|t| {
            t.is_running() && t.kind == TaskKind::Command && t.output_kind == TaskOutputKind::File
        })
        .filter_map(|t| t.output_path.clone().map(|p| (t.id.clone(), p)))
        .take(MAX_WATCHERS)
        .collect()
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap()
    }

    fn observe(self: &Arc<Self>, ev: &NormalizedEvent) {
        let obs = (self.observe_fn)(ev);
        let now = self.clock.now_ms();
        let ts_ms = event_ms(ev, now);
        let mut g = self.lock();
        if g.closed {
            return;
        }
        if g.rebuilding {
            if !obs.is_empty() {
                g.push_pending(Op::Obs {
                    event_id: ev.id.clone(),
                    ts_ms,
                    turn_id: ev.turn_id.clone(),
                    obs,
                });
            }
            return;
        }
        if obs.is_empty() {
            // Hot path (text/thinking chunks): the activity bump, and a full
            // settle only when it may re-arm a hold that lapsed for lack of
            // activity.
            if g.bump_command_activity(ts_ms) {
                self.settle(g);
            }
            return;
        }
        g.apply(obs, ts_ms, ev.turn_id.as_deref(), now);
        self.settle(g);
    }

    /// After a mutation: lazy evaluation, watcher/timer upkeep, and (if the
    /// broadcast key changed) a trailing-coalesced flush.
    fn settle(self: &Arc<Self>, mut g: MutexGuard<'_, Inner>) {
        let now = self.clock.now_ms();
        g.evaluate(now);
        let changed = g.changed_since_sent();
        let want = watch_targets(&g);
        let hold = Self::hold_value(&g, now);
        drop(g);
        self.send_hold(hold);
        self.after_unlock(want);
        if changed {
            self.request_flush();
        }
    }

    fn hold_value(g: &Inner, now: i64) -> TaskHold {
        if g.closed || g.rebuilding {
            TaskHold::default()
        } else {
            g.hold(now)
        }
    }

    /// Publish `hold` to subscribers if it differs from the current value.
    fn send_hold(&self, hold: TaskHold) {
        self.hold_tx.send_if_modified(|cur| {
            if *cur == hold {
                false
            } else {
                *cur = hold;
                true
            }
        });
    }

    fn current_hold(self: &Arc<Self>) -> TaskHold {
        let now = self.clock.now_ms();
        let mut g = self.lock();
        if g.closed || g.rebuilding {
            return TaskHold::default();
        }
        g.evaluate(now);
        let changed = g.changed_since_sent();
        let hold = g.hold(now);
        drop(g);
        self.send_hold(hold.clone());
        if changed {
            self.request_flush();
        }
        hold
    }

    fn after_unlock(self: &Arc<Self>, want: Vec<(String, String)>) {
        self.ensure_runtime();
        self.sync_watchers(&want);
        self.ensure_timer();
        self.timer_notify.notify_one();
    }

    fn ensure_runtime(&self) {
        let mut h = self.handle.lock().unwrap();
        if h.is_none() {
            *h = Handle::try_current().ok();
        }
    }

    fn runtime(&self) -> Option<Handle> {
        self.handle.lock().unwrap().clone()
    }

    /// Schedule one trailing flush (no-op while one is pending). Without a
    /// runtime there is nothing to coalesce with, so flush inline.
    fn request_flush(self: &Arc<Self>) {
        let Some(h) = self.runtime() else {
            self.flush_now();
            return;
        };
        {
            let mut g = self.lock();
            if g.flush_scheduled {
                return;
            }
            g.flush_scheduled = true;
        }
        let weak: Weak<Shared> = Arc::downgrade(self);
        h.spawn(async move {
            tokio::time::sleep(Duration::from_millis(COALESCE_MS)).await;
            if let Some(s) = weak.upgrade() {
                s.lock().flush_scheduled = false;
                s.flush_now();
            }
        });
    }

    /// Evaluate, and if the key changed since the last broadcast, mint a rev
    /// and call `on_change`. Held back while a rebuild is in flight.
    fn flush_now(self: &Arc<Self>) {
        self.flush(false);
    }

    /// `force` broadcasts even when the key is unchanged (rebuild's first snapshot).
    fn flush(self: &Arc<Self>, force: bool) {
        let _emit = self.emit_lock.lock().unwrap();
        let now = self.clock.now_ms();
        let (out, want, hold) = {
            let mut g = self.lock();
            g.evaluate(now);
            let want = watch_targets(&g);
            let hold = Self::hold_value(&g, now);
            if g.closed || g.rebuilding || !(force || g.changed_since_sent()) {
                (None, want, hold)
            } else {
                let rev = g.rev.saturating_add(1).max(u64::try_from(now).unwrap_or(0));
                g.rev = rev;
                g.last_sent = Some(g.key());
                (Some((rev, g.summaries())), want, hold)
            }
        };
        // Unconditional: a deadline firing (grace expiry, hold lapse) changes
        // the hold even when no tray snapshot is due.
        self.send_hold(hold);
        self.sync_watchers(&want);
        if let Some((rev, tasks)) = out {
            (self.on_change)(rev, tasks);
        }
    }

    fn ensure_timer(self: &Arc<Self>) {
        let Some(h) = self.runtime() else { return };
        {
            let mut g = self.lock();
            if g.timer_spawned || g.closed {
                return;
            }
            g.timer_spawned = true;
        }
        let weak = Arc::downgrade(self);
        let notify = self.timer_notify.clone();
        h.spawn(async move {
            loop {
                let Some(s) = weak.upgrade() else { return };
                let now = s.clock.now_ms();
                let (deadline, closed) = {
                    let g = s.lock();
                    (g.next_deadline(now), g.closed)
                };
                if closed {
                    return;
                }
                drop(s);
                if let Some(d) = deadline {
                    let wait = u64::try_from((d - now).max(0)).unwrap_or(0);
                    tokio::select! {
                        () = tokio::time::sleep(Duration::from_millis(wait)) => {}
                        () = notify.notified() => continue,
                    }
                    let Some(s) = weak.upgrade() else { return };
                    s.flush_now();
                    s.spawn_due_probes();
                } else {
                    notify.notified().await;
                }
            }
        });
    }

    /// Start liveness probes for due running file commands (bounded per tick).
    /// Probes run outside the lock; results re-enter through `apply_probe`.
    fn spawn_due_probes(self: &Arc<Self>) {
        let Some(h) = self.runtime() else { return };
        let now = self.clock.now_ms();
        let due: Vec<(String, String)> = {
            let mut g = self.lock();
            if g.closed || g.rebuilding {
                return;
            }
            let mut out = Vec::new();
            for t in &mut g.tasks {
                if out.len() >= MAX_PROBES_PER_TICK {
                    break;
                }
                if t.is_running()
                    && t.kind == TaskKind::Command
                    && !t.probing
                    && t.next_probe_ms.is_some_and(|n| n <= now)
                {
                    if let Some(p) = t.output_path.clone() {
                        t.probing = true;
                        out.push((t.id.clone(), p));
                    }
                }
            }
            out
        };
        for (id, path) in due {
            let weak = Arc::downgrade(self);
            let (probe, roots) = (self.probe.lock().unwrap().clone(), self.roots.clone());
            h.spawn(async move {
                let result = match resolve(&path, &id, &roots) {
                    Ok(canon) => probe.probe(&canon).await,
                    Err(_) => Liveness::Unknown,
                };
                let Some(s) = weak.upgrade() else { return };
                let now = s.clock.now_ms();
                let mut g = s.lock();
                if g.closed {
                    return;
                }
                g.apply_probe(&id, result, now);
                s.settle(g);
            });
        }
    }

    /// Reconcile watchers with the running file-output commands.
    fn sync_watchers(self: &Arc<Self>, want: &[(String, String)]) {
        let Some(h) = self.runtime() else { return };
        let mut w = self.watchers.lock().unwrap();
        w.retain(|id, _| want.iter().any(|(i, _)| i == id));
        for (id, path) in want {
            if w.contains_key(id) {
                continue;
            }
            let Ok(canon) = resolve(path, id, &self.roots) else {
                continue;
            };
            let weak = Arc::downgrade(self);
            let handle = h.clone();
            let task_id = id.clone();
            // Hop onto the runtime so the registry is never dropped (and its
            // watchers joined) from notify's own thread.
            let watcher = watch_file(&canon, move || {
                let weak = weak.clone();
                let task_id = task_id.clone();
                handle.spawn(async move {
                    if let Some(s) = weak.upgrade() {
                        s.output_touched(&task_id);
                    }
                });
            });
            if let Some(watcher) = watcher {
                w.insert(id.clone(), watcher);
            }
        }
    }

    /// The watched file changed: bump the task's `output_rev`/activity.
    fn output_touched(self: &Arc<Self>, task_id: &str) {
        let now = self.clock.now_ms();
        {
            let mut g = self.lock();
            if g.closed {
                return;
            }
            let Some(t) = g.find_mut(task_id) else { return };
            if !t.is_running() {
                return;
            }
            t.output_rev += 1;
            t.last_activity_ms = t.last_activity_ms.max(now);
            // Activity may re-arm a hold that lapsed for lack of it; any other
            // state is unaffected (the timer owns every other deadline).
            let rearm = t.lapse == Some(HoldLapse::Unverified);
            if rearm {
                g.evaluate(now);
                let hold = Self::hold_value(&g, now);
                drop(g);
                self.send_hold(hold);
            }
        }
        self.request_flush();
    }
}
