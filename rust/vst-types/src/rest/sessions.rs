//! `routes/sessions.ts` — sessions CRUD, chat, transcript, meta, output.

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::domain::{Attachment, Channel, DraftConfig, NormalizedEvent, SessionType};

use super::shared::{GlobalDraft, Session};

/// `POST /sessions` — draft mode body.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDraftSessionBody {
    /// Advisory target.
    pub target: Option<DraftTarget>,
    pub project_id: Option<String>,
    pub worktree_id: Option<String>,
    pub r#type: SessionType,
    pub state: DraftingState,
    pub draft_prompt: Option<String>,
    pub draft_config: Option<serde_json::Value>,
}

/// `CreateDraftSessionBody.target`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DraftTarget {
    Worktree,
    Direct,
    Global,
}

/// `CreateDraftSessionBody.state` — always `"drafting"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DraftingState {
    Drafting,
}

/// `POST /sessions` — normal mode, worktree arm.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSessionBody {
    pub target: Option<CreateTarget>,
    pub worktree_id: String,
    pub r#type: SessionType,
    /// `.nullish()` — accepts null or undefined.
    pub mode_id: Option<String>,
    pub prompt: Option<String>,
    pub use_tmux: Option<bool>,
    pub channel: Option<Channel>,
    pub name: Option<String>,
    pub source_agent_id: Option<String>,
    pub skip_auto_turn: Option<bool>,
}

/// `POST /sessions` — normal mode, direct arm.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectSessionBody {
    pub target: Option<CreateTarget>,
    pub project_id: String,
    pub r#type: SessionType,
    pub mode_id: Option<String>,
    pub prompt: Option<String>,
    pub use_tmux: Option<bool>,
    pub channel: Option<Channel>,
    pub name: Option<String>,
    pub source_agent_id: Option<String>,
    pub skip_auto_turn: Option<bool>,
}

/// `CreateSessionBody` — either a worktree or a direct session body.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionBody {
    pub target: Option<CreateTarget>,
    pub worktree_id: Option<String>,
    pub project_id: Option<String>,
    pub r#type: SessionType,
    pub mode_id: Option<String>,
    pub prompt: Option<String>,
    pub use_tmux: Option<bool>,
    pub channel: Option<Channel>,
    pub name: Option<String>,
    pub source_agent_id: Option<String>,
    pub skip_auto_turn: Option<bool>,
}

/// `CreateSessionBody.target`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CreateTarget {
    Worktree,
    Direct,
}

/// `GET /worktrees/:worktreeId/next-terminal-name` success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NextTerminalName {
    pub name: String,
}

/// `GET /sessions/:id/output` success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOutput {
    pub id: String,
    pub output: String,
}

/// `PATCH /sessions/:id/draft` request body.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchDraftBody {
    pub draft_prompt: Option<String>,
    pub draft_config: Option<serde_json::Value>,
}

/// `POST /sessions/:id/start` request body.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartDraftBody {
    pub draft_prompt: String,
    pub draft_config: DraftConfig,
    pub skip_auto_turn: Option<bool>,
}

/// `POST /sessions/:id/start` success.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartDraftResult {
    pub ok: bool,
    /// Present when a new worktree was created.
    pub worktree_id: Option<String>,
}

/// `PATCH /sessions/:id/pin` request body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinBody {
    pub pinned: bool,
}

/// `PATCH /sessions/:id/pin` success.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinResult {
    pub ok: bool,
    pub pinned_at: Option<String>,
}

/// `PATCH /sessions/:id/rename` request body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameSessionBody {
    pub name: String,
}

/// `PATCH /sessions/:id/rename` success (empty name → null).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameSessionResult {
    pub ok: bool,
    pub name: Option<String>,
}

/// `PATCH /sessions/:id/reorder` request body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderSessionBody {
    #[serde(with = "crate::serde_ext::compact_f64")]
    pub sort_order: f64,
}

/// `PATCH /sessions/:id/reorder` success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderSessionResult {
    pub ok: bool,
    #[serde(with = "crate::serde_ext::compact_f64")]
    pub sort_order: f64,
}

/// `POST /sessions/:id/reset` request body.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetBody {
    pub handoff: Option<bool>,
    pub prompt: Option<String>,
    pub handoff_text: Option<String>,
    pub mode_id: Option<String>,
}

/// `POST /sessions/:id/reset` success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetResult {
    pub ok: bool,
    pub archived_session_id: String,
    pub new_session_id: String,
}

/// `POST /sessions/:id/handoff` success.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffResult {
    pub ok: bool,
    pub handoff_summary: Option<String>,
}

/// `POST /sessions/:id/send` request body.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputBody {
    pub data: String,
    pub send_enter: Option<bool>,
    pub attachment_ids: Option<Vec<String>>,
    pub queue: Option<bool>,
}

/// `POST /sessions/:id/chat` request body.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatBody {
    pub message: String,
    pub attachment_ids: Option<Vec<String>>,
    pub queue: Option<bool>,
}

/// `POST /sessions/:id/chat` success (202) — `EnqueueChatResult`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueChatResult {
    pub turn_id: String,
    pub queue_position: i64,
    pub delivery: Option<Delivery>,
}

/// `EnqueueChatResult.delivery`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Delivery {
    Queued,
    Steered,
}

/// `POST /sessions/:id/chat/queue/:turnId/edit` success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditQueuedResult {
    pub turn_id: String,
    pub message: String,
    pub attachments: Vec<Attachment>,
    pub queue_index: i64,
}

/// `POST /sessions/:id/chat/queue/:turnId/resubmit` request body.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResubmitBody {
    pub edited: bool,
    pub message: Option<String>,
    pub attachment_ids: Option<Vec<String>>,
}

/// `POST /sessions/:id/chat/queue/:turnId/resubmit|promote` success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnActionResult {
    pub ok: bool,
    pub turn_id: String,
}

/// `POST /sessions/:id/chat/fork` request body.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkBody {
    pub turn_id: String,
    pub message: String,
    pub attachment_ids: Option<Vec<String>>,
}

/// `PATCH /sessions/:id/chat/model` request body.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchModelBody {
    /// `.nullable()` — required, may be null.
    pub model: Option<String>,
}

/// `PATCH /sessions/:id/chat/model` success.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchModelResult {
    pub ok: bool,
    pub model: Option<String>,
}

/// `PATCH /sessions/:id/channel` request body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchChannelBody {
    pub channel: Channel,
}

/// `PATCH /sessions/:id/channel` success.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchChannelResult {
    pub ok: bool,
    pub channel: Channel,
    pub history_imported: bool,
}

/// `GET /sessions/:id/transcript` with no query (or `limit` only) — tail page.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPage {
    pub events: Vec<NormalizedEvent>,
    pub oldest_seq: Option<i64>,
    pub has_more: bool,
}

/// `GET /sessions/:id/transcript?since=` — delta page.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SincePage {
    pub events: Vec<NormalizedEvent>,
    pub next_seq: Option<i64>,
    pub has_more: bool,
}

/// `GET /sessions/:id/transcript?all=1` — full event list.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllEvents {
    pub events: Vec<NormalizedEvent>,
}

/// A session create/other response — either a full session or a global draft.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SessionOrDraft {
    Session(Session),
    GlobalDraft(GlobalDraft),
}

/// `POST /sessions` / `GET /sessions` element. (A `Session` or `GlobalDraft`.)
pub type SessionListItem = SessionOrDraft;

/// `PATCH /sessions/:id/delink` success — an empty object.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelinkResult {}

/// `POST /sessions/:id/start` with a new worktree — the session the promoted
/// worktree session belongs to.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftSessionPromotionResult {
    pub ok: bool,
}
