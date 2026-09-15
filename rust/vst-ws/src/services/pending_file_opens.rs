//! Pending file-opens queue (ports `daemon/src/services/pendingFileOpens.ts`).
//!
//! Paths requested via `POST /worktrees/:id/open-file` while no WS connection is
//! subscribed yet are queued here and replayed to the next client that opens
//! the worktree.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct State {
    queue: HashMap<String, Vec<String>>,
}

/// A handle to the pending-opens queue.
#[derive(Clone, Default)]
pub struct PendingFileOpens(Arc<Mutex<State>>);

impl PendingFileOpens {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append a path for a worktree (dedup).
    pub fn append(&self, worktree_id: &str, path: &str) {
        let mut st = self.0.lock().unwrap();
        let paths = st.queue.entry(worktree_id.to_string()).or_default();
        if !paths.iter().any(|p| p == path) {
            paths.push(path.to_string());
        }
    }

    /// Return (and keep) the pending paths for a worktree.
    pub fn get(&self, worktree_id: &str) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .queue
            .get(worktree_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Clear the pending paths for a worktree.
    pub fn clear(&self, worktree_id: &str) {
        self.0.lock().unwrap().queue.remove(worktree_id);
    }
}
