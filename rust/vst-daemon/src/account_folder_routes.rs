//! Thin handlers for the folder-based "add account" flow: parse, call
//! `vst-accounts`, serialise. The wire shapes live in `vst-types`
//! (`account_folder.rs`); the error envelope in `account_errors.rs`.

use std::str::FromStr;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use vst_accounts::paths::PathRefusal;
use vst_accounts::{AccountsError, FolderSpec};
use vst_types::{
    collapse_home, AccountFolderBody, AccountFolderMode, AddFolderAccountResponse, CliId,
    ValidateAccountPathResponse,
};

use crate::account_errors::{account_error, accounts_unavailable, error_body};
use crate::server::AppState;

/// The folder routes, relative to `/api`.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/accounts/validate-path", post(validate_account_path))
        .route("/accounts/folder", post(add_folder_account))
}

/// The folder request as the registry's spec. `choose` without a `dir` is the
/// same refusal as a path that is not usable.
fn folder_spec(body: &AccountFolderBody) -> Result<FolderSpec, AccountsError> {
    match (body.mode, &body.dir) {
        (AccountFolderMode::Create, _) => Ok(FolderSpec::Create),
        (AccountFolderMode::Choose, Some(dir)) => Ok(FolderSpec::Choose(dir.clone())),
        (AccountFolderMode::Choose, None) => Err(AccountsError::Path(PathRefusal::Invalid)),
    }
}

/// `404 unknown_cli` for a CLI this build does not know.
fn unknown_cli(cli: &str) -> Response {
    error_body(
        StatusCode::NOT_FOUND,
        "unknown_cli",
        &format!("Unknown CLI '{cli}'."),
        None,
    )
}

/// `POST /api/accounts/validate-path` — read-only: checks a folder, writes nothing.
async fn validate_account_path(
    State(state): State<AppState>,
    Json(body): Json<AccountFolderBody>,
) -> Response {
    let Some(accounts) = state.accounts.clone() else {
        return accounts_unavailable();
    };
    if CliId::from_str(&body.cli).is_err() {
        return unknown_cli(&body.cli);
    }
    let spec = match folder_spec(&body) {
        Ok(spec) => spec,
        Err(e) => return account_error(&e, None),
    };
    match accounts.validate_folder(&body.cli, &spec, body.label.as_deref()) {
        Ok(check) => Json(ValidateAccountPathResponse {
            dir: collapse_home(&check.resolved, &vst_agents::home::home_dir()),
            exists: check.exists,
            is_empty: check.is_empty,
            looks_valid: check.looks_valid,
        })
        .into_response(),
        Err(e) => account_error(&e, None),
    }
}

/// `POST /api/accounts/folder` — validates again, then adds the account (201).
async fn add_folder_account(
    State(state): State<AppState>,
    Json(body): Json<AccountFolderBody>,
) -> Response {
    let Some(accounts) = state.accounts.clone() else {
        return accounts_unavailable();
    };
    if CliId::from_str(&body.cli).is_err() {
        return unknown_cli(&body.cli);
    }
    let spec = match folder_spec(&body) {
        Ok(spec) => spec,
        Err(e) => return account_error(&e, None),
    };
    match accounts
        .add_folder(&body.cli, spec, body.label.as_deref())
        .await
    {
        Ok(account) => {
            let signed_in = !account.pending;
            (
                StatusCode::CREATED,
                Json(AddFolderAccountResponse { account, signed_in }),
            )
                .into_response()
        }
        Err(e) => account_error(&e, None),
    }
}
