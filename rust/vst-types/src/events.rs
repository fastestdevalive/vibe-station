//! `events::{ServerEvent, Broadcaster}` — the cycle breaker.
//!
//! The daemon's dependency graph was corrected to avoid a `vst-lifecycle` ↔
//! `vst-ws` cycle: every crate that needs to **emit** a broadcast
//! (`vst-lifecycle`, `vst-agents`, `vst-git`) takes a `Broadcaster` as a
//! constructor argument instead of depending on `vst-ws`. Only `vst-ws` owns
//! the **receiver** side and fans `ServerEvent`s out to WS connections (as
//! `ServerMessage`, via `From`).
//!
//! See `.vibekit/feature-plans/pending/daemon-rust-port/arch-daemon-rust-port.md`
//! Entities & Modules dependency-graph correction note.

use serde::{Deserialize, Serialize};

use crate::domain::{LifecycleState, PrStatus};
use crate::rest::settings::MarkdownStyle;

/// A broadcastable daemon event. This is the *internal* event the daemon
/// fans out; `vst-ws` maps it to `crate::ws::ServerMessage` for the wire.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ServerEvent {
    /// A session was created.
    #[serde(rename = "session:created", rename_all = "camelCase")]
    SessionCreated {
        session_id: String,
        worktree_id: Option<String>,
        project_id: Option<String>,
        session_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        mode: Option<String>,
        /// The full serialized session, mirroring TS's `snapshot:
        /// serializeSession(...)` on every `session:created` broadcast.
        /// Every frontend listener (`TabsStrip.tsx`, `useServerSync.ts`)
        /// gates on `if (!ev.snapshot) return`, so a `None` here makes the
        /// event a silent no-op client-side — this was the root cause of
        /// "draft tabs created in an already-open worktree don't appear
        /// until refresh" (bug #3, live-reproduced against :7141: the
        /// draft POST succeeded but zero WS frames reached the page).
        #[serde(skip_serializing_if = "Option::is_none")]
        snapshot: Option<crate::ws::SessionCreatedSnapshot>,
        /// Present (as JSON null) even when unset, matching
        /// `ServerMessage::SessionCreated`'s field of the same name.
        parent_session_id: Option<String>,
    },
    /// A session's lifecycle state changed.
    #[serde(rename = "session:state", rename_all = "camelCase")]
    SessionState {
        session_id: String,
        state: LifecycleState,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    /// A session's metadata changed (non-lifecycle).
    #[serde(rename = "session:updated", rename_all = "camelCase")]
    SessionUpdated {
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pinned_at: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        channel: Option<crate::domain::Channel>,
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
        pr: Option<Box<PrStatus>>,
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
        draft_config: Option<Box<serde_json::Value>>,
    },
    /// A session was deleted.
    #[serde(rename = "session:deleted", rename_all = "camelCase")]
    SessionDeleted { session_id: String },
    /// A project was created.
    #[serde(rename = "project:created")]
    ProjectCreated {
        project: serde_json::Map<String, serde_json::Value>,
    },
    /// A project was deleted.
    #[serde(rename = "project:deleted", rename_all = "camelCase")]
    ProjectDeleted { project_id: String },
    /// A project was updated.
    #[serde(rename = "project:updated")]
    ProjectUpdated {
        project: serde_json::Map<String, serde_json::Value>,
    },
    /// A worktree was created.
    #[serde(rename = "worktree:created")]
    WorktreeCreated {
        worktree: serde_json::Map<String, serde_json::Value>,
    },
    /// A worktree was deleted.
    #[serde(rename = "worktree:deleted", rename_all = "camelCase")]
    WorktreeDeleted { worktree_id: String },
    /// A worktree was updated.
    #[serde(rename = "worktree:updated")]
    WorktreeUpdated {
        worktree: serde_json::Map<String, serde_json::Value>,
    },
    /// An ordered list was updated.
    #[serde(rename = "orderedList:updated", rename_all = "camelCase")]
    OrderedListUpdated {
        scope_key: String,
        item_ids: Vec<String>,
        updated_at: String,
    },
    /// A mode was created.
    #[serde(rename = "mode:created")]
    ModeCreated {
        mode: serde_json::Map<String, serde_json::Value>,
    },
    /// A mode was updated.
    #[serde(rename = "mode:updated")]
    ModeUpdated {
        mode: serde_json::Map<String, serde_json::Value>,
    },
    /// A mode was deleted.
    #[serde(rename = "mode:deleted", rename_all = "camelCase")]
    ModeDeleted { mode_id: String },
    /// An agent-initiated file open (D4).
    #[serde(rename = "file:open", rename_all = "camelCase")]
    FileOpen { worktree_id: String, path: String },
    /// Navigate to a project (vst open).
    #[serde(rename = "navigate", rename_all = "camelCase")]
    Navigate { project_id: String },
    /// The user's theme / markdown style changed.
    ///
    /// Narrow payload only — deliberately NOT the full `Settings` struct,
    /// which carries `cli_token`/`tauri_token`/`pid`/`port` that must never
    /// reach every connected (possibly remote, token-scoped) client.
    #[serde(rename = "settings:updated", rename_all = "camelCase")]
    SettingsThemeUpdated {
        #[serde(skip_serializing_if = "Option::is_none")]
        theme_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        markdown_style: Option<MarkdownStyle>,
    },
}

/// Sender-side handle for broadcasting `ServerEvent`s.
///
/// The canonical handle convention for `vst-types::events`: a
/// `tokio::sync::broadcast::Sender<ServerEvent>` wrapped in a newtype,
/// `#[derive(Clone)]`. Constructed by taking dependencies as handles — never
/// reached for via a global `static`/`OnceLock`.
///
/// Only `vst-ws` owns the receiver side (a `tokio::sync::broadcast::Receiver`)
/// and fans events out to WS connections.
#[derive(Clone, Debug)]
pub struct Broadcaster(pub tokio::sync::broadcast::Sender<ServerEvent>);

impl Broadcaster {
    /// Create a broadcaster with the given channel capacity.
    pub fn new(capacity: usize) -> Self {
        let (tx, _rx) = tokio::sync::broadcast::channel(capacity);
        Self(tx)
    }

    /// Broadcast an event to all receivers (best-effort).
    pub fn send(&self, event: ServerEvent) {
        let _ = self.0.send(event);
    }

    /// Subscribe to the broadcast stream.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<ServerEvent> {
        self.0.subscribe()
    }

    /// The number of live receivers.
    pub fn receiver_count(&self) -> usize {
        self.0.receiver_count()
    }
}

impl From<Broadcaster> for tokio::sync::broadcast::Sender<ServerEvent> {
    fn from(b: Broadcaster) -> Self {
        b.0
    }
}

impl AsRef<tokio::sync::broadcast::Sender<ServerEvent>> for Broadcaster {
    fn as_ref(&self) -> &tokio::sync::broadcast::Sender<ServerEvent> {
        &self.0
    }
}
