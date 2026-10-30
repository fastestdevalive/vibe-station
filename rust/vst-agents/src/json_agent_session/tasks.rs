//! Session <-> `vst-tasks` glue. The registry itself (state machine, expiry,
//! coalescing, watchers, output reader) is owned by `vst-tasks`; this file only
//! wires one registry per session: detection is the plugin's
//! `task_observations`, change notifications become `ServerEvent`s, and the
//! initial state is rebuilt from the persisted transcript. The registry's hold watch
//! (`TaskRegistry::subscribe_hold`) is followed by `lifecycle.rs`.

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

    /// Test seam: replace the registry's output-writer liveness probe.
    #[doc(hidden)]
    pub fn set_task_probe_for_test(&self, p: Arc<dyn vst_tasks::LivenessProbe>) {
        self.0.tasks.set_probe_for_test(p);
    }

    /// Test seam: re-enter the registry's rebuilding state (live observations
    /// are buffered, `hold()` is empty).
    #[doc(hidden)]
    pub fn begin_task_rebuild_for_test(&self) {
        self.0.tasks.begin_rebuild();
    }

    /// Test seam: finish a rebuild started by [`Self::begin_task_rebuild_for_test`]
    /// with no persisted rows, replaying only the buffered observations.
    #[doc(hidden)]
    pub fn finish_task_rebuild_for_test(&self) {
        self.0.tasks.rebuild(&[]);
    }

    /// Test seam: simulate an ACP connection replacement (new adapter epoch).
    #[doc(hidden)]
    pub fn bump_task_epoch_for_test(&self) {
        self.0.tasks.bump_epoch();
    }

    /// Test seam: a daemon-restart rebuild — re-enter the rebuilding state and
    /// replay the persisted transcript rows, exactly like `start_task_rebuild`.
    #[doc(hidden)]
    pub fn rebuild_tasks_from_transcript_for_test(&self) {
        self.0.tasks.begin_rebuild();
        let rows = self.read_last_rows(TASK_REBUILD_ROWS);
        self.0.tasks.rebuild(&rows);
    }

    fn read_last_rows(&self, limit: usize) -> Vec<NormalizedEvent> {
        let store = self.0.store.lock().unwrap();
        store
            .as_ref()
            .map_or_else(Vec::new, |st| st.read_last(limit))
    }
}
