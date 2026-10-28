//! Artifacts REST bodies (`GET /worktrees/:id/artifacts`, `POST /artifacts`,
//! `POST /artifacts/:id/pin`, `DELETE /artifacts/:id`, content errors).

use serde::{Deserialize, Serialize};

use crate::artifacts::ArtifactRow;

/// Machine-readable artifact error codes (also the content route's JSON
/// `error` value and the per-path `error.code` of `POST /artifacts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ArtifactErrorCode {
    ArtifactDenied,
    ArtifactIneligible,
    ArtifactNotFound,
    ArtifactMissing,
    ArtifactUnreadable,
    ArtifactBinary,
    ArtifactTooLarge,
    NotFound,
    ValidationError,
    PinLimit,
    RateLimited,
    SessionArchived,
}

/// `GET /worktrees/:id/artifacts` and `GET /projects/:id/artifacts`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactListResponse {
    /// Per-scope event counter, read BEFORE the rows.
    pub rev: u64,
    pub cap: u32,
    /// All rows counting toward the cap, hidden included.
    pub total: u32,
    pub items: Vec<ArtifactRow>,
}

/// `POST /artifacts` body (CLI). Scope comes from the spawn token.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddArtifactsRequest {
    pub spawn_token: String,
    /// Absolute paths, 1..=50.
    pub paths: Vec<String>,
}

/// A per-path failure inside [`AddArtifactsResponse`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ArtifactPathError {
    pub code: ArtifactErrorCode,
    pub message: String,
}

/// One entry of [`AddArtifactsResponse::results`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddArtifactResult {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact: Option<ArtifactRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outside_worktree: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ArtifactPathError>,
}

/// `POST /artifacts` response.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AddArtifactsResponse {
    pub results: Vec<AddArtifactResult>,
}

/// `POST /artifacts/:id/pin` body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PinArtifactRequest {
    pub pinned: bool,
}

/// `POST /artifacts/:id/pin` response.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PinArtifactResponse {
    pub artifact: ArtifactRow,
}

/// Content-route error body: `{ error: CODE, message, ...detail }`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ArtifactContentError {
    pub error: ArtifactErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}
