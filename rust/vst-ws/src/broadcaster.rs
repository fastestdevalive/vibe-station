//! WS broadcaster — connection registry + `ServerEvent` receiver-side fan-out.
//!
//! Ports `daemon/src/broadcaster.ts` (receiver side). Connections register /
//! unregister themselves on open/close. `broadcast_all` sends to every live
//! connection; `notify_session` sends to subscribers of a session;
//! `broadcast_worktree` sends to connections watching a worktree tree.
//!
//! The `ServerEvent`/`Broadcaster` sender-side types live in
//! `vst_types::events` (part 00). This module owns the **receiver** side:
//! [`spawn_event_fanout`] subscribes to the `Broadcaster`, converts each
//! `ServerEvent` to a `ServerMessage` (via [`From`]), and routes it to the
//! connections that care.

use std::collections::HashSet;
use std::sync::{Arc, RwLock};

use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::ws::ServerMessage;

use crate::connection::WsConnection;

/// The connection registry (broadcaster receiver side).
///
/// (Token-level remote-session tracking — `TokenSession`, `remote:connected`/
/// `remote:disconnected` — is a separate concern wired in `vst-daemon` via
/// auth-state; this crate's broadcaster owns the connection set and the
/// `ServerEvent` → `ServerMessage` fan-out.)
#[derive(Default)]
pub struct WsHub {
    connections: RwLock<HashSet<WsConnection>>,
}

impl WsHub {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a connection for broadcasts.
    pub fn register_connection(&self, conn: &WsConnection) {
        self.connections.write().unwrap().insert(conn.clone());
    }

    /// Unregister a connection from broadcasts.
    pub fn unregister_connection(&self, conn: &WsConnection) {
        self.connections.write().unwrap().remove(conn);
    }

    /// Invoke `f` for every live connection.
    pub fn for_each_connection(&self, f: impl Fn(&WsConnection)) {
        for conn in self.connections.read().unwrap().iter() {
            f(conn);
        }
    }

    /// Broadcast an event to all connected clients.
    pub fn broadcast_all(&self, msg: &ServerMessage) {
        for conn in self.connections.read().unwrap().iter() {
            conn.send(msg);
        }
    }

    /// Broadcast an event to all connections watching a specific worktree.
    pub fn broadcast_worktree(&self, worktree_id: &str, msg: &ServerMessage) {
        let prefix = format!("tree:{worktree_id}:");
        for conn in self.connections.read().unwrap().iter() {
            if conn
                .tree_watch_keys()
                .iter()
                .any(|k| k.starts_with(&prefix))
            {
                conn.send(msg);
            }
        }
    }

    /// Send an event to subscribers of a specific session.
    pub fn notify_session(&self, session_id: &str, msg: &ServerMessage) {
        for conn in self.connections.read().unwrap().iter() {
            if conn.is_subscribed_to(session_id) {
                conn.send(msg);
            }
        }
    }

    /// Force-detach every connection's open stream on `session_id`, each under
    /// its own session lock (mirrors `sessionClose`).
    pub async fn force_close_session_streams(&self, session_id: &str) {
        let conns: Vec<WsConnection> = self.connections.read().unwrap().iter().cloned().collect();
        for conn in conns {
            let sid = session_id.to_string();
            let c = conn.clone();
            let lock_conn = c.clone();
            let sid_arg = sid.clone();
            lock_conn
                .with_session_lock(&sid_arg, move || {
                    let c = c.clone();
                    let sid = sid.clone();
                    async move {
                        let entry = c.open_stream_entry(&sid);
                        if let Some(entry) = entry {
                            let _ = entry.stream.detach(&entry.subscriber_id).await;
                            if let Some(current) = c.open_stream_entry(&sid) {
                                if current.subscriber_id == entry.subscriber_id {
                                    c.unregister_open_stream(&sid);
                                }
                            }
                        }
                    }
                })
                .await;
        }
    }
}

/// Convert a broadcast `ServerEvent` into the wire `ServerMessage` it fans out
/// to connections.
///
/// Not a `From` impl because both `ServerEvent` and `ServerMessage` are foreign
/// types (orphan rule) — a free function avoids the impl conflict.
pub fn server_event_to_message(e: ServerEvent) -> ServerMessage {
    match e {
        ServerEvent::SessionCreated {
            session_id,
            worktree_id,
            project_id,
            session_type,
            mode,
            snapshot,
            parent_session_id,
        } => ServerMessage::SessionCreated {
            session_id,
            worktree_id,
            project_id,
            session_type,
            mode,
            snapshot,
            parent_session_id,
        },
        ServerEvent::SessionState {
            session_id,
            state,
            reason,
        } => ServerMessage::SessionState {
            session_id,
            state,
            reason,
        },
        ServerEvent::SessionUpdated {
            session_id,
            pinned_at,
            channel,
            name,
            archived_at,
            sort_order,
            pr,
            superseded_by,
            is_main,
            parent_session_id,
            worktree_id,
            draft_prompt,
            draft_config,
        } => ServerMessage::SessionUpdated {
            session_id,
            pinned_at,
            channel,
            name,
            archived_at,
            sort_order,
            pr: pr.map(|p| *p),
            superseded_by,
            is_main,
            parent_session_id,
            worktree_id,
            draft_prompt,
            draft_config: draft_config.map(|v| *v),
        },
        ServerEvent::SessionDeleted { session_id } => ServerMessage::SessionDeleted { session_id },
        ServerEvent::ProjectCreated { project } => ServerMessage::ProjectCreated { project },
        ServerEvent::ProjectDeleted { project_id } => ServerMessage::ProjectDeleted { project_id },
        ServerEvent::ProjectUpdated { project } => ServerMessage::ProjectUpdated { project },
        ServerEvent::WorktreeCreated { worktree } => ServerMessage::WorktreeCreated { worktree },
        ServerEvent::WorktreeDeleted { worktree_id } => {
            ServerMessage::WorktreeDeleted { worktree_id }
        }
        ServerEvent::WorktreeUpdated { worktree } => ServerMessage::WorktreeUpdated { worktree },
        ServerEvent::OrderedListUpdated {
            scope_key,
            item_ids,
            updated_at,
        } => ServerMessage::OrderedListUpdated {
            scope_key,
            item_ids,
            updated_at,
        },
        ServerEvent::ModeCreated { mode } => ServerMessage::ModeCreated { mode },
        ServerEvent::ModeUpdated { mode } => ServerMessage::ModeUpdated { mode },
        ServerEvent::ModeDeleted { mode_id } => ServerMessage::ModeDeleted { mode_id },
        ServerEvent::FileOpen { worktree_id, path } => {
            ServerMessage::FileOpen { worktree_id, path }
        }
        ServerEvent::Navigate { project_id } => ServerMessage::Navigate { project_id },
        ServerEvent::SettingsThemeUpdated {
            theme_id,
            markdown_style,
        } => ServerMessage::SettingsThemeUpdated {
            theme_id,
            markdown_style,
        },
    }
}

/// Spawn the receiver-side fan-out: subscribe to `broadcaster`, convert each
/// `ServerEvent` to a `ServerMessage`, and broadcast it to every connected
/// client.
///
/// This USED to special-case `SessionCreated`/`SessionState`/
/// `SessionUpdated`/`SessionDeleted` and route them only to connections that
/// had previously sent an explicit `subscribe` for that exact session id
/// (via `hub.notify_session`). That's wrong: `daemon/src/broadcaster.ts`
/// sends every single one of these through unconditional `broadcastAll`
/// (verified — grep shows zero TS call sites using `notifySession`, which
/// exists in `broadcaster.ts` but is never invoked anywhere in the
/// codebase). A **brand-new** session id can never be in any connection's
/// subscription set, so under the old routing a `session:created` for a
/// freshly-created draft reached ZERO clients — live-reproduced against the
/// :7141 sandbox (WS tap showed zero frames for a draft-tab creation whose
/// REST call itself returned 200). This was bug #3: "draft tabs created in
/// an already-open worktree don't appear until refresh". Matching TS exactly
/// by always broadcasting fixes it, and also fixes the same silent-drop for
/// `session:updated` (draft prompt/name edits) and `session:deleted` against
/// any connection that hadn't subscribed.
pub fn spawn_event_fanout(
    hub: Arc<WsHub>,
    broadcaster: Broadcaster,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut rx = broadcaster.subscribe();
        loop {
            let event = match rx.recv().await {
                Ok(e) => e,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            };
            let msg: ServerMessage = server_event_to_message(event);
            hub.broadcast_all(&msg);
        }
    })
}
