//! Multi-account contract — the wire shapes, the persisted registry record and
//! the `AccountPort` seam (`docs/MULTI-ACCOUNT.md`).
//!
//! Mirrors the `web-ui/src/api/types.ts` accounts block (camelCase on the wire,
//! `snake_case` for enum values). The `AccountPort` trait lives here — like
//! `ReviewPort` — so `vst-agents` can reach the accounts registry without
//! depending on the `vst-accounts` crate (AGENTS.md "Agent plugin", R1/R2).
//!
//! `AccountPort` is spawn-only: it must NOT be used by sign-in, the identity
//! command, `/refresh` or limits probes (those need `AccountsHandle::locate`,
//! which ignores auth/pending — Decision 12).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The id of the virtual, per-CLI "System login" account. Never stored: the
/// persisted form of the System login is `account_id: None` (Decision 4).
pub const SYSTEM_ACCOUNT_ID: &str = "system";

/// How an account was created. `System` exists only in `AccountSummary` (the
/// System login is virtual, one per CLI) and in REST bodies/paths.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountMethod {
    System,
    SignIn,
    ApiKey,
}

/// Whether the vendor CLI is currently signed in to this account. Decided ONLY
/// by the plugin's identity command (`signed_in == Some(false)` ⇒ `SignedOut`),
/// never by a limits read alone (Decision 12).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountAuth {
    #[default]
    Unknown,
    SignedIn,
    SignedOut,
}

/// Which source marked an account limited.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitedSource {
    /// The limits poller (a window at 100% with a future reset time).
    Poller,
    /// A structured Rich Chat event from the agent.
    Chat,
}

/// The "this account is limited" payload carried by `AccountSummary.limited`
/// and the `account:limited` WS event. `None` in either place = cleared.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountLimited {
    /// The vendor window id, e.g. `five_hour`.
    pub window_id: String,
    /// ISO8601; absent when the vendor did not report a reset time.
    #[serde(default)]
    pub resets_at: Option<String>,
    pub source: LimitedSource,
}

/// State of an in-flight sign-in attempt (`account:signin`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignInState {
    Waiting,
    Done,
    Failed,
    Duplicate,
    Expired,
}

/// One row of `GET /api/accounts` — everything the UI shows about an account.
/// Never carries an API key or any credential.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    /// `"system"` (virtual, one per CLI) or `"acc_"` + 8 lowercase hex.
    pub id: String,
    /// CLI id, e.g. `"claude"`.
    pub cli: String,
    /// User-chosen name; `None` = none.
    #[serde(default)]
    pub label: Option<String>,
    /// Server-computed: label, else email, else id; the System row is
    /// "System login" unless it was labelled.
    pub display_name: String,
    /// Read through the vendor's own command, never from credential files.
    #[serde(default)]
    pub email: Option<String>,
    /// e.g. `"Max"`; `None` = unknown.
    #[serde(default)]
    pub plan: Option<String>,
    pub method: AccountMethod,
    #[serde(default)]
    pub auth: AccountAuth,
    /// Exactly one `true` per CLI.
    pub is_default: bool,
    #[serde(default)]
    pub limited: Option<AccountLimited>,
    /// ISO8601; `None` for the System row.
    #[serde(default)]
    pub created_at: Option<String>,
    /// Display path of the account folder, home collapsed to `~`; `None` for
    /// the System row.
    #[serde(default)]
    pub dir: Option<String>,
    /// `false` for the System row; `true` ⇒ Remove deletes the folder.
    #[serde(default)]
    pub created_by_us: bool,
    /// `true` while "Waiting for sign-in"; never selectable.
    #[serde(default)]
    pub pending: bool,
    /// Copyable sign-in steps; present iff the account is pending or signed out
    /// (System login included) and its method is sign-in.
    #[serde(default)]
    pub sign_in: Option<SignInSteps>,
}

/// The sign-in steps the UI prints for a folder account, built by the daemon
/// from the plugin (no harness logic in the UI).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInSteps {
    /// Copyable shell line, e.g. `CLAUDE_CONFIG_DIR=~/.claude-work claude auth login`;
    /// `None` = no login command.
    pub command: Option<String>,
    /// Plugin sentence replacing step 2's label; `None` = default label.
    pub hint: Option<String>,
}

/// Internal (not on the wire) description of how a harness keeps its login in
/// a folder. Feeds `GET /api/supported-clis` and the folder validation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountLinkMeta {
    /// Example folder shown in the UI, e.g. `~/.claude-work`.
    pub example_path: String,
    /// Label of the folder field, e.g. `Claude config folder`.
    pub field_label: String,
    /// Helper text under the field; `None` = none.
    pub field_note: Option<String>,
    /// The harness's own folder (under home); `None` = not applicable.
    pub system_dir: Option<PathBuf>,
    /// Whether the identity command can confirm sign-in (set by the daemon).
    pub verifies_identity: bool,
    /// The harness's own first-run behaviour in a new folder, shown by the UI; `None` = none.
    pub first_run_note: Option<String>,
}

/// Display form of `path` for the UI: `~` for home itself, `~/…` under home,
/// otherwise unchanged. Component-wise, so `/home/ux` is not under `/home/u`.
#[must_use]
pub fn collapse_home(path: &Path, home: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".to_string(),
        Ok(rest) => format!("~/{}", rest.to_string_lossy()),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

/// The persisted account row inside `accounts.json`. Never carries a key: the
/// key lives in a 0600 file inside the account folder (R6).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRecord {
    /// `"acc_"` + 8 lowercase hex; unique.
    pub id: String,
    /// Folder is `accounts/<cli>/<id>`.
    pub cli: String,
    /// The account folder as the user chose or we created it (`None` for
    /// records written before folder accounts).
    #[serde(default)]
    pub dir: Option<String>,
    /// `true` when vibe-station created the folder (Remove deletes it).
    #[serde(default)]
    pub created_by_us: bool,
    /// Trimmed, 1..=40 chars, unique per CLI case-insensitively.
    #[serde(default)]
    pub label: Option<String>,
    /// `sign_in` or `api_key` — never `system` (the System login has no record).
    pub method: AccountMethod,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub plan: Option<String>,
    #[serde(default)]
    pub auth: AccountAuth,
    /// `true` during sign-in; never listed; swept on boot.
    #[serde(default)]
    pub pending: bool,
    /// ISO8601.
    pub created_at: String,
    /// Unknown fields written by a newer build are kept on save.
    #[serde(default, flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// `POST /api/accounts/sign-in` — start a sign-in.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSignInBody {
    pub cli: String,
    pub worktree_id: String,
    #[serde(default)]
    pub label: Option<String>,
}

/// `202` response of `POST /api/accounts/sign-in`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSignInResponse {
    pub attempt_id: String,
    pub account_id: String,
    /// The Terminal session running the vendor login.
    pub session_id: String,
}

/// `POST /api/accounts/sign-in/:attemptId/finish` — the name chosen in the
/// dialog; omitted ⇒ email, else id.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishSignInBody {
    #[serde(default)]
    pub label: Option<String>,
}

/// `PATCH /api/accounts/:cli/:id` — rename (`null` clears the label).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameAccountBody {
    #[serde(default)]
    pub label: Option<String>,
}

/// `PUT /api/accounts/:cli/default` — `"system"` is allowed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDefaultBody {
    pub account_id: String,
}

/// One running session in `GET /api/accounts/:cli/:id/usage`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageSession {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
}

/// `GET /api/accounts/:cli/:id/usage` response.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsage {
    pub running: Vec<AccountUsageSession>,
    pub past_count: i64,
}

/// `DELETE /api/accounts/:cli/:id` response.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveAccountResponse {
    pub ok: bool,
    pub stopped_session_ids: Vec<String>,
    /// `true` only when the account folder was deleted (`created_by_us`).
    #[serde(default)]
    pub folder_deleted: bool,
}
