//! `GET /sessions/:id/tasks/:taskId/output` — thin: look the live session up
//! and ask the task registry (owner: `vst-tasks`, via `JsonAgentSession`).
//!
//! Uses `json_registry.get()` ONLY, never `resolve_json_agent`: resolving
//! lazily re-creates a released (`done`) session, which a read-only output
//! fetch must never do. A session that is not resident has no tracked tasks.

use vst_tasks::TaskOutputError;
use vst_types::TaskOutput;

use crate::sessions::SessionRoutes;

/// Default and maximum `tail` (lines) when the client omits / over-asks.
pub const DEFAULT_TAIL: usize = 200;

/// Why the output could not be served.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TaskOutputRouteError {
    /// 404 `TASK_NOT_FOUND` — unknown task, or the session is not resident.
    NotFound(String),
    /// 409 `OUTPUT_UNAVAILABLE` — the task exists but its output cannot be read.
    Unavailable(String),
}

impl SessionRoutes {
    /// `GET /sessions/:id/tasks/:taskId/output?tail=200`.
    pub async fn get_task_output(
        &self,
        session_id: &str,
        task_id: &str,
        tail: Option<usize>,
    ) -> Result<TaskOutput, TaskOutputRouteError> {
        let Some(agent) = self.json_registry.get(session_id) else {
            return Err(TaskOutputRouteError::NotFound(format!(
                "No tracked tasks for session '{session_id}'"
            )));
        };
        agent
            .task_output(task_id, tail.unwrap_or(DEFAULT_TAIL))
            .await
            .map_err(|e| match e {
                TaskOutputError::NotFound => {
                    TaskOutputRouteError::NotFound(format!("Task '{task_id}' not found"))
                }
                TaskOutputError::Unavailable => TaskOutputRouteError::Unavailable(format!(
                    "Output of task '{task_id}' is not available"
                )),
            })
    }
}
