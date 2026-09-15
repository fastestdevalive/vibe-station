//! `POST /open` — `routes/open.ts`.

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

/// `POST /open` request body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenBody {
    pub path: String,
}

/// `POST /open` success response.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    pub project_id: String,
}

/// `POST /open` error responses.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenError {
    pub error: String,
    /// `"Path must be absolute"`, `"Could not derive a safe project id"`, etc.
    pub detail: Option<String>,
}
