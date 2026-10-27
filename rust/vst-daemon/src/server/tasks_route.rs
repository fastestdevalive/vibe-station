//! `GET /api/sessions/:id/tasks/:taskId/output?tail=200` — HTTP mapping only;
//! the logic is `SessionRoutes::get_task_output` (owner: `vst-tasks`).

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use vst_routes::session_tasks::TaskOutputRouteError;
use vst_types::TaskOutput;

use super::AppState;

#[derive(Deserialize)]
pub(super) struct TailQuery {
    tail: Option<usize>,
}

pub(super) async fn handle_get_task_output(
    State(state): State<AppState>,
    Path((id, task_id)): Path<(String, String)>,
    Query(q): Query<TailQuery>,
) -> Result<Json<TaskOutput>, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .get_task_output(&id, &task_id, q.tail)
        .await
        .map(Json)
        .map_err(|e| match e {
            TaskOutputRouteError::NotFound(m) => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": m, "code": "TASK_NOT_FOUND" })),
            ),
            TaskOutputRouteError::Unavailable(m) => (
                StatusCode::CONFLICT,
                Json(serde_json::json!({ "error": m, "code": "OUTPUT_UNAVAILABLE" })),
            ),
        })
}
