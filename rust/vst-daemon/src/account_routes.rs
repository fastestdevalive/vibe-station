//! Thin REST handlers for the accounts registry (multi-account A3.4,
//! Decision 2): parse, call the owner, serialise. Validation, folders, labels,
//! attempts and events live in `vst-accounts`; the error envelope lives in
//! `account_errors.rs`. No handler ever echoes an API key (R6).

use std::str::FromStr;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use vst_types::{
    normalize_account_id, AccountSummary, CliId, FinishSignInBody, RemoveAccountResponse,
    RenameAccountBody, SetDefaultBody, StartSignInBody, SYSTEM_ACCOUNT_ID,
};

use crate::account_errors::{account_error, accounts_unavailable, error_body, sign_in_error};
use crate::account_signin::{restart_sign_in, start_sign_in};
use crate::accounts_wiring::check_identity;
use crate::server::AppState;

/// The accounts routes, relative to `/api`.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/accounts", get(list_accounts).post(create_api_key_account))
        .route("/accounts/sign-in", post(start_account_sign_in))
        .route(
            "/accounts/sign-in/:attempt_id",
            delete(cancel_account_sign_in),
        )
        .route(
            "/accounts/sign-in/:attempt_id/finish",
            post(finish_account_sign_in),
        )
        .route("/accounts/:cli/default", put(set_default_account))
        .route(
            "/accounts/:cli/:id",
            patch(rename_account).delete(remove_account),
        )
        .route("/accounts/:cli/:id/sign-in", post(restart_account_sign_in))
        .route("/accounts/:cli/:id/usage", get(account_usage))
        .route("/accounts/:cli/:id/refresh", post(refresh_account))
        .merge(crate::account_folder_routes::routes())
}

/// `POST /api/accounts` — API-key account (manual `Debug` redacts the key).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateApiKeyRequest {
    cli: String,
    method: String,
    api_key: String,
    label: String,
}

impl std::fmt::Debug for CreateApiKeyRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CreateApiKeyRequest")
            .field("cli", &self.cli)
            .field("method", &self.method)
            .field("label", &self.label)
            .field("api_key", &"<redacted>")
            .finish()
    }
}

async fn list_accounts(State(state): State<AppState>) -> Response {
    let Some(accounts) = state.accounts.clone() else {
        return accounts_unavailable();
    };
    Json(json!({ "accounts": accounts.list() })).into_response()
}

async fn create_api_key_account(
    State(state): State<AppState>,
    Json(body): Json<CreateApiKeyRequest>,
) -> Response {
    let Some(accounts) = state.accounts.clone() else {
        return accounts_unavailable();
    };
    if body.method != "api_key" {
        return error_body(
            StatusCode::BAD_REQUEST,
            "invalid_method",
            "Only the api_key method is accepted here.",
            None,
        );
    }
    if CliId::from_str(&body.cli).is_err() {
        return error_body(
            StatusCode::NOT_FOUND,
            "unknown_cli",
            &format!("Unknown CLI '{}'.", body.cli),
            None,
        );
    }
    match accounts.add_api_key(&body.cli, &body.api_key, &body.label) {
        Ok(summary) => (StatusCode::CREATED, Json(summary)).into_response(),
        Err(e) => account_error(&e, None),
    }
}

async fn start_account_sign_in(
    State(state): State<AppState>,
    Json(body): Json<StartSignInBody>,
) -> Response {
    let Some(accounts) = state.accounts.clone() else {
        return accounts_unavailable();
    };
    match start_sign_in(
        &accounts,
        &state.session_routes,
        &state.broadcaster,
        &body.cli,
        &body.worktree_id,
        body.label.as_deref(),
    )
    .await
    {
        Ok(started) => (StatusCode::ACCEPTED, Json(started)).into_response(),
        Err(e) => sign_in_error(&e),
    }
}

async fn cancel_account_sign_in(
    State(state): State<AppState>,
    Path(attempt_id): Path<String>,
) -> Response {
    let Some(accounts) = state.accounts.clone() else {
        return accounts_unavailable();
    };
    match accounts.cancel_sign_in(&attempt_id) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => account_error(&e, None),
    }
}

async fn finish_account_sign_in(
    State(state): State<AppState>,
    Path(attempt_id): Path<String>,
    Json(body): Json<FinishSignInBody>,
) -> Response {
    let Some(accounts) = state.accounts.clone() else {
        return accounts_unavailable();
    };
    match accounts
        .finish_sign_in(&attempt_id, body.label.as_deref())
        .await
    {
        Ok(summary) => Json(summary).into_response(),
        Err(e) => account_error(&e, None),
    }
}

/// `POST /api/accounts/:cli/:id/sign-in` — re-sign-in of an existing account.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestartSignInRequest {
    worktree_id: String,
}

async fn restart_account_sign_in(
    State(state): State<AppState>,
    Path((cli, id)): Path<(String, String)>,
    Json(body): Json<RestartSignInRequest>,
) -> Response {
    let Some(accounts) = state.accounts.clone() else {
        return accounts_unavailable();
    };
    match restart_sign_in(
        &accounts,
        &state.session_routes,
        &state.broadcaster,
        &cli,
        &id,
        &body.worktree_id,
    )
    .await
    {
        Ok(started) => (StatusCode::ACCEPTED, Json(started)).into_response(),
        Err(e) => sign_in_error(&e),
    }
}

async fn rename_account(
    State(state): State<AppState>,
    Path((cli, id)): Path<(String, String)>,
    Json(body): Json<RenameAccountBody>,
) -> Response {
    let Some(accounts) = state.accounts.clone() else {
        return accounts_unavailable();
    };
    match accounts.rename(&cli, &id, body.label) {
        Ok(summary) => Json(summary).into_response(),
        Err(e) => account_error(&e, None),
    }
}

async fn set_default_account(
    State(state): State<AppState>,
    Path(cli): Path<String>,
    Json(body): Json<SetDefaultBody>,
) -> Response {
    let Some(accounts) = state.accounts.clone() else {
        return accounts_unavailable();
    };
    let normalized = normalize_account_id(Some(&body.account_id));
    match accounts.set_default(&cli, &body.account_id) {
        Ok(()) => {
            let list = accounts.list();
            let accounts_of_cli: Vec<AccountSummary> =
                list.into_iter().filter(|a| a.cli == cli).collect();
            Json(json!({ "accounts": accounts_of_cli })).into_response()
        }
        Err(e) => account_error(&e, normalized.as_deref()),
    }
}

async fn account_usage(
    State(state): State<AppState>,
    Path((cli, id)): Path<(String, String)>,
) -> Response {
    let Some(accounts) = state.accounts.clone() else {
        return accounts_unavailable();
    };
    let normalized = normalize_account_id(Some(&id));
    if accounts.locate(&cli, normalized.as_deref()).is_none() {
        return error_body(
            StatusCode::NOT_FOUND,
            "account_not_found",
            "Account not found.",
            None,
        );
    }
    let (usage, _) = state
        .session_routes
        .usage_for_account(&cli, normalized.as_deref())
        .await;
    Json(usage).into_response()
}

async fn refresh_account(
    State(state): State<AppState>,
    Path((cli, id)): Path<(String, String)>,
) -> Response {
    let Some(accounts) = state.accounts.clone() else {
        return accounts_unavailable();
    };
    let normalized = normalize_account_id(Some(&id));
    // A pending row is confirmed only here (the one path that may finish an
    // unverifiable row); every other trigger is background (Decision 2).
    if let Some(pending_id) = normalized
        .as_deref()
        .filter(|pid| accounts.is_pending(&cli, pid))
    {
        return match accounts.confirm_pending(&cli, pending_id).await {
            Ok(summary) => Json(summary).into_response(),
            Err(e) => account_error(&e, Some(pending_id)),
        };
    }
    match check_identity(
        &accounts,
        &state.session_routes,
        &cli,
        normalized.as_deref(),
    )
    .await
    {
        Some(summary) => Json(summary).into_response(),
        None => error_body(
            StatusCode::NOT_FOUND,
            "account_not_found",
            "Account not found.",
            None,
        ),
    }
}

async fn remove_account(
    State(state): State<AppState>,
    Path((cli, id)): Path<(String, String)>,
) -> Response {
    let Some(accounts) = state.accounts.clone() else {
        return accounts_unavailable();
    };
    if id == SYSTEM_ACCOUNT_ID {
        return error_body(
            StatusCode::BAD_REQUEST,
            "cannot_remove_system",
            "The System login cannot be removed.",
            None,
        );
    }
    if accounts.locate(&cli, Some(&id)).is_none() {
        return error_body(
            StatusCode::NOT_FOUND,
            "account_not_found",
            "Account not found.",
            None,
        );
    }
    // Removal order (Risk 1): release the account's sessions BEFORE the folder
    // and record go, so nothing is left pointing at a vanished account.
    let stopped = state
        .session_routes
        .halt_sessions_for_account(&cli, &id)
        .await;
    match accounts.remove(&cli, &id) {
        Ok(folder_deleted) => Json(RemoveAccountResponse {
            ok: true,
            stopped_session_ids: stopped,
            folder_deleted,
        })
        .into_response(),
        Err(e) => account_error(&e, None),
    }
}
