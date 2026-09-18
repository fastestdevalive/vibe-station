//! WebSocket protocol — mirrors `daemon/src/ws/protocol.ts`.
//! `ClientMessage` and `ServerMessage` are tagged unions on `type` that
//! reproduce the zod `discriminatedUnion("type", ...)` shapes byte-identically.
//!
//! Note: for internally-tagged enums serde does NOT inherit `rename_all` from
//! the enum level for variant *fields*, so each field-bearing variant carries
//! its own `#[serde(rename_all = "camelCase")]`.

use serde::{Deserialize, Serialize};

use crate::domain::{Channel, LifecycleState, NormalizedEvent, PrStatus, SessionMeta};
use crate::rest::settings::MarkdownStyle;

/// Client-to-server message. Tagged on `type`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ClientMessage {
    #[serde(rename = "subscribe")]
    Subscribe {
        #[serde(rename = "sessionIds")]
        session_ids: Vec<String>,
    },
    #[serde(rename = "unsubscribe")]
    Unsubscribe {
        #[serde(rename = "sessionIds")]
        session_ids: Vec<String>,
    },
    #[serde(rename = "session:open", rename_all = "camelCase")]
    SessionOpen {
        session_id: String,
        cols: i64,
        rows: i64,
    },
    #[serde(rename = "session:input", rename_all = "camelCase")]
    SessionInput { session_id: String, data: String },
    #[serde(rename = "session:resize", rename_all = "camelCase")]
    SessionResize {
        session_id: String,
        cols: i64,
        rows: i64,
    },
    #[serde(rename = "session:close", rename_all = "camelCase")]
    SessionClose { session_id: String },
    #[serde(rename = "file:watch", rename_all = "camelCase")]
    FileWatch { worktree_id: String, path: String },
    #[serde(rename = "file:unwatch", rename_all = "camelCase")]
    FileUnwatch { worktree_id: String, path: String },
    #[serde(rename = "tree:watch", rename_all = "camelCase")]
    TreeWatch {
        worktree_id: String,
        path: Option<String>,
    },
    #[serde(rename = "tree:unwatch", rename_all = "camelCase")]
    TreeUnwatch {
        worktree_id: String,
        path: Option<String>,
    },
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "chat:open", rename_all = "camelCase")]
    ChatOpen {
        session_id: String,
        since_seq: Option<i64>,
    },
    #[serde(rename = "chat:close", rename_all = "camelCase")]
    ChatClose { session_id: String },
    #[serde(rename = "debug:log")]
    DebugLog {
        entries: Vec<serde_json::Map<String, serde_json::Value>>,
    },
}

/// Server-to-client message. Tagged on `type`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ServerMessage {
    #[serde(rename = "session:created", rename_all = "camelCase")]
    SessionCreated {
        session_id: String,
        worktree_id: Option<String>,
        project_id: Option<String>,
        session_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        mode: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        snapshot: Option<SessionCreatedSnapshot>,
        /// Present (as JSON null) even when unset, so the client can tell
        /// "this daemon supports the field" from "old daemon, absent".
        parent_session_id: Option<String>,
    },
    #[serde(rename = "session:state", rename_all = "camelCase")]
    SessionState {
        session_id: String,
        state: LifecycleState,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    #[serde(rename = "session:opened", rename_all = "camelCase")]
    SessionOpened { session_id: String },
    #[serde(rename = "session:output", rename_all = "camelCase")]
    SessionOutput { session_id: String, chunk: String },
    #[serde(rename = "session:exited", rename_all = "camelCase")]
    SessionExited {
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        exit_code: Option<i64>,
    },
    #[serde(rename = "session:resumed", rename_all = "camelCase")]
    SessionResumed {
        session_id: String,
        restored_from_history: bool,
    },
    #[serde(rename = "session:deleted", rename_all = "camelCase")]
    SessionDeleted { session_id: String },
    #[serde(rename = "session:updated", rename_all = "camelCase")]
    SessionUpdated {
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pinned_at: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        channel: Option<Channel>,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        archived_at: Option<String>,
        #[serde(
            skip_serializing_if = "Option::is_none",
            with = "crate::serde_ext::compact_f64_opt"
        )]
        sort_order: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pr: Option<PrStatus>,
        #[serde(skip_serializing_if = "Option::is_none")]
        superseded_by: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        is_main: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_session_id: Option<Option<String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        worktree_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        draft_prompt: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        draft_config: Option<serde_json::Value>,
    },
    #[serde(rename = "session:error", rename_all = "camelCase")]
    SessionError {
        session_id: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<SessionErrorReason>,
    },
    #[serde(rename = "file:open", rename_all = "camelCase")]
    FileOpen { worktree_id: String, path: String },
    #[serde(rename = "file:changed", rename_all = "camelCase")]
    FileChanged { worktree_id: String, path: String },
    #[serde(rename = "file:deleted", rename_all = "camelCase")]
    FileDeleted { worktree_id: String, path: String },
    #[serde(rename = "tree:changed", rename_all = "camelCase")]
    TreeChanged {
        worktree_id: String,
        path: String,
        kind: TreeChangeKind,
        #[serde(skip_serializing_if = "Option::is_none")]
        from: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        to: Option<String>,
    },
    #[serde(rename = "project:created")]
    ProjectCreated {
        project: serde_json::Map<String, serde_json::Value>,
    },
    #[serde(rename = "project:deleted", rename_all = "camelCase")]
    ProjectDeleted { project_id: String },
    #[serde(rename = "project:updated")]
    ProjectUpdated {
        project: serde_json::Map<String, serde_json::Value>,
    },
    #[serde(rename = "worktree:created")]
    WorktreeCreated {
        worktree: serde_json::Map<String, serde_json::Value>,
    },
    #[serde(rename = "worktree:deleted", rename_all = "camelCase")]
    WorktreeDeleted { worktree_id: String },
    #[serde(rename = "worktree:updated")]
    WorktreeUpdated {
        worktree: serde_json::Map<String, serde_json::Value>,
    },
    #[serde(rename = "orderedList:updated", rename_all = "camelCase")]
    OrderedListUpdated {
        scope_key: String,
        item_ids: Vec<String>,
        updated_at: String,
    },
    #[serde(rename = "mode:created")]
    ModeCreated {
        mode: serde_json::Map<String, serde_json::Value>,
    },
    #[serde(rename = "mode:updated")]
    ModeUpdated {
        mode: serde_json::Map<String, serde_json::Value>,
    },
    #[serde(rename = "mode:deleted", rename_all = "camelCase")]
    ModeDeleted { mode_id: String },
    /// The user's theme / markdown style changed. Narrow payload — never the
    /// full `Settings` struct (which carries `cliToken`/`tauriToken`).
    ///
    /// `markdown_style` deliberately has NO `skip_serializing_if`: the client
    /// (`useMarkdownStyle.ts`'s `boot()`) distinguishes "field present" (a
    /// real value, including a `null` reset echo) from "field absent" (a
    /// theme-only change that didn't touch markdown_style) via `"markdownStyle"
    /// in ev`. Skipping serialization on `None` would omit the field on a
    /// reset exactly the same way as an unrelated theme-only change, so a
    /// "Reset to theme" commit's own echo — and any other open tab's live
    /// sync — would silently fail to clear the override. `theme_id` keeps
    /// `skip_serializing_if` since it's always `Some` in practice (the
    /// config always has a themeId after first boot) and has no reset case.
    #[serde(rename = "settings:updated", rename_all = "camelCase")]
    SettingsThemeUpdated {
        #[serde(skip_serializing_if = "Option::is_none")]
        theme_id: Option<String>,
        markdown_style: Option<MarkdownStyle>,
    },
    #[serde(rename = "chat:replay", rename_all = "camelCase")]
    ChatReplay {
        session_id: String,
        events: Vec<NormalizedEvent>,
        #[serde(skip_serializing_if = "Option::is_none")]
        oldest_seq: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        has_more: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        next_seq: Option<i64>,
    },
    #[serde(rename = "session:message", rename_all = "camelCase")]
    SessionMessage {
        session_id: String,
        event: Box<NormalizedEvent>,
    },
    #[serde(rename = "session:meta", rename_all = "camelCase")]
    SessionMetaEvent {
        session_id: String,
        meta: Box<SessionMeta>,
    },
    #[serde(rename = "session:fork", rename_all = "camelCase")]
    SessionFork {
        session_id: String,
        superseded_turn_ids: Vec<String>,
    },
    #[serde(rename = "remote:connected", rename_all = "camelCase")]
    RemoteConnected { session: RemoteSession },
    #[serde(rename = "remote:disconnected", rename_all = "camelCase")]
    RemoteDisconnected { token_id: String, connections: i64 },
    #[serde(rename = "navigate", rename_all = "camelCase")]
    Navigate { project_id: String },
    #[serde(rename = "pong")]
    Pong,
    #[serde(rename = "system:error")]
    SystemError { message: String },
}

/// `session:error` reason classification.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionErrorReason {
    Gone,
    Transient,
}

/// `tree:changed` kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TreeChangeKind {
    Added,
    Deleted,
    Renamed,
}

/// The `session` payload of `remote:connected`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSession {
    pub token_id: String,
    pub scope: String,
    pub connections: i64,
    pub issued_at: i64,
    pub last_seen_at: i64,
    pub expires_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
}

/// The snapshot carried by `session:created`.
///
/// IMPORTANT: despite `daemon/src/ws/protocol.ts`'s `SessionCreatedSnapshot`
/// zod schema declaring only the narrower field set this struct used to
/// mirror, the ACTUAL runtime object TS sends on the wire is
/// `serializeSession(...)`'s full return value — the complete `Session`
/// shape, extra fields and all. That schema is a lax `z.object({...})`
/// (no `.strict()`) used only as an outbound TS type; nothing on the send
/// path ever calls `.parse()` on it to strip anything, and the client's own
/// type for this field is `snapshot?: Session`
/// (`web-ui/src/api/types.ts`) — the FULL type, not the narrower one. So
/// the narrower Rust struct this used to be was a real, load-bearing wire
/// gap, not a faithful port of TS's declared type: any field TS's real
/// object carries but this struct didn't declare could never reach the
/// client at all, because Rust's serde serialization is strict — unlike
/// TS, it cannot silently pass through a field that isn't in the struct.
///
/// Concretely confirmed missing: `sortOrder`. `TabsStrip.tsx`'s
/// `session:created` handler sorts its local tab list by
/// `a.sortOrder ?? 0` — a `session:created` snapshot missing `sortOrder`
/// defaulted to `0`, sorting BEFORE every real (`Date.now()`-based)
/// existing session and landing brand-new tabs at the far LEFT of the tab
/// strip instead of the right, where the "+" button that created them
/// lives. Fixed by widening this struct to carry the same full field set
/// `Session` does (see `From<&Session>`/`From<&GlobalDraft>` below) —
/// don't narrow it again without checking every field the client's
/// `Session` type declares is still covered.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCreatedSnapshot {
    pub id: String,
    pub worktree_id: Option<String>,
    pub project_id: Option<String>,
    pub is_main: bool,
    pub r#type: crate::domain::SessionType,
    pub mode_id: Option<String>,
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_source: Option<crate::domain::SessionNameSource>,
    pub tmux_name: String,
    pub use_tmux: Option<bool>,
    pub channel: Option<Channel>,
    pub state: SnapshotLifecycleState,
    pub lifecycle_state: SnapshotLifecycleState,
    pub created_at: String,
    pub pinned_at: Option<String>,
    pub archived_at: Option<String>,
    /// Present so freshly-created sessions sort correctly wherever a
    /// client orders by `sortOrder` off a `session:created` snapshot
    /// instead of a REST-fetched `Session` — see this struct's doc
    /// comment for the exact bug this fixes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_order: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handoff_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr: Option<PrStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft_config: Option<crate::domain::DraftConfig>,
}

/// `SessionCreatedSnapshot` lifecycle — accepts `needs_review` as input only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotLifecycleState {
    NotStarted,
    Working,
    Idle,
    WaitingForHuman,
    NeedsReview,
    Done,
    Exited,
    Drafting,
}

impl From<LifecycleState> for SnapshotLifecycleState {
    fn from(s: LifecycleState) -> Self {
        match s {
            LifecycleState::NotStarted => SnapshotLifecycleState::NotStarted,
            LifecycleState::Working => SnapshotLifecycleState::Working,
            LifecycleState::Idle => SnapshotLifecycleState::Idle,
            LifecycleState::WaitingForHuman => SnapshotLifecycleState::WaitingForHuman,
            LifecycleState::Done => SnapshotLifecycleState::Done,
            LifecycleState::Exited => SnapshotLifecycleState::Exited,
            LifecycleState::Drafting => SnapshotLifecycleState::Drafting,
        }
    }
}

/// Build the `session:created` wire snapshot from the canonical serialized
/// `Session` (`serialize_session`/`serializeSession`). Every `session:created`
/// emit site should populate `snapshot` from this — a `None` snapshot makes
/// every frontend listener (`TabsStrip.tsx`, `useServerSync.ts`) discard the
/// event outright, since they all gate on `if (!ev.snapshot) return`.
impl From<&crate::rest::shared::Session> for SessionCreatedSnapshot {
    fn from(s: &crate::rest::shared::Session) -> Self {
        SessionCreatedSnapshot {
            id: s.id.clone(),
            worktree_id: s.worktree_id.clone(),
            project_id: Some(s.project_id.clone()),
            is_main: s.is_main,
            r#type: s.r#type,
            mode_id: s.mode_id.clone(),
            name: s.name.clone(),
            name_source: s.name_source,
            tmux_name: s.tmux_name.clone(),
            use_tmux: Some(s.use_tmux),
            channel: Some(s.channel),
            state: s.state.into(),
            lifecycle_state: s.lifecycle_state.into(),
            created_at: s.created_at.clone(),
            pinned_at: s.pinned_at.clone(),
            archived_at: s.archived_at.clone(),
            sort_order: Some(s.sort_order),
            handoff_summary: s.handoff_summary.clone(),
            parent_session_id: s.parent_session_id.clone(),
            superseded_by: s.superseded_by.clone(),
            pr: s.pr.clone(),
            draft_prompt: s.draft_prompt.clone(),
            draft_config: s.draft_config.clone(),
        }
    }
}

/// Same as the `Session` conversion above, for a global (project-less) draft
/// — TS's equivalent emit site casts `serializeGlobalDraft(...)` straight
/// into the `snapshot` field (`snapshot: serialized as never`); `GlobalDraft`
/// shares the same overlapping key set as `Session`; see its doc comment.
impl From<&crate::rest::shared::GlobalDraft> for SessionCreatedSnapshot {
    fn from(s: &crate::rest::shared::GlobalDraft) -> Self {
        SessionCreatedSnapshot {
            id: s.id.clone(),
            worktree_id: s.worktree_id.clone(),
            project_id: s.project_id.clone(),
            is_main: s.is_main,
            r#type: s.r#type,
            mode_id: s.mode_id.clone(),
            name: s.name.clone(),
            name_source: s.name_source,
            tmux_name: s.tmux_name.clone(),
            use_tmux: Some(s.use_tmux),
            channel: Some(s.channel),
            state: s.state.into(),
            lifecycle_state: s.lifecycle_state.into(),
            created_at: s.created_at.clone(),
            pinned_at: s.pinned_at.clone(),
            archived_at: s.archived_at.clone(),
            sort_order: Some(s.sort_order),
            handoff_summary: s.handoff_summary.clone(),
            parent_session_id: None,
            superseded_by: s.superseded_by.clone(),
            pr: s.pr.clone(),
            draft_prompt: s.draft_prompt.clone(),
            draft_config: s.draft_config.clone(),
        }
    }
}
