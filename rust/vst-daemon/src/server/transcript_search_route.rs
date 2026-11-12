//! `GET /api/sessions/:id/transcript/search` and `aroundSeq` handler — HTTP mapping only;
//! the logic is `SessionRoutes::search_session_transcript` and `SessionRoutes::get_session_transcript_around`.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use vst_routes::transcript_search::{TranscriptSearchParams, TranscriptSearchRouteError};
use vst_types::rest::sessions::{TranscriptAroundPage, TranscriptSearchPage};

use super::AppState;

pub(super) async fn handle_search_session_transcript(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(params): Query<TranscriptSearchParams>,
) -> Result<Json<TranscriptSearchPage>, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .search_session_transcript(&id, params)
        .await
        .map(Json)
        .map_err(map_route_error)
}

pub(super) async fn around(
    state: &AppState,
    id: &str,
    around_seq: &str,
    limit: Option<&str>,
) -> Result<Json<TranscriptAroundPage>, (StatusCode, Json<serde_json::Value>)> {
    state
        .session_routes
        .get_session_transcript_around(id, around_seq, limit)
        .await
        .map(Json)
        .map_err(map_route_error)
}

fn map_route_error(e: TranscriptSearchRouteError) -> (StatusCode, Json<serde_json::Value>) {
    match e {
        TranscriptSearchRouteError::NotFound(m) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": m, "code": "NOT_FOUND" })),
        ),
        TranscriptSearchRouteError::NotJson(m) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": m, "code": "NOT_JSON" })),
        ),
        TranscriptSearchRouteError::SearchQueryInvalid(m) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": m, "code": "QUERY_INVALID" })),
        ),
        TranscriptSearchRouteError::AroundQueryInvalid(m) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": m, "code": "INVALID_QUERY" })),
        ),
        TranscriptSearchRouteError::Internal(m) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": m, "code": "INTERNAL" })),
        ),
    }
}
