//! Thin REST handlers for artifacts (plan 4.1). Each handler parses, calls the
//! owner (`vst_artifacts::ArtifactsHandle`) and serialises; rules, caps and
//! reads live in `vst-artifacts`. Mounted under `/api` by `server.rs`.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use vst_artifacts::{AddError, ArtifactError};
use vst_types::artifacts::{ScopeKey, ARTIFACT_CAP};
use vst_types::rest::artifacts::{
    AddArtifactsRequest, ArtifactErrorCode, ArtifactListResponse, PinArtifactRequest,
    PinArtifactResponse,
};

use crate::server::AppState;

/// The artifact routes, relative to `/api`.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/worktrees/:id/artifacts", get(list_worktree_artifacts))
        .route("/projects/:id/artifacts", get(list_project_artifacts))
        .route("/artifacts", post(add_artifacts))
        .route("/artifacts/:id/pin", post(pin_artifact))
        .route("/artifacts/:id", axum::routing::delete(remove_artifact))
        .route("/artifacts/:id/content", get(artifact_content))
}

fn error_response(status: StatusCode, code: ArtifactErrorCode, message: &str) -> Response {
    (
        status,
        Json(serde_json::json!({ "error": code, "message": message })),
    )
        .into_response()
}

fn store_error(e: ArtifactError) -> Response {
    match e {
        ArtifactError::NotFound => error_response(
            StatusCode::NOT_FOUND,
            ArtifactErrorCode::ArtifactNotFound,
            "No longer an artifact",
        ),
        ArtifactError::PinLimit => error_response(
            StatusCode::CONFLICT,
            ArtifactErrorCode::PinLimit,
            &format!(
                "Pin limit reached ({} per scope)",
                vst_types::artifacts::ARTIFACT_PIN_CAP
            ),
        ),
        ArtifactError::Store(e) => {
            tracing::warn!("[vst] artifacts store error: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "INTERNAL", "message": "store error" })),
            )
                .into_response()
        }
    }
}

async fn list_scope(state: &AppState, scope: ScopeKey, what: &str) -> Response {
    if !state.artifacts.scope_exists(&scope).await {
        return error_response(
            StatusCode::NOT_FOUND,
            ArtifactErrorCode::NotFound,
            &format!("Unknown {what}"),
        );
    }
    match state.artifacts.list(&scope).await {
        Ok(l) => Json(ArtifactListResponse {
            rev: l.rev,
            cap: ARTIFACT_CAP,
            total: l.total,
            items: l.items,
        })
        .into_response(),
        Err(e) => store_error(e),
    }
}

async fn list_worktree_artifacts(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    list_scope(&state, ScopeKey::worktree(id), "worktree").await
}

async fn list_project_artifacts(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    list_scope(&state, ScopeKey::project(id), "project").await
}

async fn add_artifacts(
    State(state): State<AppState>,
    Json(body): Json<AddArtifactsRequest>,
) -> Response {
    match state
        .artifacts
        .add_by_token(&body.spawn_token, body.paths)
        .await
    {
        Ok(r) => Json(r).into_response(),
        Err(AddError::InvalidRequest(m)) => error_response(
            StatusCode::BAD_REQUEST,
            ArtifactErrorCode::ValidationError,
            &m,
        ),
        Err(AddError::UnknownSession) => error_response(
            StatusCode::NOT_FOUND,
            ArtifactErrorCode::NotFound,
            "Unknown session",
        ),
        Err(AddError::SessionArchived) => error_response(
            StatusCode::FORBIDDEN,
            ArtifactErrorCode::SessionArchived,
            "Session is archived",
        ),
        Err(AddError::RateLimited) => error_response(
            StatusCode::TOO_MANY_REQUESTS,
            ArtifactErrorCode::RateLimited,
            "Too many artifact requests",
        ),
    }
}

async fn pin_artifact(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PinArtifactRequest>,
) -> Response {
    match state.artifacts.pin(&id, body.pinned).await {
        Ok(artifact) => Json(PinArtifactResponse { artifact }).into_response(),
        Err(e) => store_error(e),
    }
}

async fn remove_artifact(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.artifacts.remove(&id).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => store_error(e),
    }
}

async fn artifact_content(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    vst_routes::artifact_response::outcome_response(state.artifacts.read_content(&id).await)
}
