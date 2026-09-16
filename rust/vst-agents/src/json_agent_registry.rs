//! `JsonAgentRegistry` — the registry of live JSON agent-chat sessions.
//!
//! Ports `daemon/src/state/jsonAgentRegistry.ts`, a `sessionId → JsonAgentSession`
//! `Map` mirroring `directPtyRegistry`: a JSON session is registered lazily on its
//! first turn (per-turn spawn is stateless between turns, Decision 2) and removed
//! when the session/worktree is deleted.
//!
//! The TS is typed loosely (`unknown`-free) to avoid an import cycle with the
//! service that defines `JsonAgentSession`. The concrete session type is not yet
//! ported (blocked on `05-lifecycle-status`), so this registry is generic over
//! the value type; instantiate as `JsonAgentRegistry<JsonAgentSession>` when the
//! core lands. Values are stored as `Arc<T>` (the session is an interior-mutable
//! handle, per the workspace `XHandle(Arc<Inner>)` convention), and `get` returns
//! a cloned `Arc` so callers can call methods on the live session without holding
//! the registry's lock.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Interior-mutable `sessionId → Arc<T>` map, safe to share across routes.
pub struct JsonAgentRegistry<T> {
    inner: Mutex<HashMap<String, Arc<T>>>,
}

impl<T> Default for JsonAgentRegistry<T> {
    fn default() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }
}

impl<T> JsonAgentRegistry<T> {
    /// An empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// The live session registered for `session_id`, if any.
    pub fn get(&self, session_id: &str) -> Option<Arc<T>> {
        self.inner.lock().unwrap().get(session_id).cloned()
    }

    /// Register (or replace) the live session for `session_id`.
    pub fn set(&self, session_id: String, session: Arc<T>) {
        self.inner.lock().unwrap().insert(session_id, session);
    }

    /// Atomic "get existing, or construct-and-register a new one" — the
    /// registry's mutex is held across BOTH the lookup and the insert, so
    /// two concurrent callers for the same `session_id` can never both
    /// observe an empty slot and both construct+register their own `T`.
    ///
    /// This exists because `get_or_create_json_agent_session`'s prior
    /// shape — a separate `get()` then `set()`, with an `.await` in
    /// between (in its caller, `resolve_json_agent`) — was a check-then-act
    /// race: two resolvers for a freshly-created direct-agent session (its
    /// `chat:open` racing its own auto-enqueued turn-1, both landing on a
    /// multithreaded runtime) could both see nothing registered, each build
    /// its own `JsonAgentSession` with its own independent
    /// `JsonAgentStream`, and the second `set()` would silently evict the
    /// first. Live-reproduced: the turn ran on the discarded instance, so
    /// nobody's `chat:open` listeners ever saw it — the Rich Chat pane
    /// stayed empty until a refresh re-read the (correctly persisted)
    /// history from SQLite. The two racing constructors additionally
    /// opened the same session's transcript DB concurrently, which is the
    /// separate bug fixed in `vst-store`'s `TranscriptStore::new` (the
    /// `ALTER TABLE ... ADD COLUMN` idempotency race that used to abort the
    /// whole daemon process).
    ///
    /// `create` must be cheap enough to run while holding the lock (no
    /// `.await`, no blocking I/O) — exactly the case for
    /// `JsonAgentSession::new`, which only constructs in-memory state.
    pub fn get_or_insert_with(&self, session_id: &str, create: impl FnOnce() -> T) -> Arc<T> {
        let mut guard = self.inner.lock().unwrap();
        if let Some(existing) = guard.get(session_id) {
            return existing.clone();
        }
        let created = Arc::new(create());
        guard.insert(session_id.to_string(), created.clone());
        created
    }

    /// Remove the session for `session_id`, returning the prior value if present.
    pub fn remove(&self, session_id: &str) -> Option<Arc<T>> {
        self.inner.lock().unwrap().remove(session_id)
    }

    /// Remove every entry.
    pub fn clear(&self) {
        self.inner.lock().unwrap().clear();
    }
}

impl<T> std::fmt::Debug for JsonAgentRegistry<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let n = self.inner.lock().unwrap().len();
        f.debug_struct("JsonAgentRegistry")
            .field("len", &n)
            .finish()
    }
}
