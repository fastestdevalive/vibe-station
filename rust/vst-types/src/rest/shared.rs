//! Shared REST wire shapes — the canonical serialized objects reused across
//! routes (`Session`, `GlobalDraft`, `Worktree`, `Project`, `Mode`,
//! `TokenSession`) plus the common error envelope.
//!
//! Per the TS handlers, fields that are `null` when absent are serialized as
//! JSON `null` (NOT omitted); fields that are merely optional are omitted.
//! Fields carrying an explicit `*: null` below are the never-omitted ones.

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::domain::{
    Channel, DraftConfig, LifecycleState, PrStatus, SessionNameSource, SessionType,
};

/// The canonical serialized session object (`serializeSession`). Fields that
/// are `null` when the underlying value is absent are serialized as JSON
/// `null`, never omitted.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub worktree_id: Option<String>,
    pub project_id: String,
    pub is_main: bool,
    pub r#type: SessionType,
    pub mode_id: Option<String>,
    pub name: Option<String>,
    pub name_source: Option<SessionNameSource>,
    pub tmux_name: String,
    pub use_tmux: bool,
    pub channel: Channel,
    pub state: LifecycleState,
    pub lifecycle_state: LifecycleState,
    pub created_at: String,
    pub pinned_at: Option<String>,
    pub archived_at: Option<String>,
    #[serde(with = "crate::serde_ext::compact_f64")]
    pub sort_order: f64,
    pub handoff_summary: Option<String>,
    pub parent_session_id: Option<String>,
    pub superseded_by: Option<String>,
    pub pr: Option<PrStatus>,
    pub draft_prompt: Option<String>,
    pub draft_config: Option<DraftConfig>,
}

/// A global (project-less) draft session — same key set as `Session`, with
/// fixed values. `tmuxName` is `"__draft__-<id>"`, `channel` is `"json"`,
/// `state`/`lifecycleState` are `"drafting"`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalDraft {
    pub id: String,
    #[serde(rename = "worktreeId")]
    pub worktree_id: Option<String>,
    pub project_id: Option<String>,
    pub is_main: bool,
    pub r#type: SessionType,
    pub mode_id: Option<String>,
    pub name: Option<String>,
    pub name_source: Option<SessionNameSource>,
    pub tmux_name: String,
    pub use_tmux: bool,
    pub channel: Channel,
    pub state: LifecycleState,
    pub lifecycle_state: LifecycleState,
    pub created_at: String,
    pub pinned_at: Option<String>,
    pub archived_at: Option<String>,
    #[serde(with = "crate::serde_ext::compact_f64")]
    pub sort_order: f64,
    pub handoff_summary: Option<String>,
    pub parent_session_id: Option<String>,
    pub superseded_by: Option<String>,
    pub pr: Option<PrStatus>,
    pub draft_prompt: Option<String>,
    pub draft_config: Option<DraftConfig>,
}

/// The canonical serialized worktree object (`serializeWorktree`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub id: String,
    pub project_id: String,
    pub name: Option<String>,
    pub branch: String,
    pub branch_is_placeholder: bool,
    pub base_branch: String,
    pub base_sha: String,
    pub created_at: String,
    pub pinned_at: Option<String>,
    pub hidden_at: Option<String>,
    #[serde(with = "crate::serde_ext::compact_f64")]
    pub sort_order: f64,
    pub main_session_id: Option<String>,
    #[serde(default)]
    pub lsp_enabled: bool,
}

/// The canonical serialized project object (`serializeProject`).
/// `name` always equals `id`; `defaultBranch` is present only when defined.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub prefix: String,
    pub is_git: bool,
    pub default_branch: Option<String>,
    pub created_at: String,
    pub hidden: bool,
    #[serde(default)]
    pub lsp_enabled: bool,
    /// Present only on POST /projects when project setup failed.
    pub warning: Option<String>,
}

/// A mode as serialized on the wire (`Mode` in modes.ts).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mode {
    pub id: String,
    pub name: String,
    pub cli: crate::domain::CliId,
    pub context: String,
    pub created_at: String,
    pub model: Option<String>,
    /// Icon key (claude|agy|cursor|opencode|deepseek). Absent on legacy rows
    /// until backfilled on the next save.
    pub icon: Option<String>,
}

/// A token-level remote session (`TokenSession` in broadcaster.ts). The
/// element type of `GET /auth/sessions`'s `sessions` array.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenSession {
    pub token_id: String,
    pub scope: String,
    pub issued_at: i64,
    /// Serialized as JSON `null` when absent (never omitted).
    pub expires_at: Option<i64>,
    pub last_seen_at: i64,
    pub connections: i64,
    /// Omitted when absent (not serialized as null).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
}

/// The generic `{ error: string, ... }` envelope used by most non-2xx
/// responses. Extra fields vary per endpoint; use the concrete structs where a
/// fixed extra field exists.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorEnvelope {
    pub error: String,
    /// Validation errors carry a zod-issue array (opaque, variable shape).
    pub details: Option<serde_json::Value>,
    /// POST /projects, POST /worktrees branch conflicts.
    pub conflict_with: Option<String>,
    /// POST /open invalid path detail.
    pub detail: Option<String>,
    /// worktrees DELETE guard.
    pub sessions: Option<Vec<String>>,
    /// 422 file errors.
    pub reason: Option<String>,
}

impl ErrorEnvelope {
    /// A plain `{ error }` envelope.
    pub fn new(error: impl Into<String>) -> Self {
        Self {
            error: error.into(),
            details: None,
            conflict_with: None,
            detail: None,
            sessions: None,
            reason: None,
        }
    }
}
