//! `routes/modes.ts` — supported-clis, cli-models, modes CRUD.

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use super::doctor::DoctorHintDto;
use crate::domain::{Channel, CliId};

/// Whether a CLI can keep the model's own context across an account switch
/// (R3: the UI learns this from data, never from a harness-name check).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountSwitchSupport {
    /// The CLI's native session store crosses accounts (native hand-over).
    Native,
    /// Only a transcript hand-over exists; the model starts empty.
    Transcript,
    /// Accounts are not supported for this CLI (`supports_accounts` false).
    #[default]
    None,
}

/// How a CLI keeps its login in a user-chosen folder (`SupportedCli.accountLink`).
/// Present only when `supportsAccounts` is true; all copy comes from the plugin.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountLink {
    /// Label of the folder field, e.g. `Claude config folder`.
    pub field_label: String,
    /// Helper text under the field; `None` = none (sent as `null`).
    pub field_note: Option<String>,
    /// Example folder, e.g. `~/.claude-work`.
    pub example_dir: String,
    /// Display path of the harness's own folder, e.g. `~/.claude` (`null` = none).
    pub system_dir: Option<String>,
    /// Whether the account can offer an API key instead of a sign-in.
    pub supports_api_key: bool,
    /// Whether the identity command can confirm sign-in (else "I've signed in").
    pub verifies_identity: bool,
    /// The harness's own first-run behaviour in a new folder; absent = none.
    #[serde(default)]
    pub first_run_note: Option<String>,
}

/// One element of `GET /supported-clis`.
// The four booleans are the wire contract (mirrored in `web-ui/src/api/types.ts`);
// collapsing them would change the shape old clients already read.
#[expect(
    clippy::struct_excessive_bools,
    reason = "wire shape mirrors the TS SupportedCli contract"
)]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportedCli {
    pub id: CliId,
    pub default_model: String,
    pub supports_json: bool,
    /// Whether named accounts exist for this CLI (`AgentPlugin::supports_accounts`).
    /// Absent from older daemons = false.
    #[serde(default)]
    pub supports_accounts: bool,
    /// How an account switch keeps context; `none` iff `supports_accounts` is
    /// false. Absent from older daemons = `none`.
    #[serde(default)]
    pub account_switch: AccountSwitchSupport,
    /// Why accounts are unavailable, shown in Settings when
    /// `supports_accounts` is false (`accounts_unsupported_reason`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accounts_note: Option<String>,
    /// The CLI's plugin can deliver a scheduled message into a Terminal agent
    /// (`terminal_delivery()` is `Some`). Absent from older daemons = false.
    #[serde(default)]
    pub supports_terminal_delivery: bool,
    /// Review comments can be sent to a Terminal agent of this CLI:
    /// `terminal_delivery()` is `Some` and its paste is multi-line safe.
    /// Absent from older daemons = false.
    #[serde(default)]
    pub supports_terminal_comments: bool,
    pub imports_native_history: bool,
    pub supports_json_to_terminal_resume: bool,
    pub detected: bool,
    pub starter_bundle_names: Vec<String>,
    pub using_fallback_only: bool,
    /// The CLI's effective default channel (override-aware; plan Decision 5/B2).
    pub default_channel: Channel,
    /// True when `default_channel` reflects a user override (not the plugin's
    /// hardwired default) — lets the Settings UI label the plugin-default
    /// option distinctly from an explicit override (round-2 m3).
    pub default_channel_overridden: bool,
    /// Folder-account contract; `None` when `supports_accounts` is false.
    #[serde(default)]
    pub account_link: Option<AccountLink>,
    /// Install guidance from the daemon's hint table; present only when the CLI
    /// is not detected on PATH.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_hint: Option<DoctorHintDto>,
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
    /// Explicit icon key; when present it wins over plugin derivation.
    pub icon: Option<String>,
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
    /// Explicit icon key; when present it wins over plugin derivation.
    pub icon: Option<String>,
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
