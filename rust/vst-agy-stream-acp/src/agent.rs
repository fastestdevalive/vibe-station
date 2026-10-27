//! The ACP agent: handlers for `initialize`/`session/new`/`session/load`/
//! `session/prompt`/`session/cancel`, and the turn loop that drives one
//! long-lived agy process.
//!
//! State ownership:
//! - `session` (id + cwd + "first prompt pending") — set by `session/new`
//!   (cwd from the request) or `session/load`; the cwd is reused on respawn.
//! - `proc` — the idle agy process. A turn TAKES it out (the prompt task owns
//!   it for the duration of the turn) and puts it back on a normal result.
//! - `live_pid` — shared with [`AgyProcess`] so `session/cancel` can SIGINT
//!   without touching the session state.
//! - `cancel_gen` — bumped by `session/cancel`; the prompt task compares its
//!   snapshot against it at every park point.
//!
//! One session per agent process: a second `session/new`/`session/load` is an
//! error, and a FAILED one leaves no session behind (the daemon falls back to
//! `session/new` on the same connection).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    AgentCapabilities, CancelNotification, ContentBlock, InitializeRequest, InitializeResponse,
    LoadSessionRequest, LoadSessionResponse, NewSessionRequest, NewSessionResponse, PromptRequest,
    PromptResponse, SessionNotification, SessionUpdate, StopReason, Usage,
};
use agent_client_protocol::{Client, ConnectionTo, Error, Responder};
use tokio::sync::{watch, Mutex};
use tokio::time::Instant;

use crate::map::{EditLookup, ResolvedEdit, TurnMapper, TurnOutcome};
use crate::process::{signal_pid, AgyProcess, Signal, SpawnOpts};
use crate::wire::Inbound;

/// How long agy may take to report `init` (real agy: 2.8-3.8 s).
pub const INIT_TIMEOUT: Duration = Duration::from_secs(20);
/// How long to wait for agy's `result` after SIGINT before giving up and
/// killing it (real agy answers within ~20 ms).
pub const CANCEL_GRACE: Duration = Duration::from_secs(5);

/// Entry-point options for [`crate::run_stdio`].
#[derive(Debug, Clone)]
pub struct Options {
    /// agy binary; inherited `AGY_BIN` (default `agy`).
    pub agy_bin: String,
    /// `--model <name>` when set.
    pub model: Option<String>,
}

struct SessionState {
    id: String,
    cwd: PathBuf,
    /// `session/new` only: emit the auto-approve note on the first prompt.
    first_prompt_pending: bool,
}

#[derive(Default)]
struct Inner {
    session: Option<SessionState>,
    proc: Option<AgyProcess>,
}

pub(crate) struct Shared {
    opts: Options,
    inner: Mutex<Inner>,
    cancel_tx: watch::Sender<u64>,
    cancel_rx: watch::Receiver<u64>,
    /// Pid of the CURRENT agy process (0 = none); shared with `AgyProcess`.
    live_pid: Arc<AtomicU32>,
    /// True from the very start of a `session/prompt` until its response.
    turn_in_flight: AtomicBool,
}

impl Shared {
    pub(crate) fn new(opts: Options) -> Arc<Self> {
        let (cancel_tx, cancel_rx) = watch::channel(0u64);
        Arc::new(Self {
            opts,
            inner: Mutex::new(Inner::default()),
            cancel_tx,
            cancel_rx,
            live_pid: Arc::new(AtomicU32::new(0)),
            turn_in_flight: AtomicBool::new(false),
        })
    }

    fn spawn_opts(&self, cwd: &Path, conversation: Option<String>) -> SpawnOpts {
        SpawnOpts {
            agy_bin: self.opts.agy_bin.clone(),
            cwd: cwd.to_path_buf(),
            conversation,
            model: self.opts.model.clone(),
        }
    }

    /// Kill whatever agy is running and forget the session. Used by the
    /// connection-close callback and after `connect_to` returns.
    pub(crate) async fn shutdown(&self) {
        self.turn_in_flight.store(false, Ordering::SeqCst);
        let pid = self.live_pid.load(Ordering::SeqCst);
        if pid != 0 {
            if let Err(error) = signal_pid(pid, Signal::Kill) {
                tracing::warn!(pid, %error, "could not SIGKILL agy on shutdown");
            }
        }
        let mut inner = self.inner.lock().await;
        if let Some(mut proc) = inner.proc.take() {
            proc.kill().await;
        }
        inner.session = None;
    }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// The ACP request handler passes the request BY VALUE (trait requirement);
// only the protocol version is read here.
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn handle_initialize(
    responder: Responder<InitializeResponse>,
    req: InitializeRequest,
) -> Result<(), Error> {
    // No `_meta.steering`: agy's stream-json stdin accepts only user events,
    // so the daemon must queue mid-turn messages.
    responder.respond(
        InitializeResponse::new(req.protocol_version)
            .agent_capabilities(AgentCapabilities::new().load_session(true)),
    )
}

pub(crate) async fn handle_new_session(
    shared: Arc<Shared>,
    responder: Responder<NewSessionResponse>,
    req: NewSessionRequest,
) -> Result<(), Error> {
    match new_session(&shared, req.cwd).await {
        Ok(id) => responder.respond(NewSessionResponse::new(id)),
        Err(error) => responder.respond_with_error(error),
    }
}

async fn new_session(shared: &Shared, cwd: PathBuf) -> Result<String, Error> {
    let mut inner = shared.inner.lock().await;
    if inner.session.is_some() {
        return Err(one_session_error());
    }
    let opts = shared.spawn_opts(&cwd, None);
    let mut proc = AgyProcess::spawn(&opts, Arc::clone(&shared.live_pid))
        .map_err(|error| internal_error(error.to_string()))?;
    match proc.wait_init(INIT_TIMEOUT).await {
        Ok(id) => {
            inner.session = Some(SessionState {
                id: id.clone(),
                cwd,
                first_prompt_pending: true,
            });
            inner.proc = Some(proc);
            Ok(id)
        }
        Err(error) => {
            proc.kill().await;
            Err(internal_error(error.to_string()))
        }
    }
}

pub(crate) async fn handle_load_session(
    shared: Arc<Shared>,
    responder: Responder<LoadSessionResponse>,
    req: LoadSessionRequest,
) -> Result<(), Error> {
    match load_session(&shared, req.cwd, req.session_id.to_string()).await {
        Ok(()) => responder.respond(LoadSessionResponse::new()),
        Err(error) => responder.respond_with_error(error),
    }
}

/// `session/load` never forks. agy silently starts a DIFFERENT
/// conversation for an unknown id (with a stderr warning), so the id it
/// reports must match the requested one exactly; otherwise agy is killed and
/// the request fails.
async fn load_session(shared: &Shared, cwd: PathBuf, requested: String) -> Result<(), Error> {
    let mut inner = shared.inner.lock().await;
    if inner.session.is_some() {
        return Err(one_session_error());
    }
    let opts = shared.spawn_opts(&cwd, Some(requested.clone()));
    let mut proc = AgyProcess::spawn(&opts, Arc::clone(&shared.live_pid))
        .map_err(|error| internal_error(error.to_string()))?;
    match proc.wait_init(INIT_TIMEOUT).await {
        Ok(id) if id == requested && !proc.saw_not_found_warning() => {}
        Ok(_) => {
            // agy forked: never leave that process running.
            proc.kill().await;
            return Err(unknown_session_error(&requested));
        }
        Err(error) => {
            proc.kill().await;
            return Err(internal_error(error.to_string()));
        }
    }
    inner.session = Some(SessionState {
        id: requested,
        cwd,
        first_prompt_pending: false,
    });
    inner.proc = Some(proc);
    Ok(())
}

pub(crate) async fn handle_prompt(
    shared: Arc<Shared>,
    cx: ConnectionTo<Client>,
    responder: Responder<PromptResponse>,
    req: PromptRequest,
) -> Result<(), Error> {
    let session_id = req.session_id.to_string();
    let text = match prompt_text(&req.prompt) {
        Ok(text) => text,
        Err(error) => return responder.respond_with_error(error),
    };
    {
        let inner = shared.inner.lock().await;
        match &inner.session {
            Some(session) if session.id == session_id => {}
            _ => return responder.respond_with_error(unknown_session_error(&session_id)),
        }
    }

    // Mark the turn in flight BEFORE spawning: a `session/cancel` that lands
    // while agy is still starting must be honoured, not dropped as "no turn in
    // flight" (cancel during startup).
    shared.turn_in_flight.store(true, Ordering::SeqCst);
    let cancel_seen = *shared.cancel_rx.borrow();

    let turn_cx = cx.clone();
    let turn_shared = Arc::clone(&shared);
    let spawned = cx.spawn(async move {
        run_turn(turn_shared, turn_cx, responder, text, cancel_seen).await;
        Ok(())
    });
    if let Err(error) = spawned {
        // The future (and its responder) was dropped unanswered; the
        // connection is going away anyway.
        tracing::error!(%error, "could not spawn the agy turn task");
        shared.turn_in_flight.store(false, Ordering::SeqCst);
        return Err(error);
    }
    Ok(())
}

pub(crate) async fn handle_cancel(
    shared: Arc<Shared>,
    notif: CancelNotification,
) -> Result<(), Error> {
    let session_id = notif.session_id.to_string();
    let matches = {
        let inner = shared.inner.lock().await;
        inner
            .session
            .as_ref()
            .is_some_and(|session| session.id == session_id)
    };
    if !matches || !shared.turn_in_flight.load(Ordering::SeqCst) {
        // Cancel with no turn in flight is a no-op.
        return Ok(());
    }
    shared.cancel_tx.send_modify(|generation| *generation += 1);
    let pid = shared.live_pid.load(Ordering::SeqCst);
    if pid != 0 {
        if let Err(error) = signal_pid(pid, Signal::Int) {
            tracing::warn!(pid, %error, "could not SIGINT agy for session/cancel");
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

struct TurnEnd {
    stop: StopReason,
    usage: Option<Usage>,
}

impl TurnEnd {
    fn cancelled() -> Self {
        Self {
            stop: StopReason::Cancelled,
            usage: None,
        }
    }
}

/// Turn task wrapper: never returns `Err` (a spawned-task error tears down the
/// whole connection), and always clears `turn_in_flight`.
async fn run_turn(
    shared: Arc<Shared>,
    cx: ConnectionTo<Client>,
    responder: Responder<PromptResponse>,
    text: String,
    cancel_seen: u64,
) {
    let outcome = run_turn_inner(&shared, &cx, &text, cancel_seen).await;
    shared.turn_in_flight.store(false, Ordering::SeqCst);
    match outcome {
        Ok(end) => {
            let mut response = PromptResponse::new(end.stop);
            if let Some(usage) = end.usage {
                response = response.usage(usage);
            }
            let _ = responder.respond(response);
        }
        Err(error) => {
            let _ = responder.respond_with_error(error);
        }
    }
}

/// Outcome of getting agy ready for a turn.
///
/// `AgyProcess` is much larger than the `Cancelled` marker, but this value is
/// consumed immediately at the single call site — boxing it would only add an
/// allocation on every turn.
#[allow(clippy::large_enum_variant)]
enum ProcessOutcome {
    Ready(AgyProcess),
    /// The client cancelled while agy was starting: nothing was written.
    Cancelled,
}

/// Take the idle agy process, or respawn `agy --conversation <id>` in the
/// session's stored cwd and verify it resumed the SAME conversation.
async fn ensure_process(
    shared: &Shared,
    session_id: &str,
    cwd: &Path,
    cancel_seen: u64,
) -> Result<ProcessOutcome, Error> {
    let cancelled = || *shared.cancel_rx.borrow() != cancel_seen;

    // Take the idle process (if any); a dead one is reaped and replaced.
    let mut proc = {
        let mut inner = shared.inner.lock().await;
        inner.proc.take()
    };
    if let Some(mut idle) = proc.take() {
        if idle.is_alive() {
            proc = Some(idle);
        } else {
            idle.kill().await;
        }
    }

    // A cancel that landed before this task ran wins over everything.
    if cancelled() {
        if let Some(mut proc) = proc.take() {
            proc.kill().await;
        }
        return Ok(ProcessOutcome::Cancelled);
    }

    if let Some(proc) = proc {
        return Ok(ProcessOutcome::Ready(proc));
    }

    let opts = shared.spawn_opts(cwd, Some(session_id.to_string()));
    let mut spawned = AgyProcess::spawn(&opts, Arc::clone(&shared.live_pid))
        .map_err(|error| internal_error(error.to_string()))?;
    let init = spawned.wait_init(INIT_TIMEOUT).await;
    // A cancel during the respawn wins over the spawn outcome: kill agy and
    // answer `cancelled` WITHOUT writing the prompt.
    if cancelled() {
        spawned.kill().await;
        return Ok(ProcessOutcome::Cancelled);
    }
    match init {
        Ok(id) if id == session_id && !spawned.saw_not_found_warning() => {
            Ok(ProcessOutcome::Ready(spawned))
        }
        Ok(_) => {
            spawned.kill().await;
            Err(unknown_session_error(session_id))
        }
        Err(error) => {
            spawned.kill().await;
            Err(internal_error(format!(
                "could not resume agy conversation {session_id}: {error}"
            )))
        }
    }
}

async fn run_turn_inner(
    shared: &Shared,
    cx: &ConnectionTo<Client>,
    text: &str,
    cancel_seen: u64,
) -> Result<TurnEnd, Error> {
    let (session_id, cwd, first_prompt) = {
        let inner = shared.inner.lock().await;
        let session = inner
            .session
            .as_ref()
            .ok_or_else(|| unknown_session_error(""))?;
        (
            session.id.clone(),
            session.cwd.clone(),
            session.first_prompt_pending,
        )
    };

    let mut proc = match ensure_process(shared, &session_id, &cwd, cancel_seen).await? {
        ProcessOutcome::Ready(proc) => proc,
        ProcessOutcome::Cancelled => return Ok(TurnEnd::cancelled()),
    };
    let cancelled = || *shared.cancel_rx.borrow() != cancel_seen;

    proc.drain_stale();
    if let Err(error) = proc.send_user(text).await {
        proc.kill().await;
        return Err(internal_error(format!("could not write to agy: {error}")));
    }
    {
        let mut inner = shared.inner.lock().await;
        if let Some(session) = inner.session.as_mut() {
            session.first_prompt_pending = false;
        }
    }

    let mut mapper = TurnMapper::new(&session_id, first_prompt);
    let mut cancel_deadline: Option<Instant> = None;
    let mut cancel_rx = shared.cancel_rx.clone();
    let mut cancel_watch_alive = true;

    loop {
        if cancelled() && cancel_deadline.is_none() {
            cancel_deadline = Some(Instant::now() + CANCEL_GRACE);
        }
        let next = if let Some(deadline) = cancel_deadline {
            if let Ok(next) = tokio::time::timeout_at(deadline, proc.recv()).await {
                next
            } else {
                // No `result` within the grace window: give up.
                proc.kill().await;
                return Ok(TurnEnd::cancelled());
            }
        } else if cancel_watch_alive {
            tokio::select! {
                next = proc.recv() => next,
                changed = cancel_rx.changed() => {
                    // The sender lives in `Shared`, which this task holds, so
                    // this is `Ok` in practice; if it ever isn't, stop
                    // watching rather than spinning.
                    if changed.is_err() {
                        cancel_watch_alive = false;
                    }
                    continue;
                }
            }
        } else {
            proc.recv().await
        };

        match next {
            None => {
                // agy died before its `result`.
                for update in mapper.on_exit() {
                    send_update(cx, &session_id, update)?;
                }
                if cancelled() {
                    // A cancel is never a chat error, even if agy died on the
                    // way out instead of answering.
                    proc.kill().await;
                    return Ok(TurnEnd::cancelled());
                }
                // The last stderr lines and the stdout EOF arrive concurrently;
                // wait (bounded) for the stderr reader to drain so the error
                // actually quotes what agy said on its way out.
                proc.stderr_settled(Duration::from_millis(500)).await;
                let tail = proc.stderr_tail();
                proc.kill().await;
                return Err(internal_error(exit_error(&tail)));
            }
            Some(Inbound::Init { .. } | Inbound::Other) => {}
            Some(Inbound::Step(step)) => {
                let edit = resolve_edit(mapper.edit_lookup(&step)).await;
                for update in mapper.on_step_with_edit(&step, edit) {
                    send_update(cx, &session_id, update)?;
                }
            }
            Some(Inbound::Result(result)) => {
                let TurnOutcome {
                    updates,
                    stop,
                    usage,
                } = mapper.finish(&result, cancelled());
                for update in updates {
                    send_update(cx, &session_id, update)?;
                }
                return finish_turn(shared, proc, stop, usage).await;
            }
        }
    }
}

/// Longest a transcript lookup may hold up a tool update before it counts as
/// a miss (a stuck filesystem must never stall the turn).
const EDIT_LOOKUP_TIMEOUT: Duration = Duration::from_secs(2);

/// Resolve a file tool's diff from agy's transcript on the blocking pool, so
/// file IO never stalls the event loop. Any failure is just "no diff".
async fn resolve_edit(lookup: Option<EditLookup>) -> Option<ResolvedEdit> {
    let lookup = lookup?;
    let home = PathBuf::from(std::env::var_os("HOME")?);
    run_bounded(move || lookup.resolve(&home), EDIT_LOOKUP_TIMEOUT).await
}

/// Run `work` on the blocking pool for at most `limit`; a timeout or a
/// failed task behaves exactly like a lookup miss (debug log only). A timed
/// out blocking thread cannot be cancelled and is left to finish on its own.
async fn run_bounded<F>(work: F, limit: Duration) -> Option<ResolvedEdit>
where
    F: FnOnce() -> Option<ResolvedEdit> + Send + 'static,
{
    match tokio::time::timeout(limit, tokio::task::spawn_blocking(work)).await {
        Ok(Ok(resolved)) => resolved,
        Ok(Err(error)) => {
            tracing::debug!(%error, "transcript lookup task failed");
            None
        }
        Err(_) => {
            tracing::debug!("transcript lookup timed out");
            None
        }
    }
}

/// Apply a finished turn: a cancelled or errored turn kills agy (a real agy
/// exits with code 1 after SIGINT anyway); a normal one keeps it for the next
/// prompt.
async fn finish_turn(
    shared: &Shared,
    mut proc: AgyProcess,
    stop: Result<StopReason, String>,
    usage: Option<Usage>,
) -> Result<TurnEnd, Error> {
    match stop {
        Ok(stop) => {
            if stop == StopReason::Cancelled {
                proc.kill().await;
            } else if proc.is_alive() {
                let mut inner = shared.inner.lock().await;
                if inner.session.is_some() {
                    inner.proc = Some(proc);
                } else {
                    drop(inner);
                    proc.kill().await;
                }
            } else {
                proc.kill().await;
            }
            Ok(TurnEnd { stop, usage })
        }
        Err(message) => {
            proc.kill().await;
            Err(internal_error(message))
        }
    }
}

fn send_update(
    cx: &ConnectionTo<Client>,
    session_id: &str,
    update: SessionUpdate,
) -> Result<(), Error> {
    cx.send_notification(SessionNotification::new(session_id.to_string(), update))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// All text blocks joined with `\n`; agy has no way to accept anything else.
fn prompt_text(blocks: &[ContentBlock]) -> Result<String, Error> {
    let mut parts = Vec::with_capacity(blocks.len());
    for block in blocks {
        match block {
            ContentBlock::Text(text) => parts.push(text.text.clone()),
            _ => return Err(invalid_params("agy supports text prompts only")),
        }
    }
    Ok(parts.join("\n"))
}

pub(crate) fn invalid_params(message: impl Into<String>) -> Error {
    let mut error = Error::invalid_params();
    error.message = message.into();
    error
}

pub(crate) fn internal_error(message: impl Into<String>) -> Error {
    let mut error = Error::internal_error();
    error.message = message.into();
    error
}

fn unknown_session_error(id: &str) -> Error {
    invalid_params(format!("unknown sessionId {id}"))
}

fn one_session_error() -> Error {
    invalid_params("one session per agent process")
}

fn exit_error(stderr_tail: &str) -> String {
    if stderr_tail.is_empty() {
        "agy exited unexpectedly".to_string()
    } else {
        format!("agy exited unexpectedly: {stderr_tail}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit() -> ResolvedEdit {
        ResolvedEdit {
            key: (1, 0),
            path: "/x".into(),
            pieces: Vec::new(),
        }
    }

    #[tokio::test]
    async fn bounded_lookup_returns_a_fast_result() {
        let got = run_bounded(|| Some(edit()), Duration::from_secs(5)).await;
        assert_eq!(got.map(|r| r.key), Some((1, 0)));
    }

    #[tokio::test]
    async fn bounded_lookup_times_out_as_a_miss() {
        let got = run_bounded(
            || {
                std::thread::sleep(Duration::from_millis(300));
                Some(edit())
            },
            Duration::from_millis(20),
        )
        .await;
        assert!(got.is_none());
    }

    #[tokio::test]
    async fn bounded_lookup_task_panic_is_a_miss() {
        let got = run_bounded(|| panic!("boom"), Duration::from_secs(5)).await;
        assert!(got.is_none());
    }
}
