//! Domain types — mirrors `daemon/src/types.ts`.
//! Wire shape is byte-identical to the TS definitions: every struct uses
//! `#[serde(rename_all = "camelCase")]`, every id newtype is
//! `#[serde(transparent)]`, and optional fields use `skip_serializing_if`.

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

/// Opaque, wire-facing id newtypes. All serialize as the bare string.
macro_rules! id_newtype {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl From<String> for $name {
            fn from(s: String) -> Self {
                Self(s)
            }
        }
        impl From<&str> for $name {
            fn from(s: &str) -> Self {
                Self(s.to_string())
            }
        }
        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }
        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

/// A CLI harness identifier (`agent-plugins/registry.ts` `CliId`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CliId {
    Claude,
    Cursor,
    Opencode,
    Agy,
}

id_newtype!(
    /// A session's opaque id.
    SessionId
);
id_newtype!(
    /// A worktree's opaque id.
    WorktreeId
);
id_newtype!(
    /// A project's opaque id.
    ProjectId
);
id_newtype!(
    /// A mode's opaque id.
    ModeId
);
id_newtype!(
    /// A queued chat turn's id.
    TurnId
);
id_newtype!(
    /// A WS connection's opaque id.
    ConnectionId
);

/// Agent-activity lifecycle axis. Mirrors `LifecycleState` in types.ts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleState {
    NotStarted,
    Working,
    Idle,
    WaitingForHuman,
    Done,
    Exited,
    Drafting,
}

/// A session's lifecycle sub-object.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLifecycle {
    pub state: LifecycleState,
    pub reason: Option<String>,
    /// ISO8601.
    pub last_transition_at: String,
}

/// VCS-outcome axis for a session's branch — orthogonal to `LifecycleState`.
/// Mirrors `PrStatus` in types.ts.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrStatus {
    pub state: PrState,
    /// Present iff a PR exists (`state != "none"`).
    pub number: Option<i64>,
    /// Present iff a PR exists.
    pub url: Option<String>,
    /// ISO8601 — when this status was last checked.
    pub checked_at: String,
    /// Set on `no_credentials`/`error` results.
    pub error: Option<String>,
    /// The branch `prPoller` queried GitHub for (D20).
    pub pr_branch: Option<String>,
}

/// The `state` discriminator of `PrStatus`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrState {
    None,
    Draft,
    Open,
    Merged,
    Closed,
}

/// `agent` | `terminal`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionType {
    Agent,
    Terminal,
}

/// How a session's `name` was set.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionNameSource {
    Auto,
    User,
}

/// Execution channel for a session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    Tmux,
    Pty,
    Json,
}

/// Provider (CLI harness) that produced a normalized event.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NormalizedEventProvider {
    Claude,
    Cursor,
    Opencode,
    Agy,
}

/// Provider-agnostic chat event kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NormalizedEventKind {
    SessionInit,
    User,
    Thinking,
    Text,
    ToolUse,
    ToolResult,
    Usage,
    Result,
    Error,
    Status,
    ModeUpdate,
    CommandsUpdate,
    MessageGenerated,
}

/// Token / cost usage numbers, normalized across harnesses.
#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageInfo {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_create_tokens: i64,
    pub total_tokens: i64,
    /// When the harness reports the model's context window.
    pub context_window: Option<i64>,
    /// When the harness reports per-turn/cumulative cost.
    pub cost_usd: Option<f64>,
    pub model: String,
}

/// A file attached to a user message.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    /// uploadId
    pub id: String,
    /// sanitized filename
    pub name: String,
    /// absolute path under sessionDataDir (NOT the checkout)
    pub path: String,
    pub size: i64,
    pub mime: String,
}

/// Normalized non-text content block (acp-normalize-superset, Gap 1).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedContentBlock {
    pub r#type: ContentBlockType,
    /// `type:"text"` only.
    pub text: Option<String>,
    /// `type:"image"|"audio"|"resource_link"`.
    pub mime_type: Option<String>,
    /// base64, `type:"image"|"audio"` only.
    pub data: Option<String>,
    /// `type:"resource_link"`, or `type:"resource"`'s nested `resource.uri`.
    pub uri: Option<String>,
    /// `type:"resource_link"` only.
    pub name: Option<String>,
}

/// Discriminator for `NormalizedContentBlock`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentBlockType {
    Text,
    Image,
    Audio,
    Resource,
    ResourceLink,
}

/// A structured file-edit diff from a `ToolCallContent` entry (Gap 2).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDiff {
    /// absolute file path
    pub path: String,
    /// absent ⇒ new file
    pub old_text: Option<String>,
    pub new_text: String,
}

/// ACP `ToolKind` union, verbatim (Gap 4).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcpToolKind {
    Read,
    Edit,
    Delete,
    Move,
    Search,
    Execute,
    Think,
    Fetch,
    SwitchMode,
    Other,
}

/// ACP `ToolCallStatus` (Gap 5).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

/// A slash command / skill catalog entry.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    pub name: String,
    pub description: String,
    pub argument_hint: Option<String>,
}

/// `tool_call`/`tool_call_update.locations` (Gap 3).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolLocation {
    pub path: String,
    pub line: Option<i64>,
}

/// One normalized chat event — the single shape the UI renders and the
/// transcript persists. Mirrors `NormalizedEvent` in types.ts.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedEvent {
    pub id: String,
    pub session_id: String,
    /// ISO8601, stamped by the daemon.
    pub ts: String,
    pub provider: NormalizedEventProvider,
    pub kind: NormalizedEventKind,
    pub role: Option<Role>,
    /// user | text | thinking | error
    pub text: Option<String>,
    /// tool_use
    pub tool_name: Option<String>,
    /// tool_use | tool_result
    pub tool_id: Option<String>,
    /// tool_use
    pub tool_input: Option<serde_json::Value>,
    pub tool_result: Option<ToolResult>,
    /// usage | result
    pub usage: Option<UsageInfo>,
    pub model: Option<String>,
    /// set on user + every event of that turn
    pub turn_id: Option<String>,
    /// Durable, per-session monotonic storage cursor.
    pub log_seq: Option<i64>,
    /// on user events (echoed for replay)
    pub attachments: Option<Vec<Attachment>>,
    /// Marks a superseding `user` event (queue-edit).
    pub edited: Option<bool>,
    /// Marks a superseding `user` event (queue-cancel).
    pub cancelled: Option<bool>,
    /// Marks a row truncated by an edit-a-sent-message fork.
    pub superseded: Option<bool>,
    /// Harness chat/session id (Decision 10).
    pub agent_chat_id: Option<String>,
    /// Non-text content blocks (Gap 1).
    pub blocks: Option<Vec<NormalizedContentBlock>>,
    /// Structured file-edit diffs (Gap 2).
    pub tool_diffs: Option<Vec<ToolDiff>>,
    /// tool call locations (Gap 3).
    pub tool_locations: Option<Vec<ToolLocation>>,
    /// tool call kind, structural (Gap 4).
    pub tool_kind: Option<AcpToolKind>,
    /// ACP ToolCallStatus (Gap 5).
    pub tool_status: Option<ToolStatus>,
    /// mode_update only.
    pub mode_id: Option<String>,
    /// commands_update only.
    pub commands: Option<Vec<Command>>,
    /// message_generated only.
    pub subagent_id: Option<String>,
    /// message_generated only.
    pub subagent_name: Option<String>,
    /// message_generated only.
    pub subagent_state: Option<LifecycleState>,
    /// True for a silent notice-turn user event.
    pub silent: Option<bool>,
}

impl Default for NormalizedEvent {
    /// Convenience all-`None` constructor; the provider/kind are overwritten
    /// by callers (used by `vst-agents`' parser event builders). Purely
    /// additive — does not change the wire shape.
    fn default() -> Self {
        NormalizedEvent {
            id: String::new(),
            session_id: String::new(),
            ts: String::new(),
            provider: NormalizedEventProvider::Claude,
            kind: NormalizedEventKind::User,
            role: None,
            text: None,
            tool_name: None,
            tool_id: None,
            tool_input: None,
            tool_result: None,
            usage: None,
            model: None,
            turn_id: None,
            log_seq: None,
            attachments: None,
            edited: None,
            cancelled: None,
            superseded: None,
            agent_chat_id: None,
            blocks: None,
            tool_diffs: None,
            tool_locations: None,
            tool_kind: None,
            tool_status: None,
            mode_id: None,
            commands: None,
            subagent_id: None,
            subagent_name: None,
            subagent_state: None,
            silent: None,
        }
    }
}

/// `user` | `assistant`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
}

/// `tool_result` payload.
#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub content: Option<String>,
    pub is_error: Option<bool>,
}

/// Derived turn state driving the composer status indicator.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnState {
    Idle,
    Queued,
    Thinking,
    Responding,
    Tool,
    Error,
}

/// Cross-harness session meta feeding the composer status bar.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub session_id: String,
    pub channel: Channel,
    pub mode_id: Option<String>,
    pub mode_name: Option<String>,
    pub cli: String,
    pub model: Option<String>,
    pub turn_state: TurnState,
    /// pending turns behind the active one
    pub queue_depth: i64,
    /// Runnable queued turnIds in FIFO order.
    pub queued_turn_ids: Vec<String>,
    /// turnIds withdrawn into the editing hold.
    pub editing_turn_ids: Vec<String>,
    pub usage: Option<UsageInfo>,
    /// Absolute working directory for the session.
    pub cwd: Option<String>,
    /// True when the connection supports mid-turn steering.
    pub can_steer: Option<bool>,
    /// Latest commands_update catalog (full-replace).
    pub commands: Option<Vec<Command>>,
    /// Active notice slot (pending or running).
    pub notice_slot: Option<NoticeSlot>,
}

/// The `noticeSlot` sub-object of `SessionMeta`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoticeSlot {
    pub children: std::collections::BTreeMap<String, String>,
    pub running: bool,
}

/// Client-authored configuration for a `"drafting"` session.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftConfig {
    pub entry_point: DraftEntryPoint,
    pub mode_id: Option<String>,
    pub channel: Option<Channel>,
    // worktree / global-with-worktree
    pub worktree_choice: Option<WorktreeChoice>,
    pub existing_worktree_id: Option<String>,
    pub branch: Option<String>,
    pub base_branch: Option<String>,
    pub use_tmux: Option<bool>,
    // global entry point
    pub use_worktree: Option<bool>,
}

/// `DraftConfig.entryPoint`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DraftEntryPoint {
    Worktree,
    Direct,
    Tab,
    Global,
}

/// `DraftConfig.worktreeChoice`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeChoice {
    New,
    Existing,
}

/// A stored session record. Mirrors `SessionRecord` in types.ts.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: String,
    /// Worktree this session belongs to; absent for a direct session.
    pub worktree_id: Option<String>,
    /// Owning project — always present.
    pub project_id: String,
    /// True for the single main agent session of a worktree.
    pub is_main: bool,
    /// Fractional display-order rank within its scope.
    #[serde(with = "crate::serde_ext::compact_f64")]
    pub sort_order: f64,
    pub r#type: SessionType,
    pub mode_id: Option<String>,
    /// User-facing display name.
    pub name: Option<String>,
    /// How `name` was set.
    pub name_source: Option<SessionNameSource>,
    pub tmux_name: String,
    pub use_tmux: bool,
    /// Execution channel.
    pub channel: Option<Channel>,
    pub lifecycle: SessionLifecycle,
    pub transcript_ref: Option<TranscriptRef>,
    /// Identity #1 of two — the NATIVE chat id.
    pub agent_chat_id: Option<String>,
    /// Identity #2 of two — the ACP session id (Option B only).
    pub acp_session_id: Option<String>,
    /// Per-session model override (JSON channel).
    pub model_override: Option<String>,
    /// ISO8601.
    pub pinned_at: Option<String>,
    /// The user's original create-dialog task prompt.
    pub initial_prompt: Option<String>,
    /// Raw draft prompt while in `"drafting"` state.
    pub draft_prompt: Option<String>,
    /// JSON-encoded `DraftConfig` while in `"drafting"` state.
    pub draft_config: Option<DraftConfig>,
    /// ISO8601 — set when retired by reset.
    pub archived_at: Option<String>,
    /// Handoff summary for a retired session.
    pub handoff_summary: Option<String>,
    /// SessionId this session was spawned from.
    pub parent_session_id: Option<String>,
    /// Replacement session's id after a reset.
    pub superseded_by: Option<String>,
    /// VCS status for this session's branch, written only by `prPoller`.
    pub pr: Option<PrStatus>,
}

/// Transcript reference.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptRef {
    pub kind: TranscriptKind,
    pub path: Option<String>,
}

/// `TranscriptRef.kind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TranscriptKind {
    ClaudeJsonl,
    OpencodeSession,
    VstJson,
    None,
}

/// A stored worktree record. Mirrors `WorktreeRecord` in types.ts.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRecord {
    pub id: String,
    /// Cosmetic display name.
    pub name: Option<String>,
    pub branch: String,
    /// True when `branch` was auto-generated as a `wip/<wtId>` placeholder.
    pub branch_is_placeholder: Option<bool>,
    pub base_branch: String,
    pub base_sha: String,
    /// ISO8601.
    pub created_at: String,
    /// ISO8601.
    pub pinned_at: Option<String>,
    /// ISO8601.
    pub hidden_at: Option<String>,
    /// Fractional display-order rank among a project's worktrees.
    #[serde(with = "crate::serde_ext::compact_f64")]
    pub sort_order: f64,
    /// Monotonic counter for default terminal names.
    pub terminal_seq: Option<i64>,
    /// Monotonic high-water counter for agent slots.
    pub agent_seq: Option<i64>,
    pub sessions: Vec<SessionRecord>,
}

/// Identifies which client minted a token.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenScope {
    Cli,
    Tauri,
    Browser,
    Mobile,
}

/// Payload embedded in every vst token.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenPayload {
    pub iat: i64,
    pub scope: TokenScope,
    /// browser only — unix ms at which the token expires
    pub exp: Option<i64>,
    /// browser only — authState.browserEpoch at mint time
    pub epoch: Option<i64>,
}

/// Result of verifying a token.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum VerifyResult {
    Ok { payload: TokenPayload },
    Err { reason: VerifyErrorReason },
}

/// `VerifyResult` error reason.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerifyErrorReason {
    InvalidSignature,
    Expired,
    EpochMismatch,
    Malformed,
    Revoked,
}

/// A stored project record. Mirrors `ProjectRecord` in types.ts.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub id: String,
    pub absolute_path: String,
    pub prefix: String,
    /// Whether this project is a git repository.
    pub is_git: bool,
    /// Default branch for git projects.
    pub default_branch: Option<String>,
    /// ISO8601.
    pub created_at: String,
    /// When true, hidden from sidebar/dashboard.
    pub hidden: Option<bool>,
    /// Direct (no-worktree) sessions.
    pub direct_sessions: Vec<SessionRecord>,
    /// Monotonic counter for direct session slots.
    pub direct_session_seq: Option<i64>,
    pub worktrees: Vec<WorktreeRecord>,
    /// Monotonic high-water mark for worktree numbers.
    pub next_worktree_num: Option<i64>,
}
