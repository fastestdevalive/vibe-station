//! Wire shapes of `POST /api/accounts/validate-path` and
//! `POST /api/accounts/folder`, mirrored in `web-ui/src/api/types.ts`.

use serde::{Deserialize, Serialize};

use crate::AccountSummary;

/// `POST /api/accounts/validate-path` and `POST /api/accounts/folder` body.
/// `dir` is required for `choose`, ignored for `create`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountFolderBody {
    pub cli: String,
    pub mode: AccountFolderMode,
    #[serde(default)]
    pub dir: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
}

/// The two ways to give an account a folder.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccountFolderMode {
    Create,
    Choose,
}

/// Response of `validate-path`: the resolved folder and what is in it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateAccountPathResponse {
    pub dir: String,
    pub exists: bool,
    pub is_empty: bool,
    pub looks_valid: bool,
}

/// Response of `folder` (201): `signed_in` is `!account.pending`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddFolderAccountResponse {
    pub account: AccountSummary,
    pub signed_in: bool,
}
