//! `TerminalDeliveryHandle`: the single owner of delivering a scheduled message
//! (or an immediate review-comment send) into a Terminal (tmux) agent.
//!
//! One job per row, one running job per target session (a per-session FIFO), all
//! in memory as a cache of the `scheduled_messages` row, which is the durable
//! record. A job waits until the agent's plugin-owned probe reads `Ready` twice
//! in a row (see [`ReadyGate`]), then does one bracketed paste, a settle pause
//! and Enter. Only this module writes `deliveryPhase`; every terminal outcome
//! of a `channel = 'tmux'` row is reported exactly once to the
//! [`OutcomeObserver`], by whichever caller's store write actually changed the
//! row (Decision 15).
//!
//! The crate is CLI-agnostic: what differs per agent CLI arrives through
//! [`TargetResolver`] closures built by the daemon.

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio::time::Instant;
use vst_store::{CancelOutcome, RecoveryOutcome, StoreHandle, StoreResult};
use vst_types::rest::sessions::ScheduledMessageRow;
use vst_types::terminal_delivery::{
    FailureKind, PaneSnapshot, TerminalDeliveryCaps, TerminalOutcome, TerminalReadiness,
};

use crate::clock::now_iso;
use crate::pane_io::PaneIo;
use crate::probe::{pane_hash, PostEnterGuard, ReadyGate};
use crate::sanitize::sanitize_paste_text;

/// Boxed `Send` future (kept local so no crate needs `futures` for this).
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// How often a waiting job probes its pane.
pub const POLL_INTERVAL: Duration = Duration::from_millis(500);
/// A job gives up this long after it became head of its session's FIFO.
pub const JOB_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Bound on one pane operation inside a job (a tmux call that outlives it is
/// treated as a failed call: the job keeps waiting before the paste and fails the
/// row once it is `pasting`). `vst-proc`'s tmux wrapper kills a hung process
/// sooner; this is the backstop for any other [`PaneIo`].
pub const PANE_IO_TIMEOUT: Duration = Duration::from_secs(15);
/// Bound on [`TerminalDeliveryHandle::probe_once`].
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
/// Largest paste body, measured after sanitizing.
pub const MAX_PASTE_BYTES: usize = vst_types::review::TERMINAL_SEND_MAX_BYTES;

const UNSUPPORTED_REASON: &str = "Scheduling is not available for this agent anymore";
const ARCHIVED_REASON: &str = "The session was archived before this message was due.";
const EXITED_REASON: &str = "Agent exited, not delivered";
/// "Not ready within 10 min" for the default; follows `with_timeouts`.
fn timeout_reason(limit: Duration) -> String {
    let secs = limit.as_secs();
    if secs >= 60 && secs % 60 == 0 {
        format!("Not ready within {} min", secs / 60)
    } else {
        format!("Not ready within {secs} s")
    }
}
const RESET_REASON: &str = "Agent was reset before this was pasted";

/// What a job needs to know about its target session, resolved fresh each tick.
pub struct TerminalTarget {
    /// The tmux session name (the job targets `=<name>:`).
    pub tmux_name: String,
    /// The session's CURRENT channel is tmux (it may have been toggled).
    pub channel_is_tmux: bool,
    /// The session's CURRENT channel is json (Rich Chat): a schedule row that
    /// meets this is handed back to the poller, which delivers it as a turn.
    /// Any other non-tmux channel cannot deliver it at all.
    pub channel_is_json: bool,
    /// Session archived OR its worktree hidden.
    pub gone: bool,
    /// Lifecycle state exited OR done (the live value, never a frozen one).
    pub exited: bool,
    /// The plugin's delivery capabilities; `None` = unsupported (or its mode is gone).
    pub caps: Option<TerminalDeliveryCaps>,
    /// The plugin's readiness probe, bound to the session's CLI.
    pub probe: Arc<dyn Fn(&PaneSnapshot) -> TerminalReadiness + Send + Sync>,
}

/// Resolves a session id to its [`TerminalTarget`] (`None` = deleted).
pub trait TargetResolver: Send + Sync {
    fn resolve(&self, session_id: &str) -> BoxFuture<'_, Option<TerminalTarget>>;
}

/// Tells clients a session's schedule state changed (wraps
/// `broadcast_scheduled_meta`).
pub type NotifyScheduled = Arc<dyn Fn(String) -> BoxFuture<'static, ()> + Send + Sync>;

/// Paste bytes for a row, built at paste time. The result is sanitized and the
/// 32 KB / multi-line rules are re-checked on THIS body, not on `row.message`.
pub type PasteBody = Arc<dyn Fn(&ScheduledMessageRow) -> String + Send + Sync>;

/// Receives every terminal outcome of a tmux row, exactly once. Must be sync
/// and non-blocking (spawn your own work).
pub type OutcomeObserver = Arc<dyn Fn(String, TerminalOutcome) + Send + Sync>;

/// Called synchronously with a tmux row just before its `Cancelled` / `Gone`
/// outcome is reported, while the row is still readable: those two paths delete
/// the row, so an observer that spawns its own work could no longer find the
/// comment snapshot it must restore. Must be sync and non-blocking.
pub type RowCapture = Arc<dyn Fn(&ScheduledMessageRow) + Send + Sync>;

/// Cancellation of one job; also the identity of a fire (see `State::known`).
#[derive(Default)]
struct JobCtl {
    cancelled: AtomicBool,
    wake: Notify,
}

impl JobCtl {
    fn stop(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.wake.notify_one();
    }

    fn is_stopped(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Sleep `d`, or until stopped.
    async fn sleep(&self, d: Duration) {
        tokio::select! {
            _ = tokio::time::sleep(d) => {}
            _ = self.wake.notified() => {}
        }
    }
}

struct Job {
    row_id: String,
    ctl: Arc<JobCtl>,
}

#[derive(Default)]
struct Slot {
    queue: VecDeque<Job>,
    worker: Option<JoinHandle<()>>,
}

#[derive(Default)]
struct State {
    /// Per-session FIFO plus its worker task.
    slots: HashMap<String, Slot>,
    /// What the last delivery to each session left behind.
    guards: HashMap<String, PostEnterGuard>,
    /// Row ids with a live fire (queued or running) -> that fire's control.
    known: HashMap<String, Arc<JobCtl>>,
    /// Row ids `report_recovery` already told the observer about.
    recovery_reported: HashSet<String>,
}

struct Inner {
    store: StoreHandle,
    io: Arc<dyn PaneIo>,
    resolver: Arc<dyn TargetResolver>,
    notify: NotifyScheduled,
    observer: Option<OutcomeObserver>,
    paste_body: RwLock<PasteBody>,
    row_capture: RwLock<Option<RowCapture>>,
    state: Mutex<State>,
    pane_io_timeout: Duration,
    job_timeout: Duration,
}

/// Public surface of terminal delivery. Cheap to clone (shared state).
#[derive(Clone)]
pub struct TerminalDeliveryHandle {
    inner: Arc<Inner>,
}

impl TerminalDeliveryHandle {
    /// `observer = None` is a no-op observer.
    pub fn new(
        store: StoreHandle,
        io: Arc<dyn PaneIo>,
        resolver: Arc<dyn TargetResolver>,
        notify: NotifyScheduled,
        observer: Option<OutcomeObserver>,
    ) -> Self {
        let default_body: PasteBody = Arc::new(|row| row.message.clone());
        Self {
            inner: Arc::new(Inner {
                store,
                io,
                resolver,
                notify,
                observer,
                paste_body: RwLock::new(default_body),
                row_capture: RwLock::new(None),
                state: Mutex::new(State::default()),
                pane_io_timeout: PANE_IO_TIMEOUT,
                job_timeout: JOB_TIMEOUT,
            }),
        }
    }

    /// Override the pane-operation and whole-job bounds (tests; call right after
    /// [`Self::new`], before the handle is cloned).
    pub fn with_timeouts(mut self, pane_io: Duration, job: Duration) -> Self {
        if let Some(inner) = Arc::get_mut(&mut self.inner) {
            inner.pane_io_timeout = pane_io;
            inner.job_timeout = job;
        }
        self
    }

    /// Replace how paste bytes are built from a row (default: `row.message`).
    pub fn with_paste_body(self, f: PasteBody) -> Self {
        *self
            .inner
            .paste_body
            .write()
            .unwrap_or_else(|p| p.into_inner()) = f;
        self
    }

    /// Install the [`RowCapture`] hook (see its docs). Optional.
    pub fn with_row_capture(self, f: RowCapture) -> Self {
        *self
            .inner
            .row_capture
            .write()
            .unwrap_or_else(|p| p.into_inner()) = Some(f);
        self
    }

    /// Start delivering a claimed row: CAS `deliveryPhase` NULL -> `waiting`
    /// (a row already `waiting` is accepted as-is), enqueue its job in the
    /// session's FIFO, notify clients, and return. Idempotent by row id. It
    /// never returns an error: a failure is written by [`Inner::fail_row`].
    pub async fn fire(&self, row: ScheduledMessageRow) {
        let inner = &self.inner;
        let ctl = Arc::new(JobCtl::default());
        {
            // A fresh claim replaces any stale job of the same row (the row can
            // be re-claimed, e.g. after a reset moved it, while the old job's
            // registration is still around): never leave a claimed row with no
            // live job. A duplicate fire of a live claim just swaps the job.
            let mut st = inner.lock();
            if let Some(old) = st.known.insert(row.id.clone(), ctl.clone()) {
                old.stop();
                for slot in st.slots.values_mut() {
                    slot.queue.retain(|j| !Arc::ptr_eq(&j.ctl, &old));
                }
            }
        }
        let proceed = match inner
            .store
            .mark_scheduled_phase(&row.id, None, "waiting", &now_iso())
            .await
        {
            Ok(true) => Ok(true),
            Ok(false) => inner.is_waiting(&row.id).await,
            Err(e) => Err(e),
        };
        match proceed {
            Ok(true) => {}
            Ok(false) => {
                inner.forget(&row.id, &ctl);
                return;
            }
            Err(e) => {
                tracing::warn!(row_id = %row.id, session_id = %row.session_id, "terminal delivery could not start: {e}");
                inner.forget(&row.id, &ctl);
                inner
                    .fail_row(
                        &row.session_id,
                        &row.id,
                        FailureKind::Error,
                        "Could not start delivery",
                    )
                    .await;
                return;
            }
        }
        inner.enqueue(&row.session_id, &row.id, ctl);
        tracing::info!(row_id = %row.id, session_id = %row.session_id, phase = "waiting", "terminal delivery queued");
        inner.notify_session(&row.session_id).await;
    }

    /// Cancel a row's delivery (the DELETE route for a tmux row). On `Deleted`
    /// the job is stopped, clients are notified and the observer hears
    /// `Cancelled`; `InFlight` (mid-paste) and `NotFound` change nothing.
    pub async fn cancel_row(&self, session_id: &str, row_id: &str) -> StoreResult<CancelOutcome> {
        // Read the row first: the cancel deletes it, and the observer needs its
        // comment snapshot (see `RowCapture`).
        let before = self.inner.store.get_scheduled_message(row_id).await?;
        let out = self
            .inner
            .store
            .cancel_scheduled_message(row_id, session_id)
            .await?;
        if out == CancelOutcome::Deleted {
            if let Some(row) = &before {
                self.inner.capture(row);
            }
            self.inner.stop_job(row_id);
            self.inner.notify_session(session_id).await;
            self.inner.observe(row_id, TerminalOutcome::Cancelled);
        }
        Ok(out)
    }

    /// Session reset, called BEFORE the archive. Stops the jobs of the session's
    /// `waiting` rows (selected by their delivery phase, not the stored channel:
    /// a row made under Rich Chat can be waiting on a session since switched to
    /// Terminal). `origin = 'immediate'` rows are failed `archived` (observer
    /// `Failed(Archived)`) only while still `waiting`, so a paste that already
    /// started is never reported as failed. Schedule rows are LEFT claimed and
    /// `waiting` with no job: `reassign_scheduled_messages` un-claims and moves
    /// them in one statement, so the poller cannot re-claim one for the
    /// still-unarchived old session. If the reset then fails, call
    /// [`Self::rearm_after_failed_reset`].
    pub async fn stop_for_reset(&self, session_id: &str) {
        let inner = &self.inner;
        let rows = match inner.store.list_delivery_rows(session_id).await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(session_id, "terminal reset could not list rows: {e}");
                return;
            }
        };
        for row in rows.iter().filter(|r| is_delivery_row(r)) {
            if row.delivery_phase.as_deref() != Some("waiting") {
                continue;
            }
            inner.stop_job(&row.id);
            if is_immediate(row) {
                inner
                    .fail_row_with(
                        session_id,
                        &row.id,
                        FailureKind::Archived,
                        RESET_REASON,
                        true,
                    )
                    .await;
            }
        }
    }

    /// The reset that [`Self::stop_for_reset`] prepared did not happen: put the
    /// session's stopped `waiting` schedule rows back to `scheduled` (observer
    /// `Rearmed`) so the poller delivers them to the session that stays.
    pub async fn rearm_after_failed_reset(&self, session_id: &str) {
        let inner = &self.inner;
        let Ok(rows) = inner.store.list_delivery_rows(session_id).await else {
            return;
        };
        let mut rearmed = Vec::new();
        for row in rows.iter().filter(|r| is_delivery_row(r)) {
            if row.delivery_phase.as_deref() != Some("waiting") || is_immediate(row) {
                continue;
            }
            inner.stop_job(&row.id);
            if let Ok(true) = inner
                .store
                .rearm_scheduled_message(&row.id, &now_iso())
                .await
            {
                rearmed.push(row.id.clone());
            }
        }
        if !rearmed.is_empty() {
            inner.notify_session(session_id).await;
            for id in rearmed {
                inner.observe(&id, TerminalOutcome::Rearmed);
            }
        }
    }

    /// The session is being deleted; call BEFORE its rows are removed. Stops its
    /// jobs and tells the observer `Gone` for each tmux row still held.
    pub async fn on_session_removed(&self, session_id: &str) {
        let inner = &self.inner;
        let rows = match inner.store.list_delivery_rows(session_id).await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(
                    session_id,
                    "terminal session removal could not list rows: {e}"
                );
                return;
            }
        };
        for row in rows.iter().filter(|r| is_delivery_row(r)) {
            inner.stop_job(&row.id);
            inner.capture(row);
            inner.observe(&row.id, TerminalOutcome::Gone);
        }
    }

    /// Boot: tell the observer what store recovery did (`Rearmed`,
    /// `Failed(RestartedMidPaste)`, `Failed(Error)`). Each row id is reported once.
    pub async fn report_recovery(&self, outcome: RecoveryOutcome) {
        let inner = &self.inner;
        let report = |ids: Vec<String>, o: TerminalOutcome| {
            for id in ids {
                let fresh = inner.lock().recovery_reported.insert(id.clone());
                if fresh {
                    inner.observe(&id, o);
                }
            }
        };
        report(outcome.rearmed, TerminalOutcome::Rearmed);
        report(
            outcome.failed_mid_paste,
            TerminalOutcome::Failed(FailureKind::RestartedMidPaste),
        );
        report(
            outcome.failed_other_tmux,
            TerminalOutcome::Failed(FailureKind::Error),
        );
    }

    /// One bounded (2 s) capture + plugin probe: no gate, no paste, no store
    /// write. An ineligible target (deleted, archived, exited, not tmux,
    /// unsupported, dead, gone) or a probe timeout reads `Unknown`.
    ///
    /// The capture runs on a blocking thread, so a hung tmux is abandoned at the
    /// timeout (the thread finishes on its own), not killed.
    pub async fn probe_once(&self, session_id: &str) -> TerminalReadiness {
        match tokio::time::timeout(PROBE_TIMEOUT, self.inner.probe_body(session_id)).await {
            Ok(r) => r,
            Err(_) => TerminalReadiness::Unknown,
        }
    }

    /// Abort every job task. A job aborted while `waiting` leaves its row
    /// `waiting`, which boot recovery re-arms.
    pub fn shutdown(&self) {
        let mut st = self.inner.lock();
        for slot in st.slots.values_mut() {
            if let Some(w) = slot.worker.take() {
                w.abort();
            }
        }
        st.slots.clear();
        st.known.clear();
    }
}

fn is_tmux(row: &ScheduledMessageRow) -> bool {
    row.channel.as_deref() == Some("tmux")
}

/// A row terminal delivery owns: made for Terminal, or already carrying a
/// delivery phase (a job holds it, whatever channel was stored at creation).
pub fn is_delivery_row(row: &ScheduledMessageRow) -> bool {
    is_tmux(row) || row.delivery_phase.is_some()
}

fn is_immediate(row: &ScheduledMessageRow) -> bool {
    row.origin.as_deref() == Some("immediate")
}

/// What a tick decided.
enum Tick {
    /// Not ready (or a transient hiccup): poll again.
    Wait,
    /// The job is over (someone else owns the outcome, or it was failed here).
    Done,
    /// Ready twice in a row: paste.
    Ready(Box<ReadyCtx>),
}

struct ReadyCtx {
    row: ScheduledMessageRow,
    target: String,
    caps: TerminalDeliveryCaps,
    in_mode: bool,
}

impl Inner {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    async fn blocking<T: Send + 'static>(
        &self,
        f: impl FnOnce(&dyn PaneIo) -> T + Send + 'static,
    ) -> Option<T> {
        self.blocking_within(self.pane_io_timeout, f).await
    }

    /// One pane operation on a blocking thread, bounded: `None` when it
    /// panicked or did not finish within `limit` (the thread is abandoned; the
    /// tmux wrapper kills a hung process on its own deadline).
    async fn blocking_within<T: Send + 'static>(
        &self,
        limit: Duration,
        f: impl FnOnce(&dyn PaneIo) -> T + Send + 'static,
    ) -> Option<T> {
        let io = self.io.clone();
        let handle = tokio::task::spawn_blocking(move || f(io.as_ref()));
        tokio::time::timeout(limit, handle).await.ok()?.ok()
    }

    /// [`Self::blocking`] that also stops at a job's `deadline`.
    async fn blocking_until<T: Send + 'static>(
        &self,
        deadline: Instant,
        f: impl FnOnce(&dyn PaneIo) -> T + Send + 'static,
    ) -> Option<T> {
        let left = deadline.saturating_duration_since(Instant::now());
        self.blocking_within(left.min(self.pane_io_timeout), f)
            .await
    }

    fn capture(&self, row: &ScheduledMessageRow) {
        let hook = self
            .row_capture
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if let Some(f) = hook {
            f(row);
        }
    }

    fn observe(&self, row_id: &str, outcome: TerminalOutcome) {
        if let Some(o) = &self.observer {
            o(row_id.to_string(), outcome);
        }
    }

    async fn notify_session(&self, session_id: &str) {
        (self.notify)(session_id.to_string()).await;
    }

    async fn is_waiting(&self, row_id: &str) -> StoreResult<bool> {
        Ok(self
            .store
            .get_scheduled_message(row_id)
            .await?
            .is_some_and(|r| {
                r.status == "pending" && r.delivery_phase.as_deref() == Some("waiting")
            }))
    }

    /// Drop a fire's registration, unless a newer fire replaced it.
    fn forget(&self, row_id: &str, ctl: &Arc<JobCtl>) {
        let mut st = self.lock();
        if st.known.get(row_id).is_some_and(|c| Arc::ptr_eq(c, ctl)) {
            st.known.remove(row_id);
        }
    }

    /// Stop a row's job wherever it is (queued, running, or between).
    fn stop_job(&self, row_id: &str) {
        let mut st = self.lock();
        if let Some(ctl) = st.known.remove(row_id) {
            ctl.stop();
            for slot in st.slots.values_mut() {
                slot.queue.retain(|j| !Arc::ptr_eq(&j.ctl, &ctl));
            }
        }
    }

    fn enqueue(self: &Arc<Self>, session_id: &str, row_id: &str, ctl: Arc<JobCtl>) {
        let mut st = self.lock();
        let slot = st.slots.entry(session_id.to_string()).or_default();
        slot.queue.push_back(Job {
            row_id: row_id.to_string(),
            ctl,
        });
        if slot.worker.is_none() {
            let inner = self.clone();
            let sid = session_id.to_string();
            slot.worker = Some(tokio::spawn(async move { inner.worker(sid).await }));
        }
    }

    /// Runs a session's jobs one at a time, in FIFO order, until the queue is empty.
    async fn worker(self: Arc<Self>, session_id: String) {
        loop {
            let job = {
                let mut st = self.lock();
                let next = st
                    .slots
                    .get_mut(&session_id)
                    .and_then(|s| s.queue.pop_front());
                match next {
                    Some(j) => j,
                    None => {
                        st.slots.remove(&session_id);
                        return;
                    }
                }
            };
            if !job.ctl.is_stopped() {
                self.run_job(&session_id, &job).await;
            }
            self.forget(&job.row_id, &job.ctl);
        }
    }

    /// Store failure + notify + observer, only when the store write changed the
    /// row (so exactly one caller reports it). Logs ids and kind, never text.
    async fn fail_row(
        &self,
        session_id: &str,
        row_id: &str,
        kind: FailureKind,
        reason: &str,
    ) -> bool {
        self.fail_row_with(session_id, row_id, kind, reason, false)
            .await
    }

    /// [`Self::fail_row`]; with `only_waiting` the write lands only while the
    /// row's phase is still `waiting` (the job's `pasting` CAS wins otherwise).
    async fn fail_row_with(
        &self,
        session_id: &str,
        row_id: &str,
        kind: FailureKind,
        reason: &str,
        only_waiting: bool,
    ) -> bool {
        let now = now_iso();
        let wrote = if only_waiting {
            self.store
                .mark_waiting_scheduled_message_failed(row_id, reason, Some(kind.as_str()), &now)
                .await
        } else {
            self.store
                .mark_scheduled_message_failed(row_id, reason, Some(kind.as_str()), &now)
                .await
        };
        match wrote {
            Ok(true) => {
                tracing::warn!(
                    row_id,
                    session_id,
                    kind = kind.as_str(),
                    "terminal delivery failed"
                );
                self.notify_session(session_id).await;
                self.observe(row_id, TerminalOutcome::Failed(kind));
                true
            }
            Ok(false) => false,
            Err(e) => {
                tracing::error!(
                    row_id,
                    session_id,
                    "terminal delivery could not record failure: {e}"
                );
                false
            }
        }
    }

    /// One job, from head-of-FIFO to a terminal outcome. The 10-minute clock
    /// starts here.
    async fn run_job(&self, session_id: &str, job: &Job) {
        let started = Instant::now();
        let deadline = started + self.job_timeout;
        let guard = self.lock().guards.get(session_id).copied();
        let mut gate = ReadyGate::new(guard);
        let ready = loop {
            if job.ctl.is_stopped() {
                return;
            }
            if Instant::now() >= deadline {
                self.fail_row(
                    session_id,
                    &job.row_id,
                    FailureKind::TimedOut,
                    &timeout_reason(self.job_timeout),
                )
                .await;
                return;
            }
            // Every pane call inside the tick stops at `deadline`, so a hung
            // tmux cannot hold the head of the FIFO past the job's clock (the
            // tick itself is never dropped mid-outcome).
            match self
                .tick(session_id, &job.row_id, &job.ctl, deadline, &mut gate)
                .await
            {
                Tick::Wait => {}
                Tick::Done => return,
                Tick::Ready(ctx) => break ctx,
            }
            job.ctl.sleep(POLL_INTERVAL).await;
        };
        self.deliver(session_id, *ready).await;
    }

    /// One poll: is the row still ours, is the agent alive and eligible, is it ready?
    async fn tick(
        &self,
        session_id: &str,
        row_id: &str,
        ctl: &JobCtl,
        deadline: Instant,
        gate: &mut ReadyGate,
    ) -> Tick {
        let row = match self.store.get_scheduled_message(row_id).await {
            Ok(Some(r)) => r,
            Ok(None) => return Tick::Done,
            Err(e) => {
                tracing::warn!(
                    row_id,
                    session_id,
                    "terminal delivery store read failed: {e}"
                );
                return Tick::Wait;
            }
        };
        if row.status != "pending"
            || row.delivery_phase.as_deref() != Some("waiting")
            || row.session_id != session_id
        {
            // Not ours any more (cancelled, re-armed, or moved to another session).
            return Tick::Done;
        }
        let Some(target) = self.resolver.resolve(session_id).await else {
            // Deleted: `on_session_removed` (or the boot purge) owns the row.
            return Tick::Done;
        };
        // A reset/cancel stopped this job while we were resolving: the state we
        // just read may already be the post-archive one, which must not fail it.
        if ctl.is_stopped() {
            return Tick::Done;
        }
        if target.gone {
            self.fail_row(session_id, row_id, FailureKind::Archived, ARCHIVED_REASON)
                .await;
            return Tick::Done;
        }
        if !target.channel_is_tmux {
            self.channel_flipped(session_id, &row, target.channel_is_json)
                .await;
            return Tick::Done;
        }
        let Some(caps) = target.caps else {
            self.fail_row(
                session_id,
                row_id,
                FailureKind::ChannelUnsupported,
                UNSUPPORTED_REASON,
            )
            .await;
            return Tick::Done;
        };
        if target.exited {
            self.fail_row(session_id, row_id, FailureKind::AgentExited, EXITED_REASON)
                .await;
            return Tick::Done;
        }
        // A json row with attachments whose session became a Terminal agent:
        // attachments can't be pasted, so fail it now rather than after a wait.
        if row.attachments.is_some() {
            self.fail_row(
                session_id,
                row_id,
                FailureKind::ChannelUnsupported,
                "Attachments aren't supported on Terminal agents",
            )
            .await;
            return Tick::Done;
        }
        let name = target.tmux_name.clone();
        match self
            .blocking_until(deadline, |io| io.list_session_names())
            .await
        {
            Some(Some(names)) if !names.contains(&name) => {
                self.fail_row(session_id, row_id, FailureKind::AgentExited, EXITED_REASON)
                    .await;
                return Tick::Done;
            }
            Some(Some(_)) => {}
            // tmux hiccup: never fail on it.
            _ => return Tick::Wait,
        }
        let tmux_target = vst_proc::tmux::exact_pane(&name);
        let t = tmux_target.clone();
        let Some(Some(flags)) = self
            .blocking_until(deadline, move |io| io.pane_flags(&t))
            .await
        else {
            return Tick::Wait;
        };
        if flags.dead {
            self.fail_row(session_id, row_id, FailureKind::AgentExited, EXITED_REASON)
                .await;
            return Tick::Done;
        }
        let t = tmux_target.clone();
        let snapshot = match self
            .blocking_until(deadline, move |io| io.capture(&t))
            .await
        {
            Some(Ok(s)) => s,
            Some(Err(e)) => {
                tracing::debug!(row_id, session_id, "terminal capture failed: {e}");
                return Tick::Wait;
            }
            None => return Tick::Wait,
        };
        let readiness = (target.probe)(&snapshot);
        let fire = gate.observe(Instant::now(), readiness, pane_hash(&snapshot));
        if let Some(g) = gate.guard() {
            self.lock().guards.insert(session_id.to_string(), g);
        }
        if !fire {
            return Tick::Wait;
        }
        Tick::Ready(Box::new(ReadyCtx {
            row,
            target: tmux_target,
            caps,
            in_mode: flags.in_mode,
        }))
    }

    /// The session's channel is no longer tmux. A schedule row whose session
    /// became Rich Chat goes back to `scheduled` (the poller re-delivers it as a
    /// turn); an immediate row, or a session on a channel that cannot take it
    /// at all, is failed `channel_unsupported`, never re-armed.
    async fn channel_flipped(&self, session_id: &str, row: &ScheduledMessageRow, to_json: bool) {
        if is_immediate(row) || !to_json {
            self.fail_row(
                session_id,
                &row.id,
                FailureKind::ChannelUnsupported,
                UNSUPPORTED_REASON,
            )
            .await;
            return;
        }
        match self
            .store
            .rearm_scheduled_message(&row.id, &now_iso())
            .await
        {
            Ok(true) => {
                tracing::info!(row_id = %row.id, session_id, "terminal delivery re-armed after a channel change");
                self.notify_session(session_id).await;
                self.observe(&row.id, TerminalOutcome::Rearmed);
            }
            Ok(false) => {}
            Err(e) => tracing::warn!(row_id = %row.id, session_id, "terminal re-arm failed: {e}"),
        }
    }

    /// Paste + Enter for a row whose agent just read Ready twice.
    async fn deliver(&self, session_id: &str, ctx: ReadyCtx) {
        let ReadyCtx {
            row,
            target,
            caps,
            in_mode,
        } = ctx;
        let row_id = row.id.as_str();

        // Pre-flight, before anything is pasted.
        let build = self
            .paste_body
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let body = sanitize_paste_text(&build(&row));
        if body.trim().is_empty() {
            self.fail_row(
                session_id,
                row_id,
                FailureKind::Error,
                "Nothing left to paste after removing control characters",
            )
            .await;
            return;
        }
        if body.len() > MAX_PASTE_BYTES {
            self.fail_row(
                session_id,
                row_id,
                FailureKind::ChannelUnsupported,
                &format!(
                    "The message is larger than {} KB, the limit for a Terminal agent",
                    MAX_PASTE_BYTES / 1024
                ),
            )
            .await;
            return;
        }
        if !caps.multiline_ok && body.contains('\n') {
            self.fail_row(
                session_id,
                row_id,
                FailureKind::ChannelUnsupported,
                "Multi-line messages aren't supported for this agent yet",
            )
            .await;
            return;
        }

        // The single winner against a concurrent cancel.
        match self
            .store
            .mark_scheduled_phase(row_id, Some("waiting"), "pasting", &now_iso())
            .await
        {
            Ok(true) => {}
            // Cancelled / re-armed / deleted meanwhile: that caller owns the outcome.
            Ok(false) => return,
            Err(e) => {
                tracing::warn!(
                    row_id,
                    session_id,
                    "terminal delivery phase write failed: {e}"
                );
                self.fail_row(
                    session_id,
                    row_id,
                    FailureKind::Error,
                    "Could not start pasting",
                )
                .await;
                return;
            }
        }
        tracing::info!(
            row_id,
            session_id,
            phase = "pasting",
            "terminal delivery pasting"
        );
        self.notify_session(session_id).await;

        if in_mode {
            let t = target.clone();
            if let Err(reason) = self.leave_copy_mode(t).await {
                self.fail_row(
                    session_id,
                    row_id,
                    FailureKind::Error,
                    &format!("Could not leave copy mode: {reason}"),
                )
                .await;
                return;
            }
        }

        let (t, buffer, raw_lf) = (target.clone(), format!("vr-{row_id}"), caps.raw_lf);
        match self
            .blocking(move |io| io.paste(&t, &buffer, &body, raw_lf))
            .await
        {
            Some(Ok(())) => {}
            Some(Err(e)) => {
                self.fail_row(
                    session_id,
                    row_id,
                    FailureKind::Error,
                    &format!("Could not paste into the agent: {e}"),
                )
                .await;
                return;
            }
            None => {
                self.fail_row(
                    session_id,
                    row_id,
                    FailureKind::Error,
                    "Could not paste into the agent",
                )
                .await;
                return;
            }
        }

        tokio::time::sleep(Duration::from_millis(caps.settle_ms)).await;

        // Baseline for the NEXT delivery's guard: text visible, unsubmitted.
        let t = target.clone();
        let baseline = match self.blocking(move |io| io.capture(&t)).await {
            Some(Ok(s)) => pane_hash(&s),
            _ => 0,
        };
        // The user may have scrolled into copy mode during the settle pause,
        // where Enter is swallowed: leave it again right before submitting.
        let t = target.clone();
        if let Some(Some(flags)) = self.blocking(move |io| io.pane_flags(&t)).await {
            if flags.in_mode {
                let t = target.clone();
                if let Err(reason) = self.leave_copy_mode(t).await {
                    self.fail_row(
                        session_id,
                        row_id,
                        FailureKind::Error,
                        &format!("Could not leave copy mode: {reason}"),
                    )
                    .await;
                    return;
                }
            }
        }
        let t = target.clone();
        let submitted = match self.blocking(move |io| io.send_enter(&t)).await {
            Some(Ok(())) => Ok(()),
            Some(Err(e)) => Err(e),
            None => Err("tmux did not answer".to_string()),
        };
        if let Err(e) = submitted {
            self.fail_row(
                session_id,
                row_id,
                FailureKind::Error,
                &format!("Could not submit the pasted message: {e}"),
            )
            .await;
            return;
        }
        self.lock().guards.insert(
            session_id.to_string(),
            PostEnterGuard {
                enter_at: Instant::now(),
                baseline,
                changed: false,
            },
        );

        match self
            .store
            .mark_scheduled_message_pasted(row_id, &now_iso())
            .await
        {
            Ok(true) => {
                tracing::info!(row_id, session_id, phase = "sent", "terminal delivery sent");
                self.notify_session(session_id).await;
                self.observe(row_id, TerminalOutcome::Sent);
            }
            Ok(false) => {
                tracing::warn!(
                    row_id,
                    session_id,
                    "terminal delivery pasted but the row had already left `pasting`"
                );
            }
            Err(e) => {
                tracing::error!(
                    row_id,
                    session_id,
                    "terminal delivery pasted but could not mark it sent: {e}"
                );
            }
        }
    }

    /// `send-keys -X cancel`; a call that never answers is an error.
    async fn leave_copy_mode(&self, target: String) -> Result<(), String> {
        match self.blocking(move |io| io.cancel_mode(&target)).await {
            Some(r) => r,
            None => Err("tmux did not answer".to_string()),
        }
    }

    async fn probe_body(&self, session_id: &str) -> TerminalReadiness {
        let Some(target) = self.resolver.resolve(session_id).await else {
            return TerminalReadiness::Unknown;
        };
        if target.gone || !target.channel_is_tmux || target.exited || target.caps.is_none() {
            return TerminalReadiness::Unknown;
        }
        let name = target.tmux_name.clone();
        match self.blocking(|io| io.list_session_names()).await {
            Some(Some(names)) if names.contains(&name) => {}
            _ => return TerminalReadiness::Unknown,
        }
        let tmux_target = vst_proc::tmux::exact_pane(&name);
        let t = tmux_target.clone();
        match self.blocking(move |io| io.pane_flags(&t)).await {
            Some(Some(f)) if !f.dead => {}
            _ => return TerminalReadiness::Unknown,
        }
        match self.blocking(move |io| io.capture(&tmux_target)).await {
            Some(Ok(snapshot)) => (target.probe)(&snapshot),
            _ => TerminalReadiness::Unknown,
        }
    }
}
