//! The ONE error table for the accounts routes (multi-account plan A3.4).
//!
//! Every handler maps its owner error through these functions, so the wire
//! envelope `{ "error": "<message>", "code": "<code>"[, "accountId": "<id>"] }`
//! is produced in exactly one place. Kept beside `account_routes.rs` so the thin
//! route file stays thin.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use vst_accounts::paths::PathRefusal;
use vst_accounts::AccountsError;

use crate::account_signin::SignInStartError;

/// The error envelope every accounts handler uses.
pub(crate) fn error_body(
    status: StatusCode,
    code: &str,
    message: &str,
    account_id: Option<&str>,
) -> Response {
    let mut body = json!({ "error": message, "code": code });
    if let (Some(obj), Some(id)) = (body.as_object_mut(), account_id) {
        obj.insert("accountId".to_string(), json!(id));
    }
    (status, Json(body)).into_response()
}

/// The ONE error table for `AccountsError`.
pub(crate) fn account_error(e: &AccountsError, account_id: Option<&str>) -> Response {
    match e {
        AccountsError::Unsupported => error_body(
            StatusCode::BAD_REQUEST,
            "accounts_unsupported",
            "Accounts are not supported for this CLI.",
            None,
        ),
        AccountsError::Label(_) => error_body(
            StatusCode::BAD_REQUEST,
            "label_required",
            &e.to_string(),
            None,
        ),
        AccountsError::LabelTaken => error_body(
            StatusCode::CONFLICT,
            "label_taken",
            "That name is already taken for this CLI.",
            None,
        ),
        AccountsError::NotFound => error_body(
            StatusCode::NOT_FOUND,
            "account_not_found",
            "Account not found.",
            None,
        ),
        AccountsError::SystemAccount => error_body(
            StatusCode::BAD_REQUEST,
            "cannot_remove_system",
            "The System login cannot be removed.",
            None,
        ),
        AccountsError::SignedOut => error_body(
            StatusCode::CONFLICT,
            "account_signed_out",
            "This account is signed out. Sign in, then try again.",
            account_id,
        ),
        AccountsError::AttemptNotFound => error_body(
            StatusCode::NOT_FOUND,
            "attempt_not_found",
            "Sign-in attempt not found.",
            None,
        ),
        AccountsError::AttemptNotDone => error_body(
            StatusCode::CONFLICT,
            "attempt_not_done",
            "The sign-in has not finished yet.",
            None,
        ),
        AccountsError::Duplicate => error_body(
            StatusCode::CONFLICT,
            "duplicate_account",
            "This login is already added for this CLI.",
            None,
        ),
        AccountsError::InvalidKey(_) => {
            error_body(StatusCode::BAD_REQUEST, "invalid_key", &e.to_string(), None)
        }
        AccountsError::Path(refusal) => path_refusal_error(refusal),
        AccountsError::FolderCreate => folder_create_error(),
        AccountsError::DuplicateIdentity {
            email,
            name,
            folder_deleted,
        } => {
            let folder = if *folder_deleted {
                "the folder vibe-station created for it was removed"
            } else {
                "your folder is untouched"
            };
            error_body(
                StatusCode::CONFLICT,
                "duplicate_account",
                &format!("{email} is already added as \"{name}\". Nothing was added; {folder}."),
                None,
            )
        }
        AccountsError::Poisoned | AccountsError::Io(_) | AccountsError::Secret(_) => {
            tracing::error!("accounts storage failure: {e}");
            error_body(
                StatusCode::INTERNAL_SERVER_ERROR,
                "accounts_storage_failed",
                "The accounts registry could not be updated.",
                None,
            )
        }
    }
}

/// The folder-create failure body (nothing was added).
fn folder_create_error() -> Response {
    error_body(
        StatusCode::INTERNAL_SERVER_ERROR,
        "folder_create_failed",
        "Could not create this folder. Nothing was added.",
        None,
    )
}

/// The folder-validation table: one code, status and text per refusal.
fn path_refusal_error(refusal: &PathRefusal) -> Response {
    match refusal {
        PathRefusal::Invalid => error_body(
            StatusCode::BAD_REQUEST,
            "path_invalid",
            "Enter a full path, or one starting with ~, without \"..\".",
            None,
        ),
        PathRefusal::TooBroad => error_body(
            StatusCode::BAD_REQUEST,
            "path_invalid",
            "Choose a more specific folder. This one contains your home or login folders.",
            None,
        ),
        PathRefusal::NotFound => error_body(
            StatusCode::NOT_FOUND,
            "folder_not_found",
            "Folder not found.",
            None,
        ),
        PathRefusal::NotADirectory => error_body(
            StatusCode::BAD_REQUEST,
            "folder_not_directory",
            "That is a file, not a folder.",
            None,
        ),
        PathRefusal::Unreadable => error_body(
            StatusCode::FORBIDDEN,
            "folder_unreadable",
            "This folder cannot be read.",
            None,
        ),
        PathRefusal::SystemFolder => error_body(
            StatusCode::CONFLICT,
            "folder_is_system",
            "That is your system login folder; it is already the default account.",
            None,
        ),
        PathRefusal::InsideRoot { owner } => {
            let message = match owner {
                Some(name) => format!("That folder belongs to the account \"{name}\"."),
                None => "That folder is managed by vibe-station.".to_string(),
            };
            error_body(
                StatusCode::CONFLICT,
                "folder_in_accounts_root",
                &message,
                None,
            )
        }
        PathRefusal::Duplicate { id, name } => error_body(
            StatusCode::CONFLICT,
            "folder_duplicate",
            &format!("Already added as {name}."),
            Some(id.as_str()),
        ),
        PathRefusal::Nested { name, inside, .. } => {
            let message = if *inside {
                format!("This folder is inside the folder of \"{name}\".")
            } else {
                format!("This folder contains the folder of \"{name}\".")
            };
            error_body(StatusCode::CONFLICT, "folder_nested", &message, None)
        }
    }
}

/// The 503 body when this daemon instance has no registry wired.
pub(crate) fn accounts_unavailable() -> Response {
    error_body(
        StatusCode::SERVICE_UNAVAILABLE,
        "accounts_unavailable",
        "The accounts registry is not available.",
        None,
    )
}

/// The sign-in start error table.
pub(crate) fn sign_in_error(e: &SignInStartError) -> Response {
    let status = StatusCode::from_u16(e.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let message = e.message();
    error_body(status, e.code(), &message, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn duplicate_message(folder_deleted: bool) -> String {
        let e = AccountsError::DuplicateIdentity {
            email: "a@b.c".to_string(),
            name: "Work".to_string(),
            folder_deleted,
        };
        let res = account_error(&e, None);
        assert_eq!(res.status(), StatusCode::CONFLICT);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .expect("body");
        let v: serde_json::Value = serde_json::from_slice(&bytes).expect("json");
        assert_eq!(v["code"], "duplicate_account");
        v["error"].as_str().expect("message").to_string()
    }

    #[tokio::test]
    async fn duplicate_message_says_whether_the_folder_was_removed() {
        assert_eq!(
            duplicate_message(false).await,
            "a@b.c is already added as \"Work\". Nothing was added; your folder is untouched."
        );
        assert_eq!(
            duplicate_message(true).await,
            "a@b.c is already added as \"Work\". Nothing was added; the folder vibe-station created for it was removed."
        );
    }
}
