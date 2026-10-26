//! `/api/update/*` handlers (kept out of `server.rs`, which is already huge).

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use vst_types::domain::{TokenPayload, TokenScope};
use vst_types::rest::update::{
    RestartBody, SettingsBody, StartedBy, UpdateApiError, UpdateApiErrorCode as Code,
    UpdateCheckResponse, UpdateReason, UpdateStatus, VersionBody,
};

use super::impact::compute_impact;
use super::version::parse;

use crate::server::AppState;

type ApiError = (StatusCode, Json<UpdateApiError>);

fn api_err(status: StatusCode, code: Code) -> ApiError {
    (status, Json(UpdateApiError::new(code)))
}

/// Browser/Cli/Tauri (and no-auth) may mutate update state; Mobile is 403
/// (mobile tokens are read-only: they may view update state, never change it).
pub(crate) fn require_mutating_scope(payload: Option<&TokenPayload>) -> Result<(), ApiError> {
    match payload {
        Some(p) if p.scope == TokenScope::Mobile => {
            Err(api_err(StatusCode::FORBIDDEN, Code::MobileReadOnly))
        }
        _ => Ok(()),
    }
}

#[derive(Deserialize)]
struct CheckQuery {
    #[serde(default)]
    force: bool,
}

async fn handle_check(
    State(state): State<AppState>,
    payload: Option<Extension<TokenPayload>>,
    Query(q): Query<CheckQuery>,
) -> Json<UpdateCheckResponse> {
    let can_install = require_mutating_scope(payload.as_deref()).is_ok();
    let status = state.update.check(q.force).await;
    Json(UpdateCheckResponse {
        status,
        can_install,
    })
}

async fn handle_settings(
    State(state): State<AppState>,
    payload: Option<Extension<TokenPayload>>,
    Json(body): Json<SettingsBody>,
) -> Result<Json<UpdateStatus>, ApiError> {
    require_mutating_scope(payload.as_deref())?;
    Ok(Json(state.update.set_auto_check(body.auto_check).await))
}

/// 202 + the first snapshot; 409 `update_in_progress{startedBy}` or
/// `restart_in_progress` (a restart was accepted first).
async fn handle_install(
    State(state): State<AppState>,
    payload: Option<Extension<TokenPayload>>,
) -> Result<(StatusCode, Json<UpdateStatus>), ApiError> {
    require_mutating_scope(payload.as_deref())?;
    let by = match payload.as_deref() {
        Some(p) if p.scope == TokenScope::Cli => StartedBy::Cli,
        _ => StartedBy::Ui,
    };
    match state.update.start_install(by) {
        Ok(snap) => Ok((StatusCode::ACCEPTED, Json(snap))),
        Err(_) if state.update.is_restarting() => {
            Err(api_err(StatusCode::CONFLICT, Code::RestartInProgress))
        }
        Err(e) if e.reason == UpdateReason::UpdateInProgress => {
            // In-memory starter, or "cli" when a fallback CLI holds the lock.
            let started_by = state
                .update
                .snapshot()
                .install
                .map(|i| i.started_by)
                .unwrap_or(StartedBy::Cli);
            Err((
                StatusCode::CONFLICT,
                Json(UpdateApiError {
                    started_by: Some(started_by),
                    ..UpdateApiError::new(Code::UpdateInProgress)
                }),
            ))
        }
        Err(e) => Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(UpdateApiError {
                message: Some(e.message),
                ..UpdateApiError::new(e.reason.into())
            }),
        )),
    }
}

async fn handle_cancel(
    State(state): State<AppState>,
    payload: Option<Extension<TokenPayload>>,
) -> Result<Json<UpdateStatus>, ApiError> {
    require_mutating_scope(payload.as_deref())?;
    state
        .update
        .cancel()
        .map(Json)
        .map_err(|code| api_err(StatusCode::CONFLICT, code))
}

/// Validates the version and strips a leading `v` (stored without it).
fn valid_version(v: &str) -> Result<String, ApiError> {
    let v = v.trim().trim_start_matches('v');
    if parse(v).is_none() {
        return Err(api_err(StatusCode::BAD_REQUEST, Code::InvalidVersion));
    }
    Ok(v.to_string())
}

async fn handle_skip(
    State(state): State<AppState>,
    payload: Option<Extension<TokenPayload>>,
    Json(body): Json<VersionBody>,
) -> Result<Json<UpdateStatus>, ApiError> {
    require_mutating_scope(payload.as_deref())?;
    let v = valid_version(&body.version)?;
    Ok(Json(state.update.skip(&v).await))
}

async fn handle_unskip(
    State(state): State<AppState>,
    payload: Option<Extension<TokenPayload>>,
    Json(body): Json<VersionBody>,
) -> Result<Json<UpdateStatus>, ApiError> {
    require_mutating_scope(payload.as_deref())?;
    let v = valid_version(&body.version)?;
    Ok(Json(state.update.unskip(&v).await))
}

async fn handle_restart(
    State(state): State<AppState>,
    payload: Option<Extension<TokenPayload>>,
    Json(body): Json<RestartBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    require_mutating_scope(payload.as_deref())?;

    if state.update.is_hosted_by_tauri() {
        return Err(api_err(StatusCode::CONFLICT, Code::TauriHosted));
    }

    if state.update.snapshot().install.is_some() {
        return Err(api_err(StatusCode::CONFLICT, Code::UpdateInProgress));
    }

    if state.update.is_restarting() {
        return Err(api_err(StatusCode::CONFLICT, Code::RestartInProgress));
    }

    let impact = compute_impact(&state.store, &state.json_registry).await;

    if body.dry_run == Some(true) {
        return Ok((StatusCode::OK, Json(json!({ "impact": impact }))));
    }

    if !impact.is_empty() && body.confirm != Some(true) {
        return Err((
            StatusCode::CONFLICT,
            Json(UpdateApiError {
                impact: Some(impact),
                ..UpdateApiError::new(Code::RestartBusy)
            }),
        ));
    }

    state
        .update
        .begin_restart()
        .map_err(|code| api_err(StatusCode::CONFLICT, code))?;

    Ok((StatusCode::ACCEPTED, Json(json!({ "ok": true }))))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/update/check", get(handle_check))
        .route("/update/settings", post(handle_settings))
        .route("/update/install", post(handle_install))
        .route("/update/cancel", post(handle_cancel))
        .route("/update/skip", post(handle_skip))
        .route("/update/unskip", post(handle_unskip))
        .route("/daemon/restart", post(handle_restart))
}
