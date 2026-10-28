//! Thin REST handlers for review comments (plan 04, 1.6). Each handler parses,
//! calls the owner (`vst_review::ReviewHandle`) and serialises; validation,
//! caps, leases and events live in `vst-review`. Mounted under `/api` by
//! `server.rs`.
//!
//! Worktree and project scopes are twins: the same handlers, a different
//! [`ScopeKey`]. Bodies and comment text are never logged here.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use vst_review::TerminalError;
use vst_types::artifacts::ScopeKey;
use vst_types::rest::review::{
    AttachBody, AttachResponse, CommentListResponse, CommentResponse, CreateCommentBody,
    CreateTerminalDeliveryBody, CreateTerminalDeliveryResponse, DetachBody, DetachResponse,
    DismissRestoredResponse, PatchCommentBody, RenderBody, RestoreReviewResponse,
    TerminalReadinessResponse,
};
use vst_types::review::ReviewError;

use crate::server::AppState;

/// The review routes, relative to `/api`.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/worktrees/:id/comments",
            get(list_worktree).post(create_worktree),
        )
        .route(
            "/projects/:id/comments",
            get(list_project).post(create_project),
        )
        .route("/worktrees/:id/comments/attach", post(attach_worktree))
        .route("/projects/:id/comments/attach", post(attach_project))
        .route("/worktrees/:id/comments/detach", post(detach_worktree))
        .route("/projects/:id/comments/detach", post(detach_project))
        .route("/worktrees/:id/comments/render", post(render_worktree))
        .route("/projects/:id/comments/render", post(render_project))
        .route(
            "/worktrees/:id/comments/dismiss-restored",
            post(dismiss_worktree),
        )
        .route(
            "/projects/:id/comments/dismiss-restored",
            post(dismiss_project),
        )
        .route(
            "/comments/:id",
            get(get_comment).patch(patch_comment).delete(delete_comment),
        )
        .route(
            "/sessions/:id/chat/turns/:turn_id/restore-review",
            post(restore_review),
        )
        .route(
            "/worktrees/:id/terminal-deliveries",
            post(create_delivery_worktree),
        )
        .route(
            "/projects/:id/terminal-deliveries",
            post(create_delivery_project),
        )
        .route("/terminal-deliveries/:id", delete(cancel_delivery))
        .route("/sessions/:id/terminal-readiness", get(terminal_readiness))
}

fn error_body(status: StatusCode, code: &str, message: &str, extra: serde_json::Value) -> Response {
    let mut body = json!({ "error": code, "message": message });
    if let (Some(obj), Some(more)) = (body.as_object_mut(), extra.as_object()) {
        obj.extend(more.clone());
    }
    (status, Json(body)).into_response()
}

/// Map an owner error through the one shared table (`vst_routes::review_http`).
fn review_error(e: ReviewError) -> Response {
    let p = vst_routes::review_http::review_error_parts(&e);
    (
        StatusCode::from_u16(p.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(p.body()),
    )
        .into_response()
}

#[derive(Deserialize)]
struct ListQuery {
    path: Option<String>,
    delivery: Option<String>,
}

async fn list(state: &AppState, scope: ScopeKey, q: ListQuery) -> Response {
    let unsent = match q.delivery.as_deref() {
        None | Some("all") => false,
        Some("unsent") => true,
        Some(_) => {
            return error_body(
                StatusCode::BAD_REQUEST,
                "invalid_delivery",
                "delivery must be `unsent` or `all`",
                json!({}),
            )
        }
    };
    match state.review.list(&scope, q.path.as_deref(), unsent).await {
        Ok(l) => Json(CommentListResponse {
            comments: l.comments,
            next_pin: l.next_pin,
            terminal_deliveries: l.terminal_deliveries,
        })
        .into_response(),
        Err(e) => review_error(e),
    }
}

async fn create(state: &AppState, scope: ScopeKey, body: CreateCommentBody) -> Response {
    match state.review.create(&scope, body).await {
        Ok((comment, created)) => (
            if created {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            },
            Json(CommentResponse { comment }),
        )
            .into_response(),
        Err(e) => review_error(e),
    }
}

async fn attach(state: &AppState, scope: ScopeKey, body: AttachBody) -> Response {
    match state.review.attach(&scope, body).await {
        Ok(attached) => Json(AttachResponse { attached }).into_response(),
        Err(e) => review_error(e),
    }
}

async fn detach(state: &AppState, scope: ScopeKey, body: DetachBody) -> Response {
    match state.review.detach(&scope, body).await {
        Ok(detached) => Json(DetachResponse { detached }).into_response(),
        Err(e) => review_error(e),
    }
}

async fn render(state: &AppState, scope: ScopeKey, body: RenderBody) -> Response {
    match state.review.render(&scope, body).await {
        Ok(r) => Json(r).into_response(),
        Err(e) => review_error(e),
    }
}

async fn dismiss(state: &AppState, scope: ScopeKey) -> Response {
    match state.review.dismiss_restored(&scope).await {
        Ok(cleared) => Json(DismissRestoredResponse { cleared }).into_response(),
        Err(e) => review_error(e),
    }
}

async fn list_worktree(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<ListQuery>,
) -> Response {
    list(&s, ScopeKey::worktree(id), q).await
}
async fn list_project(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<ListQuery>,
) -> Response {
    list(&s, ScopeKey::project(id), q).await
}
async fn create_worktree(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(b): Json<CreateCommentBody>,
) -> Response {
    create(&s, ScopeKey::worktree(id), b).await
}
async fn create_project(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(b): Json<CreateCommentBody>,
) -> Response {
    create(&s, ScopeKey::project(id), b).await
}
async fn attach_worktree(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(b): Json<AttachBody>,
) -> Response {
    attach(&s, ScopeKey::worktree(id), b).await
}
async fn attach_project(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(b): Json<AttachBody>,
) -> Response {
    attach(&s, ScopeKey::project(id), b).await
}
async fn detach_worktree(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(b): Json<DetachBody>,
) -> Response {
    detach(&s, ScopeKey::worktree(id), b).await
}
async fn detach_project(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(b): Json<DetachBody>,
) -> Response {
    detach(&s, ScopeKey::project(id), b).await
}
async fn render_worktree(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(b): Json<RenderBody>,
) -> Response {
    render(&s, ScopeKey::worktree(id), b).await
}
async fn render_project(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(b): Json<RenderBody>,
) -> Response {
    render(&s, ScopeKey::project(id), b).await
}
async fn dismiss_worktree(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    dismiss(&s, ScopeKey::worktree(id)).await
}
async fn dismiss_project(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    dismiss(&s, ScopeKey::project(id)).await
}

async fn get_comment(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    match s.review.get(&id).await {
        Ok(comment) => Json(CommentResponse { comment }).into_response(),
        Err(e) => review_error(e),
    }
}

async fn patch_comment(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PatchCommentBody>,
) -> Response {
    match s.review.patch(&id, body).await {
        Ok(comment) => Json(CommentResponse { comment }).into_response(),
        Err(e) => review_error(e),
    }
}

async fn delete_comment(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    match s.review.delete(&id).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => review_error(e),
    }
}

/// `POST /sessions/:id/chat/turns/:turnId/restore-review` — "Restore to
/// comments" on a sent card: the snapshot persisted on the turn's user row goes
/// back into the panel (ids already there are skipped; no tray notice).
/// Idempotent. 404 unknown session / turn, 409 for a cancelled, superseded or
/// review-less row.
async fn restore_review(
    State(s): State<AppState>,
    Path((id, turn_id)): Path<(String, String)>,
) -> Response {
    use vst_review::CardRestoreError;
    let Some(ctx) = vst_agents::json_agent_chat::find_json_session_context(&s.store, &id).await
    else {
        return error_body(
            StatusCode::NOT_FOUND,
            "not_found",
            "session not found",
            json!({}),
        );
    };
    let scope = match &ctx.worktree {
        Some(w) => ScopeKey::worktree(w.id.clone()),
        None => ScopeKey::project(ctx.project.id.clone()),
    };
    let events = vst_agents::json_agent_chat::read_session_transcript(&ctx, &s.json_registry);
    let record = match vst_review::persisted_review(&events, &turn_id) {
        Ok(r) => r,
        Err(CardRestoreError::NoSuchTurn) => {
            return error_body(
                StatusCode::NOT_FOUND,
                "not_found",
                "turn not found",
                json!({}),
            )
        }
        Err(CardRestoreError::Unavailable | CardRestoreError::NoReview) => {
            return error_body(
                StatusCode::CONFLICT,
                "turn_not_restorable",
                "this turn has no comments to restore",
                json!({}),
            )
        }
    };
    match s.review.restore_sent_review(&scope, &record.comments).await {
        Ok(r) => Json(RestoreReviewResponse {
            restored: r.restored,
            skipped: r.skipped,
        })
        .into_response(),
        Err(e) => review_error(e),
    }
}

/// Map a Terminal owner error to its HTTP status and code.
fn terminal_error(e: TerminalError) -> Response {
    match e {
        TerminalError::Review(e) => review_error(e),
        TerminalError::Unsupported(msg) => error_body(
            StatusCode::BAD_REQUEST,
            "TERMINAL_DELIVERY_UNSUPPORTED",
            msg,
            json!({}),
        ),
        TerminalError::Pasting => error_body(
            StatusCode::CONFLICT,
            "delivery_pasting",
            "the paste already started and cannot be cancelled",
            json!({}),
        ),
        TerminalError::NoComments => error_body(
            StatusCode::BAD_REQUEST,
            "no_comments",
            "no comments to send",
            json!({}),
        ),
    }
}

/// `POST /worktrees/:id/terminal-deliveries` (and the project twin): the
/// comments leave the panel into an immediate row and its job starts. `202`.
async fn create_delivery(
    state: &AppState,
    scope: ScopeKey,
    body: CreateTerminalDeliveryBody,
) -> Response {
    match state.review.send_terminal(&scope, body).await {
        Ok(delivery) => (
            StatusCode::ACCEPTED,
            Json(CreateTerminalDeliveryResponse { delivery }),
        )
            .into_response(),
        Err(e) => terminal_error(e),
    }
}

async fn create_delivery_worktree(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(b): Json<CreateTerminalDeliveryBody>,
) -> Response {
    create_delivery(&s, ScopeKey::worktree(id), b).await
}

async fn create_delivery_project(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(b): Json<CreateTerminalDeliveryBody>,
) -> Response {
    create_delivery(&s, ScopeKey::project(id), b).await
}

/// `DELETE /terminal-deliveries/:id`: stop the job; the outcome observer puts
/// the comments back (`send_cancelled`). 409 `delivery_pasting` mid-paste.
async fn cancel_delivery(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    match s.review.cancel_terminal(&id).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(TerminalError::Review(ReviewError::NotFound)) => error_body(
            StatusCode::NOT_FOUND,
            "not_found",
            "delivery not found",
            json!({}),
        ),
        Err(e) => terminal_error(e),
    }
}

/// `GET /sessions/:id/terminal-readiness`: one bounded pane probe, nothing is
/// pasted (the picker's "ready" label).
async fn terminal_readiness(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    let readiness = s.review.terminal_readiness(&id).await;
    Json(TerminalReadinessResponse {
        readiness: readiness.into(),
    })
    .into_response()
}
