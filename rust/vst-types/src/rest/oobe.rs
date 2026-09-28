//! OOBE (out-of-the-box experience) onboarding wire shapes, shared between
//! `vst-daemon`'s OOBE routes and the web-ui client.

use serde::{Deserialize, Serialize};

use crate::rest::modes::SupportedCli;
use crate::rest::shared::Mode;

/// `GET /oobe/state` response.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OobeStateResponse {
    pub completed: bool,
    /// The onboarding step the user is currently on — `1`, `2`, or `3`.
    pub current_step: u8,
    pub default_projects_dir: String,
    /// The resolved `~/.vibe-station` path (varies by `$HOME`, e.g. a
    /// container's `/home/vst/.vibe-station`) — shown on step 1 so the user
    /// knows where the daemon's own config/data lives and where any
    /// project's worktrees will actually be created, both independent of
    /// whatever projects directory they choose here.
    pub vst_home: String,
}

/// `POST /oobe/step1` request body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmStep1Body {
    pub default_projects_dir: String,
}

/// `POST /oobe/step1` success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmStep1Result {
    pub ok: bool,
    pub default_projects_dir: String,
}

/// `POST /oobe/detect-and-bundle` success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectAndBundleResult {
    pub supported_clis: Vec<SupportedCli>,
    pub created: Vec<Mode>,
}

/// `POST /oobe/step2` success — step 2 has no user-supplied fields (the
/// mode/bundle creation it confirms already persisted via `/api/modes`),
/// so there is no matching `ConfirmStep2Body`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmStep2Result {
    pub ok: bool,
}

/// `POST /modes/:cli/starter-bundle` success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StarterBundleResult {
    pub created: Vec<Mode>,
    pub already_present: Vec<Mode>,
    pub skipped: Vec<String>,
    pub used_fallback: bool,
    pub already_complete: bool,
}

/// `POST /oobe/complete` success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteOobeResult {
    pub ok: bool,
    pub completed: bool,
}
