//! Spawn/plugin-facing account types: the in-memory API key, resolved accounts,
//! hand-over descriptions and the `AccountPort` trait (split from `accounts.rs`).

use std::fmt;
use std::path::PathBuf;

use crate::accounts::*;
use crate::domain::SessionRecord;

/// An API key held in memory. Deliberately has no `Serialize`, no `Display` and
/// a redacted `Debug`; the only way to read the bytes is [`ApiKey::expose`],
/// used once at spawn time to build the env var (R6).
#[derive(Clone, PartialEq, Eq)]
pub struct ApiKey(String);

impl ApiKey {
    /// The key bytes. Never log, store, serialize or put this in an error.
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ApiKey(<redacted>)")
    }
}

impl From<String> for ApiKey {
    fn from(value: String) -> Self {
        Self(value)
    }
}

/// The account a spawn/probe resolves to. `id`/`dir`/`api_key` all `None` = the
/// CLI's System login (no folder, no env).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedAccount {
    pub cli: String,
    /// `None` = System login.
    pub id: Option<String>,
    /// The account folder; `None` for the System login.
    pub dir: Option<PathBuf>,
    /// Present only for an `api_key` account.
    pub api_key: Option<ApiKey>,
}

impl ResolvedAccount {
    /// The virtual System login of `cli`: no folder, no env, no key.
    #[must_use]
    pub fn system(cli: &str) -> Self {
        Self {
            cli: cli.to_string(),
            id: None,
            dir: None,
            api_key: None,
        }
    }
}

/// What the plugin's identity command reported. `signed_in: None` = unknown
/// (e.g. the command failed); it changes nothing (Decision 12).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccountIdentity {
    pub signed_in: Option<bool>,
    pub email: Option<String>,
    pub plan: Option<String>,
}

/// Which entries of the CLI's own system directory are symlinked into an
/// account folder. `AllExcept` = every entry of `source_dir` except the listed
/// names (used where a private dir would hide unrelated tool configs).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SharedSet {
    Named(Vec<&'static str>),
    AllExcept(Vec<&'static str>),
}

/// The CLI's own system dir plus the entries to link into the account folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SharedEntries {
    pub source_dir: PathBuf,
    pub set: SharedSet,
}

/// How a native-history file crosses into the target account folder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransferMode {
    Copy,
    HardLink,
}

/// One file to move into the target account folder for a native hand-over.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileTransfer {
    pub from: PathBuf,
    pub to: PathBuf,
    pub mode: TransferMode,
}

/// What the plugin says it can do to keep the model's context across an
/// account switch. The planner downgrades this to Transcript/Fresh when the
/// source account is gone, the CLI changed, or no chat id exists.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum AccountHandover {
    /// No bridge from this CLI's session to its own resume flag (transcript).
    #[default]
    Unsupported,
    /// The native store is account-independent (nothing to copy).
    InPlace,
    /// Copy/hard-link these files, then resume with the same native id.
    Files(Vec<FileTransfer>),
}

/// Arguments for `AgentPlugin::account_session_handover`.
#[derive(Clone, Debug)]
pub struct HandoverArgs<'a> {
    pub session: &'a SessionRecord,
    pub cwd: &'a str,
    pub from: &'a ResolvedAccount,
    pub to: &'a ResolvedAccount,
}

/// One "this account is limited" observation (poller window or chat event).
#[derive(Clone, Debug, PartialEq)]
pub struct LimitSignal {
    pub window_id: String,
    /// 0..=100.
    pub used_pct: f64,
    pub resets_at: Option<String>,
    /// The vendor rejected the request for this window.
    pub rejected: bool,
}

/// Why a spawn-time account lookup failed. Removal deletes the record, so a
/// vanished account is `NotFound` (an id the caller picked ⇒ 404
/// `account_not_found`; an id stored on a session ⇒ 409 `account_removed`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum AccountResolveError {
    #[error("account not found")]
    NotFound,
    #[error("account is signed out")]
    SignedOut,
    #[error("account sign-in is still pending")]
    Pending,
}

/// The accounts registry, as seen by the spawn path. Implemented by
/// `vst_accounts::AccountsHandle`; `None` in tests = every session is System.
///
/// SPAWN-time lookup only: errors on `NotFound` / `Pending` / `SignedOut`
/// (R7 — no silent fallback). Login, identity and limits probes must use
/// `AccountsHandle::locate` instead.
pub trait AccountPort: Send + Sync {
    /// Resolve the account a session must run under. `account_id: None` =
    /// the System login.
    ///
    /// # Errors
    ///
    /// `NotFound` for an unknown id, `Pending` while a sign-in is unfinished,
    /// `SignedOut` when the CLI reports no login. Callers must NOT spawn on an
    /// error (R7).
    fn resolve(
        &self,
        cli: &str,
        account_id: Option<&str>,
    ) -> Result<ResolvedAccount, AccountResolveError>;

    /// Feed a structured chat limit signal into the one "limited" state
    /// (the only writer is `AccountsHandle::set_limited`).
    fn report_limit(&self, cli: &str, account_id: Option<&str>, signal: LimitSignal);
}

/// Map a request's `accountId` to the persisted form: `"system"`, `""` and
/// absent all mean the System login (`None`). Every boundary that accepts an
/// account id calls this exactly once (Decision 4).
#[must_use]
pub fn normalize_account_id(id: Option<&str>) -> Option<String> {
    id.map(str::trim)
        .filter(|s| !s.is_empty() && *s != SYSTEM_ACCOUNT_ID)
        .map(str::to_string)
}
