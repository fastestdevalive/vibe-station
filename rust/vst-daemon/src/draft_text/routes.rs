//! Thin REST handlers for the draft-text owner. Each handler parses, calls
//! `DraftTextHandle` and serialises; validation, cap, revisions and the
//! broadcast live in `mod.rs`. Mounted under `/api` by `server.rs`.
//!
//! No `DefaultBodyLimit`: axum's 2 MiB default lets a 64 KiB-class overshoot
//! reach the coded 413 instead of a bare body-limit rejection.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;
use vst_types::draft_text::{DraftTextListResponse, PutDraftTextBody};

use crate::draft_text::DraftTextError;
use crate::server::AppState;

/// The draft-text routes, relative to `/api`.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/draft-texts", get(list))
        .route("/draft-texts/:scope", get(get_one).put(put_one))
}

async fn list(State(s): State<AppState>) -> Response {
    match s.draft_text.list().await {
        Ok(drafts) => Json(DraftTextListResponse { drafts }).into_response(),
        Err(e) => draft_error(e),
    }
}

async fn get_one(State(s): State<AppState>, Path(scope): Path<String>) -> Response {
    match s.draft_text.get(&scope).await {
        Ok(doc) => Json(doc).into_response(),
        Err(e) => draft_error(e),
    }
}

async fn put_one(
    State(s): State<AppState>,
    Path(scope): Path<String>,
    Json(body): Json<PutDraftTextBody>,
) -> Response {
    match s.draft_text.put(&scope, &body.text, &body.client_id).await {
        Ok(doc) => Json(doc).into_response(),
        Err(e) => draft_error(e),
    }
}

/// The one error table for this owner (`{ code, message }`, plus `limit` on 413).
fn draft_error(e: DraftTextError) -> Response {
    match e {
        DraftTextError::BadScope => error(
            StatusCode::BAD_REQUEST,
            "bad_scope",
            "scope must match ^[A-Za-z0-9._:-]{1,160}$",
            json!({}),
        ),
        DraftTextError::BadClientId => error(
            StatusCode::BAD_REQUEST,
            "bad_client_id",
            "clientId must be 1..=64 bytes",
            json!({}),
        ),
        DraftTextError::NotFound => error(
            StatusCode::NOT_FOUND,
            "scope_not_found",
            "no session, worktree or project with that id",
            json!({}),
        ),
        DraftTextError::TooLarge { limit } => error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "draft_too_large",
            "draft text exceeds the byte cap",
            json!({ "limit": limit }),
        ),
        DraftTextError::Store(msg) => {
            tracing::warn!("[vst] draft text store failure: {msg}");
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "draft text store failure",
                json!({}),
            )
        }
    }
}

fn error(status: StatusCode, code: &str, message: &str, extra: serde_json::Value) -> Response {
    let mut body = json!({ "code": code, "message": message });
    if let (Some(obj), Some(more)) = (body.as_object_mut(), extra.as_object()) {
        obj.extend(more.clone());
    }
    (status, Json(body)).into_response()
}
