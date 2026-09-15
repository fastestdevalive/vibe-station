//! `routes/modes.ts` — supported-clis, cli-models, modes CRUD.

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::domain::CliId;

/// One element of `GET /supported-clis`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportedCli {
    pub id: CliId,
    pub default_model: String,
    pub supports_json: bool,
    pub imports_native_history: bool,
    pub supports_json_to_terminal_resume: bool,
}

/// `GET /cli-models` response.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliModels {
    pub models: Vec<String>,
    /// Present only when the fetch failed.
    pub error: Option<String>,
}

/// `POST /modes` request body.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateModeBody {
    pub name: String,
    pub cli: CliId,
    pub context: String,
    pub preset_id: Option<String>,
    pub model: Option<String>,
}

/// `PUT /modes/:id` request body (patch semantics, all optional).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateModeBody {
    pub name: Option<String>,
    pub context: Option<String>,
    pub cli: Option<CliId>,
    pub model: Option<String>,
}

/// `DELETE /modes/:id` success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteModeResult {
    pub ok: bool,
    pub affected_sessions: i64,
}

/// Mode errors that carry extra data.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeError {
    pub error: String,
    pub conflict_with: Option<String>,
}
