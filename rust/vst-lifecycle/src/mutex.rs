//! Per-project async mutex — ports `services/mutex.ts`.
//!
//! Invariants:
//! - Concurrent calls with the **same** `project_id` are serialized (promise-
//!   chain queue, or equivalently a keyed `tokio::sync::Mutex` map).
//! - Concurrent calls with **different** `project_ids` run in parallel —
//!   the lock is keyed, not global.

use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex},
};
use tokio::sync::Mutex as TokioMutex;

type KeyedLock = Arc<TokioMutex<()>>;

#[derive(Clone, Default, Debug)]
pub struct ProjectMutex {
    inner: Arc<Mutex<HashMap<String, KeyedLock>>>,
}

impl ProjectMutex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Execute `f` under the per-project lock for `project_id`.
    pub async fn with_project_lock<F, Fut, T>(&self, project_id: &str, f: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let lock = {
            let mut map = self.inner.lock().expect("ProjectMutex poisoned");
            map.entry(project_id.to_string())
                .or_insert_with(|| Arc::new(TokioMutex::new(())))
                .clone()
        };
        let _guard = lock.lock().await;
        f().await
    }
}
