//! Direct PTY spawning and streaming behind a `PtyHandle` (ports
//! `services/directPty.ts`) plus the `PtyBackend` abstraction that lets
//! `vst-agents`' ACP child processes and tmux PTYs share one spawn contract.
//!
//! `spawn_child` opens a real pseudo-terminal with `portable-pty` and wraps it
//! in a [`PtyHandle`]. Multiple subscribers share one PTY via a 64 KB ring
//! buffer plus a broadcast fan-out (one emit per chunk, dispatched to every
//! attached receiver — never N×M). Lifetime = the PTY's own lifetime: when the
//! program exits, the stream closes. Detaching a subscriber removes only that
//! subscriber; the PTY lives on. Exit detection is event-driven (a wait thread
//! blocked on the child), not polled.
//!
//! ## Concurrency / ownership model (rust-coding §3)
//!
//! The `PtyHandle` is `Arc<PtyInner>`; the reader and wait threads hold a
//! `Weak` so dropping the last handle reaps them (there is no refcount cycle).
//! `PtyInner::drop` best-effort kills the child so an abandoned handle cannot
//! leak a live PTY.
//!
//! This crate deliberately does **not** own the "at most one live handle per
//! `(connection, session)` key" liveness bookkeeping — that is `vst-ws` (part
//! 06). `attach`/`detach` are idempotent and cheap to call defensively so a
//! caller *can* enforce that invariant on top of this handle.

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{ChildKiller, MasterPty, PtySize};
use tokio::sync::{broadcast, oneshot};

use crate::child_stdio::{classify_child_stdio_error, StdioErrorClass};
use crate::error::ProcError;
use crate::tmux::{NewSessionOptions, Tmux};

/// Ring buffer capacity, matching the TS `Buffer.alloc(64 * 1024)`.
const RING_CAPACITY: usize = 64 * 1024;

/// Options for `spawn_child` (a direct, non-tmux PTY child).
#[derive(Debug, Clone)]
pub struct SpawnChildOptions {
    /// Program to exec.
    pub command: String,
    /// argv for the program (excluding argv[0]).
    pub args: Vec<String>,
    /// Working directory for the child.
    pub cwd: PathBuf,
    /// Extra env vars, overlaid on the daemon's inherited environment.
    pub env: HashMap<String, String>,
    /// Initial PTY width in columns.
    pub cols: u16,
    /// Initial PTY height in rows.
    pub rows: u16,
    /// The owning session id (carried on the handle for the caller's registry).
    pub session_id: String,
    /// The owning project id.
    pub project_id: String,
    /// The owning worktree id, if any (direct sessions have none).
    pub worktree_id: Option<String>,
}

/// Options for `spawn_tmux` (create a detached tmux session).
#[derive(Debug, Clone, Default)]
pub struct TmuxSpawnOptions {
    /// Session name.
    pub name: String,
    /// Working directory.
    pub cwd: Option<PathBuf>,
    /// Extra env vars (`-e KEY=VALUE`).
    pub env: HashMap<String, String>,
    /// Command + args to run as the session's initial command.
    pub command: Option<Vec<String>>,
}

/// Shared stream state, guarded by a plain `std::sync::Mutex` (no `.await` is
/// ever held across a guard, so the sync lock is correct here).
struct StreamState {
    /// Fixed-size byte ring buffer.
    ring: [u8; RING_CAPACITY],
    /// Write head position (wraps at `RING_CAPACITY`).
    ring_pos: usize,
    /// Number of bytes currently in the buffer.
    ring_len: usize,
    /// Set of subscribed subscriber ids (presence tracking only).
    subscribers: HashSet<String>,
    /// The most recently attached subscriber; only it may resize the PTY.
    active_subscriber: Option<String>,
    /// True once the child has exited (terminal).
    exited: bool,
    /// Needles that have already been observed in output.
    sentinel_hits: HashSet<String>,
    /// Pending sentinel waiters, keyed by needle.
    sentinel_waiters: HashMap<String, oneshot::Sender<bool>>,
}

impl StreamState {
    fn new() -> Self {
        StreamState {
            ring: [0u8; RING_CAPACITY],
            ring_pos: 0,
            ring_len: 0,
            subscribers: HashSet::new(),
            active_subscriber: None,
            exited: false,
            sentinel_hits: HashSet::new(),
            sentinel_waiters: HashMap::new(),
        }
    }

    fn append_data(&mut self, data: &str) {
        for &byte in data.as_bytes() {
            self.ring[self.ring_pos] = byte;
            self.ring_pos = (self.ring_pos + 1) % RING_CAPACITY;
            if self.ring_len < RING_CAPACITY {
                self.ring_len += 1;
            }
        }
    }

    /// Current ring contents, decoded lossily (matches the TS `.toString("utf8")`).
    ///
    /// Concatenates the wraparound halves into one contiguous buffer before
    /// decoding once — decoding each half separately would corrupt any
    /// multi-byte character that happens to straddle `ring_pos`.
    fn ring_contents(&self) -> String {
        if self.ring_len == 0 {
            return String::new();
        }
        if self.ring_len < RING_CAPACITY {
            String::from_utf8_lossy(&self.ring[..self.ring_len]).into_owned()
        } else {
            let mut bytes = Vec::with_capacity(RING_CAPACITY);
            bytes.extend_from_slice(&self.ring[self.ring_pos..]);
            bytes.extend_from_slice(&self.ring[..self.ring_pos]);
            String::from_utf8_lossy(&bytes).into_owned()
        }
    }
}

struct PtyInner {
    session_id: String,
    project_id: String,
    worktree_id: Option<String>,
    state: Mutex<StreamState>,
    /// The PTY master, kept for resize. `None` if consumed/dropped.
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    /// The PTY writer (taken once at spawn; `take_writer` may only be called
    /// once per master).
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    /// An independent child killer, usable while the wait thread blocks on
    /// `child.wait()`.
    killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
    chunk_tx: broadcast::Sender<String>,
    close_tx: broadcast::Sender<()>,
    opened_tx: broadcast::Sender<()>,
}

impl Drop for PtyInner {
    fn drop(&mut self) {
        // Best-effort kill so an abandoned handle cannot leak a live PTY.
        // Idempotent: killing an already-exited child errors silently.
        if let Some(killer) = self.killer.lock().unwrap().as_mut() {
            let _ = killer.kill();
        }
    }
}

impl PtyInner {
    /// Handle one chunk of PTY output: append to the ring, fire sentinels,
    /// then fan out to every attached receiver (single emit — no N×M).
    fn handle_chunk(&self, data: &str) {
        let mut fired: Vec<oneshot::Sender<bool>> = Vec::new();
        {
            let mut st = self.state.lock().unwrap();
            if st.exited {
                return;
            }
            st.append_data(data);
            let needles: Vec<String> = st.sentinel_waiters.keys().cloned().collect();
            for needle in needles {
                if !st.sentinel_hits.contains(&needle) && data.contains(&needle) {
                    st.sentinel_hits.insert(needle.clone());
                    if let Some(tx) = st.sentinel_waiters.remove(&needle) {
                        fired.push(tx);
                    }
                }
            }
        }
        for tx in fired {
            let _ = tx.send(true);
        }
        let _ = self.chunk_tx.send(data.to_string());
    }

    /// Mark the stream exited (idempotent): fail pending sentinel waiters and
    /// broadcast `close`.
    fn fire_exit(&self) {
        let should_close = {
            let mut st = self.state.lock().unwrap();
            if st.exited {
                return;
            }
            st.exited = true;
            st.active_subscriber = None;
            for (_, tx) in st.sentinel_waiters.drain() {
                let _ = tx.send(false);
            }
            true
        };
        if should_close {
            let _ = self.close_tx.send(());
        }
    }

    fn resize_pty(&self, cols: u16, rows: u16) {
        let mut master = self.master.lock().unwrap();
        if let Some(m) = master.as_mut() {
            let _ = m.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
    }

    /// Resize only if the PTY's current size differs (matches the TS guard).
    fn apply_resize(&self, cols: u16, rows: u16) {
        let changed = {
            let master = self.master.lock().unwrap();
            match master.as_ref().and_then(|m| m.get_size().ok()) {
                Some(size) => size.cols != cols || size.rows != rows,
                None => true,
            }
        };
        if changed {
            self.resize_pty(cols, rows);
        }
    }
}

/// A handle to a live PTY. Clone is cheap (shares the same underlying PTY);
/// the last clone dropped best-effort kills the child.
#[derive(Clone)]
pub struct PtyHandle(Arc<PtyInner>);

impl std::fmt::Debug for PtyHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let exited = self.0.state.lock().unwrap().exited;
        f.debug_struct("PtyHandle")
            .field("session_id", &self.0.session_id)
            .field("project_id", &self.0.project_id)
            .field("worktree_id", &self.0.worktree_id)
            .field("exited", &exited)
            .finish()
    }
}

impl PtyHandle {
    /// Begin streaming output to a subscriber.
    ///
    /// Replays the ring buffer synchronously, claims the PTY size for this
    /// subscriber (latest-attach-wins), and — if the PTY already exited —
    /// replays then schedules a `close` on the next async step so the caller
    /// can install its close handler first.
    pub async fn attach(&self, cols: u16, rows: u16, subscriber_id: &str) -> Result<(), ProcError> {
        let _ = self.0.opened_tx.send(());

        let replay = { self.0.state.lock().unwrap().ring_contents() };
        if !replay.is_empty() {
            let _ = self.0.chunk_tx.send(replay);
        }

        let exited = { self.0.state.lock().unwrap().exited };
        if exited {
            // "on next microtask" — let the caller's close handler install first.
            tokio::task::yield_now().await;
            let _ = self.0.close_tx.send(());
            return Ok(());
        }

        {
            let mut st = self.0.state.lock().unwrap();
            st.active_subscriber = Some(subscriber_id.to_string());
            st.subscribers.insert(subscriber_id.to_string());
        }
        self.0.apply_resize(cols, rows);
        Ok(())
    }

    /// Forward client keystrokes. A write into a dying/dead PTY is silently
    /// tolerated (the child-stdio guard classifies EPIPE/ECONNRESET as benign).
    pub fn write(&self, data: &str) {
        if self.0.state.lock().unwrap().exited {
            return;
        }
        let mut w = self.0.writer.lock().unwrap();
        if let Some(writer) = w.as_mut() {
            if let Err(e) = writer.write_all(data.as_bytes()) {
                match classify_child_stdio_error(&e) {
                    StdioErrorClass::BenignDying => {}
                    StdioErrorClass::Unusual => {
                        tracing::warn!("[pty:{}] write error: {e}", self.0.session_id);
                    }
                }
            }
        }
    }

    /// Resize the PTY — only honoured from the active (most recently attached)
    /// subscriber. Resizes from passive observers are dropped so they don't
    /// fight the active client over dimensions. `subscriber_id = None` resizes
    /// unconditionally (matches the TS passive path).
    pub fn resize(&self, cols: u16, rows: u16, subscriber_id: Option<&str>) {
        let active = {
            let st = self.0.state.lock().unwrap();
            if st.exited {
                return;
            }
            st.active_subscriber.clone()
        };
        if let Some(sid) = subscriber_id {
            if active.as_deref() != Some(sid) {
                return;
            }
        }
        self.0.apply_resize(cols, rows);
    }

    /// Remove a subscriber. The PTY stays alive (lifetime = PTY's own). If this
    /// was the active subscriber, the active slot is cleared and the PTY keeps
    /// its current size until the next attach claims it.
    // Kept `async` to mirror the TS `async detach(...)` contract (part 06 awaits
    // it); there is no internal `.await` yet, hence the targeted allow.
    #[allow(clippy::unused_async, clippy::unused_async_trait_impl)]
    pub async fn detach(&self, subscriber_id: &str) -> Result<(), ProcError> {
        let mut st = self.0.state.lock().unwrap();
        st.subscribers.remove(subscriber_id);
        if st.active_subscriber.as_deref() == Some(subscriber_id) {
            st.active_subscriber = None;
        }
        Ok(())
    }

    /// Kill the underlying PTY (triggering exit cleanup). Idempotent.
    pub fn kill(&self) {
        if let Some(killer) = self.0.killer.lock().unwrap().as_mut() {
            let _ = killer.kill();
        }
    }

    /// Wait until the ring buffer contains `needle`, or until `timeout` elapses.
    /// Returns `true` if found, `false` on timeout. Uses a sentinel flag set by
    /// the output path, not buffer rescans, to survive ring-buffer wrap.
    pub async fn wait_for_output(&self, needle: &str, timeout: Duration) -> bool {
        {
            let st = self.0.state.lock().unwrap();
            if st.ring_contents().contains(needle) || st.sentinel_hits.contains(needle) {
                return true;
            }
        }

        let (tx, rx) = oneshot::channel();
        {
            let mut st = self.0.state.lock().unwrap();
            if st.exited {
                return false;
            }
            st.sentinel_waiters.insert(needle.to_string(), tx);
        }

        // Re-check after registering to close the window where the needle
        // arrived between the top check and this registration.
        {
            let mut st = self.0.state.lock().unwrap();
            if st.ring_contents().contains(needle) || st.sentinel_hits.contains(needle) {
                if let Some(tx) = st.sentinel_waiters.remove(needle) {
                    let _ = tx.send(true);
                }
                return true;
            }
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(hit)) => hit,
            Ok(Err(_)) => false,
            Err(_) => {
                let mut st = self.0.state.lock().unwrap();
                st.sentinel_waiters.remove(needle);
                false
            }
        }
    }

    /// Return the last `max_bytes` bytes of ring-buffer output as a string.
    /// Used by the lifecycle poller for idle-detection hashing.
    pub fn get_recent_output(&self, max_bytes: usize) -> String {
        let full = self.0.state.lock().unwrap().ring_contents();
        if full.len() <= max_bytes {
            full
        } else {
            // Safe slice: fall back to the whole buffer on a non-char boundary.
            full.get(full.len() - max_bytes..)
                .unwrap_or(&full)
                .to_string()
        }
    }

    /// True once the underlying child has exited (terminal).
    pub fn is_exited(&self) -> bool {
        self.0.state.lock().unwrap().exited
    }

    /// Subscribe to live output chunks.
    pub fn on_chunk(&self) -> broadcast::Receiver<String> {
        self.0.chunk_tx.subscribe()
    }

    /// Subscribe to the one-shot `close` event (fired once on child exit).
    pub fn on_close(&self) -> broadcast::Receiver<()> {
        self.0.close_tx.subscribe()
    }

    /// Subscribe to the `opened` event (fired on every attach).
    pub fn on_opened(&self) -> broadcast::Receiver<()> {
        self.0.opened_tx.subscribe()
    }

    /// The owning session id.
    pub fn session_id(&self) -> &str {
        &self.0.session_id
    }

    /// The owning project id.
    pub fn project_id(&self) -> &str {
        &self.0.project_id
    }

    /// The owning worktree id, if any.
    pub fn worktree_id(&self) -> Option<&str> {
        self.0.worktree_id.as_deref()
    }
}

/// Spawn a direct (non-tmux) PTY child and return its [`PtyHandle`].
///
/// The child inherits the daemon's environment (PATH, HOME, SHELL, …), overlays
/// the caller's `opts.env` on top, and forces `TERM=xterm-256color` — the same
/// merge order tmux mode uses.
pub fn spawn_child(opts: SpawnChildOptions) -> Result<PtyHandle, ProcError> {
    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: opts.rows,
        cols: opts.cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut cmd = portable_pty::CommandBuilder::new(&opts.command);
    cmd.args(&opts.args);
    if !opts.cwd.as_os_str().is_empty() {
        cmd.cwd(&opts.cwd);
    }
    for (k, v) in &opts.env {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");

    let mut child = pair.slave.spawn_command(cmd)?;
    drop(pair.slave);

    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;
    let master = pair.master;

    let (chunk_tx, _) = broadcast::channel::<String>(1024);
    let (close_tx, _) = broadcast::channel::<()>(64);
    let (opened_tx, _) = broadcast::channel::<()>(64);

    let inner = Arc::new(PtyInner {
        session_id: opts.session_id,
        project_id: opts.project_id,
        worktree_id: opts.worktree_id,
        state: Mutex::new(StreamState::new()),
        master: Mutex::new(Some(master)),
        writer: Mutex::new(Some(writer)),
        killer: Mutex::new(Some(killer)),
        chunk_tx,
        close_tx,
        opened_tx,
    });

    // Reader thread: drain master output until EOF (child died), feeding chunks.
    // Close is fired HERE on EOF — not by the wait thread — so `close` is
    // guaranteed to be signalled only after every last byte of output has been
    // appended to the ring buffer. (node-pty delivers `onData` before `onExit`;
    // with two independent threads we reproduce that ordering by keying exit to
    // the reader's EOF rather than to the process reap.)
    {
        let weak = Arc::downgrade(&inner);
        std::thread::spawn(move || {
            // `pending` carries any UTF-8 sequence left incomplete at the
            // tail of a 4096-byte read across to the next one, instead of
            // lossily decoding per-read (which reliably shredded characters
            // that straddled a read boundary into `�`). See the matching
            // comment in `vst-ws`'s `tmux_output.rs` reader thread.
            let mut buf = [0u8; 4096];
            let mut pending: Vec<u8> = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        loop {
                            match std::str::from_utf8(&pending) {
                                Ok(s) => {
                                    if let Some(inner) = weak.upgrade() {
                                        inner.handle_chunk(s);
                                    }
                                    pending.clear();
                                    break;
                                }
                                Err(e) => {
                                    let valid_up_to = e.valid_up_to();
                                    match e.error_len() {
                                        None => {
                                            if valid_up_to > 0 {
                                                if let Some(inner) = weak.upgrade() {
                                                    let s = std::str::from_utf8(
                                                        &pending[..valid_up_to],
                                                    )
                                                    .expect("validated prefix");
                                                    inner.handle_chunk(s);
                                                }
                                            }
                                            pending.drain(..valid_up_to);
                                            break;
                                        }
                                        Some(bad_len) => {
                                            let end = valid_up_to + bad_len;
                                            if let Some(inner) = weak.upgrade() {
                                                let mut s = std::str::from_utf8(
                                                    &pending[..valid_up_to],
                                                )
                                                .expect("validated prefix")
                                                .to_owned();
                                                s.push('\u{FFFD}');
                                                inner.handle_chunk(&s);
                                            }
                                            pending.drain(..end);
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            if !pending.is_empty() {
                if let Some(inner) = weak.upgrade() {
                    let s = String::from_utf8_lossy(&pending).into_owned();
                    inner.handle_chunk(&s);
                }
            }
            if let Some(inner) = weak.upgrade() {
                inner.fire_exit();
            }
        });
    }

    // Wait thread: block on child exit purely to reap it (avoid a zombie). The
    // close event is signalled by the reader thread on EOF, not here.
    {
        let weak = Arc::downgrade(&inner);
        std::thread::spawn(move || {
            let _ = child.wait();
            // Drop `weak` so the reader's EOF path is the sole exit signal.
            drop(weak);
        });
    }

    Ok(PtyHandle(inner))
}

/// Create a detached tmux session via the tmux command wrappers.
pub fn spawn_tmux(opts: &TmuxSpawnOptions) -> Result<(), ProcError> {
    let tmux = Tmux::new();
    tmux.new_session(&NewSessionOptions {
        name: opts.name.clone(),
        cwd: opts.cwd.clone(),
        env: opts.env.clone(),
        command: opts.command.clone(),
    })?;
    Ok(())
}

/// The abstraction over how a PTY/subprocess is spawned, so ACP child processes
/// (`vst-agents`, part 04b) and tmux PTYs share one spawn contract. Deliberately
/// keeps tmux- and direct-pty-specific details out of the trait shape.
pub trait PtyBackend: Send + Sync {
    /// Spawn a direct PTY child.
    fn spawn_child(&self, opts: SpawnChildOptions) -> Result<PtyHandle, ProcError>;
    /// Create a detached tmux session.
    fn spawn_tmux(&self, opts: &TmuxSpawnOptions) -> Result<(), ProcError>;
}

/// The default backend backed by `portable-pty` and the `tmux` binary.
#[derive(Debug, Default, Clone, Copy)]
pub struct NativePtyBackend;

impl PtyBackend for NativePtyBackend {
    fn spawn_child(&self, opts: SpawnChildOptions) -> Result<PtyHandle, ProcError> {
        spawn_child(opts)
    }

    fn spawn_tmux(&self, opts: &TmuxSpawnOptions) -> Result<(), ProcError> {
        spawn_tmux(opts)
    }
}
