//! `GET /api/sessions/:id/transcript/outline` and `.../outline/window`: HTTP mapping
//! only; the logic is `SessionRoutes::get_session_transcript_outline*`.

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use vst_routes::transcript_outline::{TranscriptOutlineRouteError, TranscriptOutlineWindowParams};

use super::AppState;

pub(super) async fn handle_get_session_transcript_outline(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    match state
        .session_routes
        .get_session_transcript_outline(&id)
        .await
    {
        Ok(reply) => {
            if let Some(etag) = reply.etag {
                if if_none_match_hits(&headers, &etag) {
                    return (StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response();
                }
                return (
                    [
                        (header::ETAG, etag),
                        (header::CACHE_CONTROL, "no-store".to_string()),
                    ],
                    Json(reply.summary),
                )
                    .into_response();
            }
            (
                [(header::CACHE_CONTROL, "no-store".to_string())],
                Json(reply.summary),
            )
                .into_response()
        }
        Err(e) => map_route_error(e).into_response(),
    }
}

pub(super) async fn handle_get_session_transcript_outline_window(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(params): Query<TranscriptOutlineWindowParams>,
) -> Response {
    match state
        .session_routes
        .get_session_transcript_outline_window(&id, params)
        .await
    {
        Ok(window) => (
            [(header::CACHE_CONTROL, "no-store".to_string())],
            Json(window),
        )
            .into_response(),
        Err(e) => map_route_error(e).into_response(),
    }
}

/// True when `If-None-Match` lists `etag` (weak or strong) or `*`.
fn if_none_match_hits(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(',')
                .map(str::trim)
                .any(|c| c == "*" || c.trim_start_matches("W/") == etag)
        })
}

fn map_route_error(e: TranscriptOutlineRouteError) -> (StatusCode, Json<serde_json::Value>) {
    match e {
        TranscriptOutlineRouteError::NotFound(m) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": m, "code": "NOT_FOUND" })),
        ),
        TranscriptOutlineRouteError::NotJson(m) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": m, "code": "NOT_JSON" })),
        ),
        TranscriptOutlineRouteError::QueryInvalid(m) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": m, "code": "INVALID_QUERY" })),
        ),
        TranscriptOutlineRouteError::Unavailable(m) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": m, "code": "OUTLINE_UNAVAILABLE" })),
        ),
        TranscriptOutlineRouteError::Internal(m) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": m, "code": "INTERNAL" })),
        ),
    }
}
