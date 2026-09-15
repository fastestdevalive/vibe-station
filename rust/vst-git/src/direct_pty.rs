//! Minimal direct-PTY registry (used by `recover` / `rollback`).
//!
//! `directPtyRegistry.ts` is part-01 scope but was not ported into `vst-store`
//! (part 01 shipped a behavior-contract test only — see
//! `rust/vst-store/tests/direct_pty.rs` — no production type). Part 03's
//! `recover`/`rollback` depend on it, so this crate defines a minimal shared
//! handle with the two operations they need:
//!
//! - [`DirectPtyRegistry::has`] — did a direct-pty stream survive a restart?
//! - [`DirectPtyRegistry::get`] — fetch an entry whose [`PtyKill::kill`] tears
//!   down the stream on worktree-creation rollback.
//!
//! Part 06 (`vst-ws`) owns the real stream registry and liveness bookkeeping;
//! it should adopt/populate this handle rather than inventing a parallel one.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Something that can be killed (a direct-PTY stream's teardown).
pub trait PtyKill: Send + Sync {
    fn kill(&self);
}

/// A keyed registry of active direct-PTY streams, keyed by session id.
#[derive(Default, Clone)]
pub struct DirectPtyRegistry(Arc<Mutex<HashMap<String, Arc<dyn PtyKill>>>>);

impl std::fmt::Debug for DirectPtyRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DirectPtyRegistry")
            .field(
                "session_ids",
                &self.0.lock().unwrap().keys().collect::<Vec<_>>(),
            )
            .finish()
    }
}

impl DirectPtyRegistry {
    /// An empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// True if a stream is registered for `session_id`.
    pub fn has(&self, session_id: &str) -> bool {
        self.0.lock().unwrap().contains_key(session_id)
    }

    /// Fetch the kill handle for `session_id`, if any.
    pub fn get(&self, session_id: &str) -> Option<Arc<dyn PtyKill>> {
        self.0.lock().unwrap().get(session_id).cloned()
    }

    /// Register a stream for `session_id` (part 06 wires the real handles here).
    pub fn insert(&self, session_id: impl Into<String>, kill: Arc<dyn PtyKill>) {
        self.0.lock().unwrap().insert(session_id.into(), kill);
    }

    /// Remove a stream entry.
    pub fn remove(&self, session_id: &str) {
        self.0.lock().unwrap().remove(session_id);
    }
}
