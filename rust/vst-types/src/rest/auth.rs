//! `routes/auth.ts` — logout, check, sessions, revoke, revoke-browser.

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use super::shared::TokenSession;

/// `POST /auth/logout` and `GET /auth/check` success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OkResult {
    pub ok: bool,
}

/// `GET /auth/sessions` response.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSessionsResult {
    pub sessions: Vec<TokenSession>,
    pub is_desktop: bool,
    pub current_scope: String,
    pub current_token_id: Option<String>,
}

/// `POST /auth/revoke-browser` success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokeBrowserResult {
    pub ok: bool,
    pub browser_epoch: i64,
}
