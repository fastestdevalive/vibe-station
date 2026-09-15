//! `GET /settings`, `PATCH /settings` — `routes/settings.ts`.

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

/// The full config shape returned by `GET /settings`: `MainConfig` +
/// `UserSettings` + a runtime `homeDir`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub default_projects_dir: Option<String>,
    pub skill_paths: Option<Vec<String>>,
    pub pid: Option<i64>,
    pub port: Option<i64>,
    pub cli_token: Option<String>,
    pub tauri_token: Option<String>,
    pub browser_epoch: Option<i64>,
    pub started_at: Option<String>,
    pub home_dir: String,
}

/// `PATCH /settings` request body (all optional).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchSettingsBody {
    pub default_projects_dir: Option<String>,
    pub skill_paths: Option<Vec<String>>,
}

/// `PATCH /settings` success response.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchSettingsResult {
    pub ok: bool,
}
