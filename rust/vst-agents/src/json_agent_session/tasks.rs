//! Session <-> `vst-tasks` glue. The registry itself (state machine, expiry,
//! coalescing, watchers, output reader) is owned by `vst-tasks`; this file only
//! wires one registry per session: detection is the plugin's
//! `task_observations`, change notifications become `ServerEvent`s, and the
//! initial state is rebuilt from the persisted transcript.

use std::sync::Arc;

use vst_tasks::{TaskOutputError, TaskRegistry};
use vst_types::{Broadcaster, NormalizedEvent, ServerEvent, TaskOutput, TaskSummary};

use super::JsonAgentSession;
use crate::plugin::AgentPlugin;

/// How many trailing transcript rows a rebuild replays.
pub const TASK_REBUILD_ROWS: usize = 2000;

/// Build a session's registry: detection from `plugin`, changes -> broadcast.
pub(super) fn new_registry(
    plugin: Arc<dyn AgentPlugin>,
    broadcaster: Broadcaster,
    session_id: String,
) -> TaskRegistry {
    TaskRegistry::new(
        Arc::new(move |ev: &NormalizedEvent| plugin.task_observations(ev)),
        Arc::new(move |rev, tasks| {
            broadcaster.send(ServerEvent::SessionTasksChanged {
                session_id: session_id.clone(),
                rev,
                tasks,
            });
        }),
    )
}

impl JsonAgentSession {
    /// Current `(rev, tasks)` for a `chat:open` snapshot.
    #[must_use]
    pub fn task_snapshot(&self) -> Option<(u64, Vec<TaskSummary>)> {
        self.0.tasks.snapshot()
    }

    /// Output of one task (`GET .../tasks/:taskId/output`).
    pub async fn task_output(
        &self,
        task_id: &str,
        tail: usize,
    ) -> Result<TaskOutput, TaskOutputError> {
        self.0.tasks.output(task_id, tail).await
    }

    /// Rebuild the registry from the last [`TASK_REBUILD_ROWS`] transcript
    /// rows. Spawned (never run inside the session registry's lock); live
    /// observations are buffered by the registry until it finishes.
    pub(super) fn start_task_rebuild(&self) {
        let this = self.clone();
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            this.0.tasks.rebuild(&[]);
            return;
        };
        handle.spawn(async move {
            let reader = this.clone();
            let rows =
                tokio::task::spawn_blocking(move || reader.read_last_rows(TASK_REBUILD_ROWS))
                    .await
                    .unwrap_or_default();
            this.0.tasks.rebuild(&rows);
        });
    }

    fn read_last_rows(&self, limit: usize) -> Vec<NormalizedEvent> {
        let store = self.0.store.lock().unwrap();
        store
            .as_ref()
            .map_or_else(Vec::new, |st| st.read_last(limit))
    }
}
