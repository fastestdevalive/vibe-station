//! `GET /api/update/check` + related update wire types.
//!
//! Source of truth for the update wire types; hand-mirrored in
//! `web-ui/src/api/types.ts` (same commit). The `UpdateStatus` snapshot is the
//! ONLY shape clients see.

use serde::{Deserialize, Serialize};

/// How the running daemon was installed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum InstallMethod {
    #[serde(rename = "curl")]
    Curl,
    #[serde(rename = "curl-appimage")]
    CurlAppImage,
    #[serde(rename = "appimage")]
    AppImage,
    #[serde(rename = "dmg")]
    Dmg,
    #[serde(rename = "deb")]
    Deb,
    #[serde(rename = "unknown")]
    Unknown,
}

/// One install target: a specific file the daemon can (or cannot) update.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTarget {
    pub method: InstallMethod,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub auto: bool,
}

/// Whether the last error came from a check, an install, or a restart.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateErrorKind {
    Check,
    Install,
    Restart,
}

/// Machine-readable failure reason (snake_case). The web maps each to copy +
/// recovery in `components/update/errorRecovery.tsx`, the CLI in
/// `update_install.rs::error_lines`; adding a variant means updating both plus
/// `web-ui/src/api/types.ts`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateReason {
    Offline,
    GithubError,
    RateLimited,
    NoAsset,
    MissingChecksum,
    /// The release has no `SHA256SUMS.minisig` (unsigned or predates signing).
    MissingSignature,
    /// The manifest signature, shape, or tag binding failed verification.
    BadSignature,
    /// The signed release is not newer than the running version.
    Downgrade,
    ChecksumMismatch,
    SmokeFailed,
    PermissionDenied,
    DiskFull,
    UpdateInProgress,
    RestartBusy,
    TauriHosted,
    RestartTimeout,
    BootFailed,
    /// download cancelled — clears `lastError` instead of setting it
    Cancelled,
    /// rename/IO error during replace — rendered like `permission_denied`
    /// minus the sudo command
    WriteFailed,
}

/// A persisted check/install/restart error.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateError {
    pub kind: UpdateErrorKind,
    pub reason: UpdateReason,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<String>,
}

/// Install pipeline stage.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallStage {
    Preflight,
    Downloading,
    Verifying,
    Installing,
}

/// Who started an install.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StartedBy {
    Ui,
    Cli,
}

/// Live install progress.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub stage: InstallStage,
    pub pct: u8,
    pub started_by: StartedBy,
}

/// Whether a restart is pending and what kind of process it covers.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartPending {
    pub version: String,
    pub kind: RestartKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestartKind {
    Daemon,
    App,
}

/// A rolled-back (boot-failed) install.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RolledBack {
    pub failed_version: String,
    pub at: String,
}

/// A manual step the user must perform (dmg/deb flows).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualStep {
    pub kind: ManualStepKind,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ManualStepKind {
    OpenUrl,
    Command,
    Text,
}

/// Result of a completed install.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub version: String,
    pub updated: Vec<String>,
    pub manual: Vec<ManualStep>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deb_path: Option<String>,
}

/// What kind of work a restart would interrupt for one session.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImpactKind {
    Working,
    Pty,
    JsonTurn,
}

/// One session that would be affected by a restart.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImpactItem {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub kind: ImpactKind,
}

/// The daemon-owned update snapshot — the ONLY shape clients see.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// running version, no "v"
    pub current: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest: Option<String>,
    /// markdown, <= 64 KB
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changelog: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_url: Option<String>,
    pub behind_count: u32,
    /// latest > current, parseable current
    pub update_available: bool,
    pub skipped: Vec<String>,
    pub install_method: InstallMethod,
    pub targets: Vec<UpdateTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<UpdateError>,
    pub auto_check: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install: Option<InstallProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restart_pending: Option<RestartPending>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rolled_back: Option<RolledBack>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_result: Option<InstallResult>,
    /// e.g. "linux-x86_64"
    pub platform: String,
    /// No asset exists for this platform: the UI offers only "View release".
    pub no_asset: bool,
}

/// `GET /api/update/check` response.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResponse {
    #[serde(flatten)]
    pub status: UpdateStatus,
    /// false for Mobile
    pub can_install: bool,
}

/// `POST /api/update/skip|unskip` body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionBody {
    pub version: String,
}

/// `POST /api/update/settings` body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsBody {
    pub auto_check: bool,
}

/// `POST /api/daemon/restart` body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartBody {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirm: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// The `error` code in an update/restart route's non-2xx JSON body.
///
/// The named variants are the route-level codes; `Reason` carries any
/// [`UpdateReason`] an install failure reports (422), and `Unknown` keeps a
/// code from an older/newer daemon so a client never fails to parse a body.
/// Use [`From<UpdateReason>`] to build `Reason` (it folds the three reasons
/// that also have a named variant into that variant).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateApiErrorCode {
    MobileReadOnly,
    UpdateInProgress,
    RestartInProgress,
    RestartBusy,
    TauriHosted,
    NotCancellable,
    InvalidVersion,
    #[serde(untagged)]
    Reason(UpdateReason),
    #[serde(untagged)]
    Unknown(String),
}

impl From<UpdateReason> for UpdateApiErrorCode {
    fn from(r: UpdateReason) -> Self {
        match r {
            UpdateReason::UpdateInProgress => Self::UpdateInProgress,
            UpdateReason::RestartBusy => Self::RestartBusy,
            UpdateReason::TauriHosted => Self::TauriHosted,
            other => Self::Reason(other),
        }
    }
}

/// Non-2xx body of the update/restart routes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateApiError {
    pub error: UpdateApiErrorCode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// `update_in_progress`: who holds the install.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_by: Option<StartedBy>,
    /// `restart_busy`: sessions a restart would interrupt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub impact: Option<Vec<ImpactItem>>,
}

impl UpdateApiError {
    pub fn new(error: UpdateApiErrorCode) -> Self {
        Self {
            error,
            message: None,
            started_by: None,
            impact: None,
        }
    }
}

#[cfg(test)]
mod api_error_tests {
    use super::*;

    #[test]
    fn named_reason_and_unknown_codes_round_trip() {
        let named: UpdateApiError =
            serde_json::from_str(r#"{"error":"restart_in_progress"}"#).unwrap();
        assert_eq!(named.error, UpdateApiErrorCode::RestartInProgress);
        let reason: UpdateApiError =
            serde_json::from_str(r#"{"error":"no_asset","message":"m"}"#).unwrap();
        assert_eq!(
            reason.error,
            UpdateApiErrorCode::Reason(UpdateReason::NoAsset)
        );
        let unk: UpdateApiError = serde_json::from_str(r#"{"error":"from_the_future"}"#).unwrap();
        assert_eq!(
            unk.error,
            UpdateApiErrorCode::Unknown("from_the_future".into())
        );
        assert_eq!(
            serde_json::to_string(&UpdateApiError::new(UpdateApiErrorCode::NotCancellable))
                .unwrap(),
            r#"{"error":"not_cancellable"}"#
        );
        assert_eq!(
            UpdateApiErrorCode::from(UpdateReason::TauriHosted),
            UpdateApiErrorCode::TauriHosted
        );
    }
}
