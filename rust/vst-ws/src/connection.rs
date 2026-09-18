//! `WsConnection` — per-connection state holder for a single WS connection.
//!
//! Ports `daemon/src/ws/connection.ts`. This is the highest-risk file in part
//! 06: it owns the per-`(connection, sessionId)` keyed session lock (Gotcha
//! #1), the refcounted file/tree watcher maps (Decision 8), and `send()`'s
//! backpressure coalescing (the socket-cycling fix).
//!
//! ## The keyed session lock (Gotcha #1 / AGENTS.md § WebSocket)
//!
//! [`WsConnection::with_session_lock`] serializes `session:open`/`session:close`
//! for the **same `(connection, sessionId)`** pair. It is deliberately a
//! per-key `tokio::sync::Mutex`, NOT one global lock — a coarser lock would
//! silently break multi-tab concurrency (two browser tabs are two connections
//! and legitimately hold two tmux clients).
//!
//! The critical section spans the **entire** handler body, including the
//! `await stream.attach` park point. Keeping the attach inside the lock is what
//! prevents a close-then-open remount from racing past the stale-stream check
//! and spawning two `tmux attach-session` clients (the orphaned one forwarding
//! duplicate output → double echo).
//!
//! ## send() backpressure (socket-cycling fix)
//!
//! `send()` never closes on ordinary write-buffer pressure. Under
//! [`WS_SOFT_LIMIT`] it sends normally; between soft and hard it coalesces
//! lossy `session:output` frames; only over [`WS_HARD_LIMIT`] does it close
//! with 1009.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use vst_types::NormalizedEvent;

use crate::Error;

/// Soft backpressure threshold: above this we begin coalescing lossy
/// `session:output` frames rather than queueing an unbounded scrollback.
pub const WS_SOFT_LIMIT: usize = 1_000_000;
/// Hard limit: above this the connection is beyond hope — close it. Shared
/// with the server's periodic backpressure check so the two agree.
pub const WS_HARD_LIMIT: usize = 50 * 1024 * 1024;

/// The coalesce flush delay, matching the TS `setTimeout(..., 100)`.
const COALESCE_FLUSH_MS: u64 = 100;

/// The transport endpoint a connection writes to. Implemented by the socket
/// adapter in `vst-daemon` and by the test mock ([`WsSinkHandle`]).
pub trait WsSink: Send + Sync {
    /// 1 == WebSocket.OPEN (matches the `ws` library's readyState).
    fn ready_state(&self) -> u8;
    /// Current write-buffer byte count.
    fn buffered_amount(&self) -> usize;
    /// Send a UTF-8 text frame.
    fn send_text(&self, text: String);
    /// Close the socket with the given code + reason.
    fn close(&self, code: u16, reason: &str);
    /// Send a WS ping frame (heartbeat).
    fn ping(&self);
    /// The last close code/reason, if the sink has closed. `None` when not
    /// yet closed (or when the transport does not track it).
    fn closed_state(&self) -> Option<(u16, String)> {
        None
    }
}

/// A concrete, shareable [`WsSink`] backed by shared state. Used by tests as a
/// mock; a production transport in `vst-daemon` implements [`WsSink`] for its
/// own socket type instead.
#[derive(Clone)]
pub struct WsSinkHandle {
    pub(crate) sent: Arc<Mutex<Vec<serde_json::Value>>>,
    pub(crate) buffered: Arc<AtomicUsize>,
    pub(crate) closed: Arc<Mutex<Option<(u16, String)>>>,
}

impl WsSinkHandle {
    /// A mock sink with the given initial buffered-amount.
    pub fn mock(buffered: usize) -> Self {
        WsSinkHandle {
            sent: Arc::new(Mutex::new(Vec::new())),
            buffered: Arc::new(AtomicUsize::new(buffered)),
            closed: Arc::new(Mutex::new(None)),
        }
    }

    /// Build a handle sharing caller-owned state (used by tests that want to
    /// inspect the sent/closed state directly).
    pub fn from_parts(
        sent: Arc<Mutex<Vec<serde_json::Value>>>,
        buffered: Arc<AtomicUsize>,
        closed: Arc<Mutex<Option<(u16, String)>>>,
    ) -> Self {
        WsSinkHandle {
            sent,
            buffered,
            closed,
        }
    }
}

impl WsSink for WsSinkHandle {
    fn ready_state(&self) -> u8 {
        1
    }
    fn buffered_amount(&self) -> usize {
        self.buffered.load(Ordering::SeqCst)
    }
    fn send_text(&self, text: String) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            self.sent.lock().unwrap().push(v);
        }
    }
    fn close(&self, code: u16, reason: &str) {
        *self.closed.lock().unwrap() = Some((code, reason.to_string()));
    }
    fn ping(&self) {}
    fn closed_state(&self) -> Option<(u16, String)> {
        self.closed.lock().unwrap().clone()
    }
}

/// A session output stream (tmux `attach-session` PTY or direct PTY).
///
/// Mirrors the TS `SessionStream` interface (ports
/// `daemon/src/ws/streams/sessionStream.ts`). `attach`/`detach` are async so
/// the park point lives inside the caller's session lock. Event streams mirror
/// the TS EventEmitter's `opened`/`chunk`/`error`/`close` events.
///
/// `#[async_trait]` keeps the trait object-safe so it can be used as
/// `Arc<dyn SessionStream>` in the connection's stream registry.
#[async_trait::async_trait]
pub trait SessionStream: Send + Sync {
    /// Begin streaming output to a subscriber.
    async fn attach(&self, cols: i64, rows: i64, subscriber_id: &str) -> Result<(), Error>;
    /// Forward client keystrokes.
    fn write(&self, data: &str);
    /// Whether [`SessionStream::write`] can actually deliver bytes yet.
    ///
    /// The stream entry is registered in the connection's map BEFORE `attach()`
    /// runs (so a follow-up open/close finds it), which leaves a window where
    /// `write()` has nowhere to write and would silently drop the keystroke.
    /// `session:input` uses this to take its fallback path instead. Defaults to
    /// `true` for streams whose `write()` is usable as soon as they exist
    /// (direct-PTY).
    fn is_attached(&self) -> bool {
        true
    }
    /// Resize the PTY.
    ///
    /// Async because the tmux implementation shells out to `tmux
    /// resize-window`: running that with `std::process::Command` pinned a
    /// shared tokio worker thread for the duration of the subprocess
    /// round-trip, which — now that dispatch is per-session concurrent rather
    /// than one global FIFO — stalls *other* sessions' work. Every terminal
    /// mount fires a resize, so a worktree switch fires N+M of them at once.
    ///
    /// Kept `async` (rather than fire-and-forget spawning) so the resize is
    /// still applied before the call returns: rapid resizes (e.g. a drag) stay
    /// ordered, and the last one wins.
    async fn resize(&self, cols: i64, rows: i64, subscriber_id: Option<&str>);
    /// Stop streaming for one subscriber.
    async fn detach(&self, subscriber_id: &str) -> Result<(), Error>;
    /// Subscribe to live output chunks (`session:output`).
    fn on_chunk(&self) -> tokio::sync::broadcast::Receiver<String>;
    /// Subscribe to the one-shot `close` event.
    fn on_close(&self) -> tokio::sync::broadcast::Receiver<()>;
    /// Subscribe to the `opened` event (fired on every attach).
    fn on_opened(&self) -> tokio::sync::broadcast::Receiver<()>;
    /// Subscribe to `error` events.
    fn on_error(&self) -> tokio::sync::broadcast::Receiver<String>;
}

/// A registered terminal stream entry for a session.
pub struct OpenStreamEntry {
    /// `"tmux"` or `"direct"`.
    pub kind: String,
    pub stream: Arc<dyn SessionStream>,
    pub subscriber_id: String,
}

impl std::fmt::Debug for OpenStreamEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenStreamEntry")
            .field("kind", &self.kind)
            .field("subscriber_id", &self.subscriber_id)
            .finish()
    }
}

/// A live JSON chat subscription: listeners attached to a session's
/// `JsonAgentStream` for `chat:open`, so `chat:close`/cleanup can detach them
/// without leaking.
///
/// `active` is the detach mechanism: `vst-agents::JsonAgentStream` (already
/// ported, per the plan) exposes `on_message`/`on_meta` but no `off`, and
/// `vst-agents` is not amendable in this part. So the WS layer gates its
/// fan-out closures behind this shared flag; [`WsConnection::unregister_chat_stream`]
/// clears it, making a closed subscription's listeners inert (no duplicate
/// delivery after close).
pub struct ChatStreamEntry {
    pub on_message: Box<dyn Fn(&NormalizedEvent) + Send + Sync>,
    pub on_meta: Box<dyn Fn(&vst_types::SessionMeta) + Send + Sync>,
    pub active: Arc<AtomicBool>,
}

/// A refcounted watcher map entry.
#[derive(Debug)]
pub struct WatcherEntry {
    pub watcher: String,
    pub ref_count: u32,
}

struct ConnectionState {
    subscriptions: HashSet<String>,
    /// Sessions this connection receives broadcasts for because a `chat:open`
    /// asked for them — deliberately SEPARATE from `subscriptions`.
    ///
    /// The two are mutated by different owners: `subscriptions` by the client's
    /// explicit `subscribe`/`unsubscribe` messages, `chat_subscriptions` by the
    /// `chat:open`/`chat:close` handlers. Sharing one set let one owner silently
    /// undo the other's intent — a queued `chat:close` running after a fresh
    /// `subscribe` for the same id would drop the subscription the client had
    /// just (re-)established, with no frame to tell it so, until reconnect.
    /// Two sets and a union in [`WsConnection::is_subscribed_to`] make each
    /// owner's removals affect only its own membership.
    chat_subscriptions: HashSet<String>,
    open_streams: HashMap<String, OpenStreamEntry>,
    chat_streams: HashMap<String, ChatStreamEntry>,
    file_watches: HashMap<String, WatcherEntry>,
    tree_watches: HashMap<String, WatcherEntry>,
    file_watch_debt: HashMap<String, u32>,
    tree_watch_debt: HashMap<String, u32>,
    coalesced_output: HashMap<String, String>,
}

impl ConnectionState {
    fn new() -> Self {
        ConnectionState {
            subscriptions: HashSet::new(),
            chat_subscriptions: HashSet::new(),
            open_streams: HashMap::new(),
            chat_streams: HashMap::new(),
            file_watches: HashMap::new(),
            tree_watches: HashMap::new(),
            file_watch_debt: HashMap::new(),
            tree_watch_debt: HashMap::new(),
            coalesced_output: HashMap::new(),
        }
    }
}

struct ConnectionInner {
    id: String,
    connected_at: u64,
    state: Mutex<ConnectionState>,
    /// Per-`(connection, sessionId)` keyed lock map (Gotcha #1).
    session_locks: tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    sink: Arc<dyn WsSink>,
    last_seen_at: Mutex<u64>,
    debug_input: AtomicBool,
    scope: Mutex<Option<vst_types::TokenScope>>,
    token_id: Mutex<Option<String>>,
    token_issued_at: Mutex<Option<i64>>,
    token_expires_at: Mutex<Option<i64>>,
}

/// A single WS connection. Clone is cheap (Arc).
#[derive(Clone)]
pub struct WsConnection {
    inner: Arc<ConnectionInner>,
}

impl std::fmt::Debug for WsConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WsConnection")
            .field("id", &self.inner.id)
            .field("connected_at", &self.inner.connected_at)
            .finish()
    }
}

// Identity by `Arc` pointer: each connection is a distinct `Arc<Inner>`, so
// pointer equality is stable and lets the broadcaster hold connections in a
// `HashSet` (register/unregister by identity).
impl PartialEq for WsConnection {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }
}
impl Eq for WsConnection {}
impl std::hash::Hash for WsConnection {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        std::ptr::hash(Arc::as_ptr(&self.inner), state);
    }
}

impl WsConnection {
    /// Create a new connection over the given sink.
    pub fn new(sink: impl WsSink + 'static) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let id = format!(
            "{:x}{:x}",
            now,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        let inner = Arc::new(ConnectionInner {
            id,
            connected_at: now,
            state: Mutex::new(ConnectionState::new()),
            session_locks: tokio::sync::Mutex::new(HashMap::new()),
            sink: Arc::new(sink),
            last_seen_at: Mutex::new(now),
            debug_input: AtomicBool::new(false),
            scope: Mutex::new(None),
            token_id: Mutex::new(None),
            token_issued_at: Mutex::new(None),
            token_expires_at: Mutex::new(None),
        });
        WsConnection { inner }
    }

    /// The connection's unique id.
    pub fn id(&self) -> &str {
        &self.inner.id
    }

    /// The sink (exposed for server-level backpressure checks / ping).
    pub fn sink(&self) -> Arc<dyn WsSink> {
        self.inner.sink.clone()
    }

    /// The last close code/reason, if the sink has closed.
    pub fn closed(&self) -> Option<(u16, String)> {
        self.inner.sink.closed_state()
    }

    /// Update `lastSeenAt` (called on every incoming message).
    pub fn touch_last_seen(&self) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        *self.inner.last_seen_at.lock().unwrap() = now;
    }

    /// The last time this connection was seen (Unix ms).
    pub fn last_seen_at(&self) -> u64 {
        *self.inner.last_seen_at.lock().unwrap()
    }

    /// The connection's `connectedAt` (Unix ms).
    pub fn connected_at(&self) -> u64 {
        self.inner.connected_at
    }

    /// Diagnostic flag: set when the client sends a `debug:log`.
    pub fn set_debug_input(&self, v: bool) {
        self.inner.debug_input.store(v, Ordering::SeqCst);
    }
    pub fn debug_input(&self) -> bool {
        self.inner.debug_input.load(Ordering::SeqCst)
    }

    pub fn set_scope(&self, scope: Option<vst_types::TokenScope>) {
        *self.inner.scope.lock().unwrap() = scope;
    }
    pub fn scope(&self) -> Option<vst_types::TokenScope> {
        *self.inner.scope.lock().unwrap()
    }
    pub fn set_token_id(&self, id: Option<String>) {
        *self.inner.token_id.lock().unwrap() = id;
    }
    pub fn token_id(&self) -> Option<String> {
        self.inner.token_id.lock().unwrap().clone()
    }
    pub fn set_token_issued_at(&self, v: Option<i64>) {
        *self.inner.token_issued_at.lock().unwrap() = v;
    }
    pub fn token_issued_at(&self) -> Option<i64> {
        *self.inner.token_issued_at.lock().unwrap()
    }
    pub fn set_token_expires_at(&self, v: Option<i64>) {
        *self.inner.token_expires_at.lock().unwrap() = v;
    }
    pub fn token_expires_at(&self) -> Option<i64> {
        *self.inner.token_expires_at.lock().unwrap()
    }

    // ---- send / backpressure ----

    /// Send a message to the client, handling backpressure WITHOUT killing the
    /// socket on ordinary write-buffer pressure (socket-cycling fix).
    pub fn send(&self, msg: impl Serialize) {
        let value = match serde_json::to_value(&msg) {
            Ok(v) => v,
            Err(_) => return,
        };
        self.send_value(value);
    }

    fn send_value(&self, value: serde_json::Value) {
        if self.inner.sink.ready_state() != 1 {
            return;
        }
        let buffer = self.inner.sink.buffered_amount();

        // Only close at the true hard limit — never on ordinary backpressure.
        if buffer > WS_HARD_LIMIT {
            tracing::warn!(
                "[WS] Write buffer exceeded {WS_HARD_LIMIT} bytes ({buffer}), closing connection"
            );
            self.inner.sink.close(1009, "Message Too Big");
            return;
        }

        let is_session_output =
            value.get("type").and_then(|t| t.as_str()) == Some("session:output");
        if buffer > WS_SOFT_LIMIT && is_session_output {
            self.coalesce_output(value);
            return;
        }

        self.flush_coalesced();
        self.inner.sink.send_text(value.to_string());
    }

    fn coalesce_output(&self, value: serde_json::Value) {
        let session_id = value
            .get("sessionId")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        let chunk = value
            .get("chunk")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        let mut state = self.inner.state.lock().unwrap();
        let existing = state.coalesced_output.entry(session_id).or_default();
        existing.push_str(&chunk);
        // Bound the coalesced buffer itself; flush immediately on runaway.
        if existing.len() > WS_SOFT_LIMIT {
            drop(state);
            self.flush_coalesced();
            return;
        }
        drop(state);
        self.schedule_coalesce_flush();
    }

    fn schedule_coalesce_flush(&self) {
        let me = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(COALESCE_FLUSH_MS)).await;
            me.flush_coalesced();
        });
    }

    fn flush_coalesced(&self) {
        let state = self.inner.state.lock().unwrap();
        if state.coalesced_output.is_empty() {
            return;
        }
        if self.inner.sink.ready_state() != 1 {
            return;
        }
        if self.inner.sink.buffered_amount() > WS_SOFT_LIMIT {
            return; // still backed up — wait for the timer
        }
        let frames: Vec<(String, String)> = state
            .coalesced_output
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        drop(state);

        for (session_id, chunk) in frames {
            self.inner.sink.send_text(
                serde_json::json!({ "type": "session:output", "sessionId": session_id, "chunk": chunk }).to_string(),
            );
        }
        self.inner.state.lock().unwrap().coalesced_output.clear();
    }

    // ---- subscription set ----

    pub fn subscribe(&self, session_ids: &[String]) {
        let mut state = self.inner.state.lock().unwrap();
        for id in session_ids {
            state.subscriptions.insert(id.clone());
        }
    }

    pub fn unsubscribe(&self, session_ids: &[String]) {
        let mut state = self.inner.state.lock().unwrap();
        for id in session_ids {
            state.subscriptions.remove(id);
        }
    }

    /// Add/remove a chat-driven subscription (`chat:open` / `chat:close`).
    ///
    /// Tracked apart from the client's explicit `subscribe` set — see
    /// `ConnectionState::chat_subscriptions`.
    pub fn subscribe_chat(&self, session_id: &str) {
        self.inner
            .state
            .lock()
            .unwrap()
            .chat_subscriptions
            .insert(session_id.to_string());
    }

    pub fn unsubscribe_chat(&self, session_id: &str) {
        self.inner
            .state
            .lock()
            .unwrap()
            .chat_subscriptions
            .remove(session_id);
    }

    /// Whether broadcasts for `session_id` should reach this connection —
    /// true if EITHER the client subscribed explicitly or a chat is open on it.
    pub fn is_subscribed_to(&self, session_id: &str) -> bool {
        let state = self.inner.state.lock().unwrap();
        state.subscriptions.contains(session_id) || state.chat_subscriptions.contains(session_id)
    }

    pub fn subscriptions(&self) -> Vec<String> {
        self.inner
            .state
            .lock()
            .unwrap()
            .subscriptions
            .iter()
            .cloned()
            .collect()
    }

    // ---- the keyed session lock (Gotcha #1) ----

    /// Run `f` under this connection's per-session lock, serializing it against
    /// any other open/close for the same sessionId on THIS connection. The
    /// critical section spans the entire `f`, so callers MUST keep the
    /// `await stream.attach` park point inside `f`.
    ///
    /// Scoped to this connection only — two browser tabs are two connections
    /// and legitimately hold two tmux clients, so we never serialize across
    /// connections.
    pub async fn with_session_lock<F, Fut, T>(&self, session_id: &str, f: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = T>,
    {
        let key = session_id.to_string();
        let lock = {
            let mut locks = self.inner.session_locks.lock().await;
            locks
                .entry(key)
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        let _guard = lock.lock().await;
        f().await
    }

    // ---- open stream registry ----

    pub fn register_open_stream(&self, session_id: &str, entry: OpenStreamEntry) {
        self.inner
            .state
            .lock()
            .unwrap()
            .open_streams
            .insert(session_id.to_string(), entry);
    }

    pub fn unregister_open_stream(&self, session_id: &str) {
        self.inner
            .state
            .lock()
            .unwrap()
            .open_streams
            .remove(session_id);
    }

    pub fn has_open_stream(&self, session_id: &str) -> bool {
        self.inner
            .state
            .lock()
            .unwrap()
            .open_streams
            .contains_key(session_id)
    }

    pub fn open_stream_entry(&self, session_id: &str) -> Option<OpenStreamEntryRef> {
        let state = self.inner.state.lock().unwrap();
        state
            .open_streams
            .get(session_id)
            .map(|e| OpenStreamEntryRef {
                kind: e.kind.clone(),
                stream: e.stream.clone(),
                subscriber_id: e.subscriber_id.clone(),
            })
    }

    pub fn open_stream_ids(&self) -> Vec<String> {
        self.inner
            .state
            .lock()
            .unwrap()
            .open_streams
            .keys()
            .cloned()
            .collect()
    }

    // ---- chat stream registry ----

    pub fn register_chat_stream(&self, session_id: &str, entry: ChatStreamEntry) {
        self.inner
            .state
            .lock()
            .unwrap()
            .chat_streams
            .insert(session_id.to_string(), entry);
    }

    /// Detach + unregister a JSON chat-stream subscription. Idempotent.
    pub fn unregister_chat_stream(&self, session_id: &str) {
        let entry = self
            .inner
            .state
            .lock()
            .unwrap()
            .chat_streams
            .remove(session_id);
        if let Some(entry) = entry {
            // Mark inert so the still-registered stream listeners no-op.
            entry.active.store(false, Ordering::SeqCst);
            drop(entry);
        }
    }

    pub fn has_chat_stream(&self, session_id: &str) -> bool {
        self.inner
            .state
            .lock()
            .unwrap()
            .chat_streams
            .contains_key(session_id)
    }

    // ---- file watcher refcounting (Decision 8) ----

    pub fn register_file_watcher(&self, key: &str, watcher: String) {
        self.inner.state.lock().unwrap().file_watches.insert(
            key.to_string(),
            WatcherEntry {
                watcher,
                ref_count: 1,
            },
        );
    }

    /// Add one more consumer. Returns true if an existing watcher was retained.
    pub fn retain_file_watcher(&self, key: &str) -> bool {
        let mut state = self.inner.state.lock().unwrap();
        match state.file_watches.get_mut(key) {
            Some(entry) => {
                entry.ref_count += 1;
                true
            }
            None => false,
        }
    }

    /// Remove one consumer. Returns the underlying watcher only when refCount
    /// hits 0; `None` while other consumers still reference it.
    pub fn release_file_watcher(&self, key: &str) -> Option<String> {
        let mut state = self.inner.state.lock().unwrap();
        let ConnectionState {
            file_watches,
            file_watch_debt,
            ..
        } = &mut *state;
        release_watcher(file_watches, file_watch_debt, key)
    }

    /// Force-remove a file watcher regardless of refCount (error path).
    pub fn unregister_file_watcher(&self, key: &str) {
        let mut state = self.inner.state.lock().unwrap();
        let ConnectionState {
            file_watches,
            file_watch_debt,
            ..
        } = &mut *state;
        unregister_watcher(file_watches, file_watch_debt, key);
    }

    pub fn has_file_watcher(&self, key: &str) -> bool {
        self.inner
            .state
            .lock()
            .unwrap()
            .file_watches
            .contains_key(key)
    }

    pub fn file_watch_count(&self, key: &str) -> u32 {
        self.inner
            .state
            .lock()
            .unwrap()
            .file_watches
            .get(key)
            .map(|e| e.ref_count)
            .unwrap_or(0)
    }

    pub fn file_watcher_instance(&self, key: &str) -> Option<String> {
        self.inner
            .state
            .lock()
            .unwrap()
            .file_watches
            .get(key)
            .map(|e| e.watcher.clone())
    }

    pub fn file_watch_keys(&self) -> Vec<String> {
        self.inner
            .state
            .lock()
            .unwrap()
            .file_watches
            .keys()
            .cloned()
            .collect()
    }

    // ---- tree watcher refcounting (Decision 8) ----

    pub fn register_tree_watcher(&self, key: &str, watcher: String) {
        self.inner.state.lock().unwrap().tree_watches.insert(
            key.to_string(),
            WatcherEntry {
                watcher,
                ref_count: 1,
            },
        );
    }

    pub fn retain_tree_watcher(&self, key: &str) -> bool {
        let mut state = self.inner.state.lock().unwrap();
        match state.tree_watches.get_mut(key) {
            Some(entry) => {
                entry.ref_count += 1;
                true
            }
            None => false,
        }
    }

    pub fn release_tree_watcher(&self, key: &str) -> Option<String> {
        let mut state = self.inner.state.lock().unwrap();
        let ConnectionState {
            tree_watches,
            tree_watch_debt,
            ..
        } = &mut *state;
        release_watcher(tree_watches, tree_watch_debt, key)
    }

    pub fn unregister_tree_watcher(&self, key: &str) {
        let mut state = self.inner.state.lock().unwrap();
        let ConnectionState {
            tree_watches,
            tree_watch_debt,
            ..
        } = &mut *state;
        unregister_watcher(tree_watches, tree_watch_debt, key);
    }

    pub fn has_tree_watcher(&self, key: &str) -> bool {
        self.inner
            .state
            .lock()
            .unwrap()
            .tree_watches
            .contains_key(key)
    }

    pub fn tree_watch_count(&self, key: &str) -> u32 {
        self.inner
            .state
            .lock()
            .unwrap()
            .tree_watches
            .get(key)
            .map(|e| e.ref_count)
            .unwrap_or(0)
    }

    pub fn tree_watcher_instance(&self, key: &str) -> Option<String> {
        self.inner
            .state
            .lock()
            .unwrap()
            .tree_watches
            .get(key)
            .map(|e| e.watcher.clone())
    }

    pub fn tree_watch_keys(&self) -> Vec<String> {
        self.inner
            .state
            .lock()
            .unwrap()
            .tree_watches
            .keys()
            .cloned()
            .collect()
    }

    /// Cleanup: tear down all subscriptions, streams, and watchers.
    pub async fn cleanup(&self) {
        // Collect stream entries to detach BEFORE touching the lock: detach
        // awaits and must never run while holding the state guard.
        let streams_to_detach: Vec<OpenStreamEntryRef> = {
            let mut state = self.inner.state.lock().unwrap();
            state.subscriptions.clear();
            state.chat_subscriptions.clear();
            let streams = state
                .open_streams
                .values()
                .map(|e| OpenStreamEntryRef {
                    kind: e.kind.clone(),
                    stream: e.stream.clone(),
                    subscriber_id: e.subscriber_id.clone(),
                })
                .collect::<Vec<_>>();
            state.open_streams.clear();
            state.chat_streams.clear();
            state.file_watches.clear();
            state.file_watch_debt.clear();
            state.tree_watches.clear();
            state.tree_watch_debt.clear();
            state.coalesced_output.clear();
            streams
        };
        for entry in streams_to_detach {
            let _ = entry.stream.detach(&entry.subscriber_id).await;
        }
    }
}

/// A clonable view of an open stream entry (so handlers can await detach
/// without holding the connection's state lock across an `.await`).
#[derive(Clone)]
pub struct OpenStreamEntryRef {
    pub kind: String,
    pub stream: Arc<dyn SessionStream>,
    pub subscriber_id: String,
}

fn release_watcher(
    watches: &mut HashMap<String, WatcherEntry>,
    debt: &mut HashMap<String, u32>,
    key: &str,
) -> Option<String> {
    // Drain any debt owed to a dead generation of this key's watcher first.
    if let Some(&d) = debt.get(key) {
        if d > 0 {
            if d <= 1 {
                debt.remove(key);
            } else {
                debt.insert(key.to_string(), d - 1);
            }
            return None;
        }
    }
    let entry = watches.get_mut(key)?;
    entry.ref_count = entry.ref_count.saturating_sub(1);
    if entry.ref_count > 0 {
        return None;
    }
    let entry = watches.remove(key)?;
    Some(entry.watcher)
}

fn unregister_watcher(
    watches: &mut HashMap<String, WatcherEntry>,
    debt: &mut HashMap<String, u32>,
    key: &str,
) {
    if let Some(entry) = watches.get(key) {
        if entry.ref_count > 0 {
            let existing = debt.get(key).copied().unwrap_or(0);
            debt.insert(key.to_string(), existing + entry.ref_count);
        }
    }
    watches.remove(key);
}
