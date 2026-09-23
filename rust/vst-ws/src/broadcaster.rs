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

/// The WS close code the daemon uses to signal "auth expired / revoked" to the
/// client. The web-ui maps exactly this code (4401) to its login gate
/// (`web-ui/src/api/client.ts`); every other close code is treated as a normal
/// disconnect that triggers reconnect. Only auth-caused closes (revoke,
/// expiry) may ever use it — server restarts, normal client-initiated closes,
/// and network errors must keep whatever code/behaviour they use today.
pub const AUTH_EXPIRED_CLOSE_CODE: u16 = 4401;
/// Human-readable reason sent alongside [`AUTH_EXPIRED_CLOSE_CODE`].
pub const AUTH_EXPIRED_CLOSE_REASON: &str = "Session expired or revoked";

/// Close a connection's socket with the auth-expired close code. Shared by the
/// revoke routes (`revoke_session` / `revoke_browser` in `vst-routes`) and the
/// periodic expiry sweep so both emit the exact code the client maps to its
/// login screen, without duplicating the close logic.
pub fn close_auth_expired(conn: &WsConnection) {
    conn.sink().close(AUTH_EXPIRED_CLOSE_CODE, AUTH_EXPIRED_CLOSE_REASON);
}

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

    /// Close every live connection whose token has passed `token_expires_at`,
    /// using the auth-expired close code (`close_auth_expired`). Sockets without
    /// an expiry (cli / tauri, or no token at all) are left untouched. Returns
    /// how many connections were closed. The periodic sweep in `vst-daemon`
    /// calls this so a socket opened before expiry cannot outlive its token.
    pub fn close_expired_auth(&self, now_ms: i64) -> usize {
        let mut closed = 0;
        for conn in self.connections.read().unwrap().iter() {
            // Skip sockets we've already asked to close (they may still be in
            // the registry until the read loop tears them down) — otherwise the
            // sweep would re-report them every tick.
            if conn.closed().is_some() {
                continue;
            }
            let expired = conn
                .token_expires_at()
                .map_or(false, |exp| exp <= now_ms);
            if expired {
                close_auth_expired(conn);
                closed += 1;
            }
        }
        closed
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
        ServerEvent::Navigate {
            project_id,
            new_window,
        } => ServerMessage::Navigate {
            project_id,
            new_window,
        },
        ServerEvent::OpenFilesChanged {
            worktree_id,
            project_id,
            paths,
        } => ServerMessage::OpenFilesChanged {
            worktree_id,
            project_id,
            paths,
        },
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

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use crate::connection::{WsConnection, WsSinkHandle};

    use super::{close_auth_expired, AUTH_EXPIRED_CLOSE_CODE, WsHub};

    fn conn_with_expiry(exp: Option<i64>) -> (WsConnection, Arc<Mutex<Option<(u16, String)>>>) {
        let closed = Arc::new(Mutex::new(None));
        let sink = WsSinkHandle::from_parts(
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            closed.clone(),
        );
        let conn = WsConnection::new(sink);
        conn.set_token_expires_at(exp);
        (conn, closed)
    }

    #[test]
    fn close_expired_auth_closes_only_expired_sockets_with_4401() {
        let hub = WsHub::new();
        let now_ms = 1_000_000;

        // Expired: expires_at <= now.
        let (expired, expired_closed) = conn_with_expiry(Some(now_ms));
        // Still valid: expires_at in the future.
        let (valid, valid_closed) = conn_with_expiry(Some(now_ms + 10_000));
        // No token / no expiry (cli/tauri): must be left untouched.
        let (no_expiry, no_expiry_closed) = conn_with_expiry(None);

        hub.register_connection(&expired);
        hub.register_connection(&valid);
        hub.register_connection(&no_expiry);

        let closed = hub.close_expired_auth(now_ms);
        assert_eq!(closed, 1);

        assert_eq!(
            *expired_closed.lock().unwrap(),
            Some((AUTH_EXPIRED_CLOSE_CODE, "Session expired or revoked".to_string()))
        );
        assert_eq!(*valid_closed.lock().unwrap(), None);
        assert_eq!(*no_expiry_closed.lock().unwrap(), None);
    }

    #[test]
    fn close_auth_expired_uses_the_4401_code() {
        let (conn, closed) = conn_with_expiry(None);
        close_auth_expired(&conn);
        let state = closed.lock().unwrap().clone();
        assert_eq!(state.map(|(c, _)| c), Some(AUTH_EXPIRED_CLOSE_CODE));
    }

    #[test]
    fn close_expired_auth_skips_sockets_already_closed() {
        let hub = WsHub::new();
        let now_ms = 1_000_000;

        // An expired socket that has already been closed (e.g. by the revoke
        // route) must not be re-closed or re-counted by the sweep — it may still
        // be in the registry until the read loop tears it down.
        let (expired, expired_closed) = conn_with_expiry(Some(now_ms));
        close_auth_expired(&expired); // simulate the revoke path closing it first
        hub.register_connection(&expired);

        let closed = hub.close_expired_auth(now_ms);
        assert_eq!(closed, 0, "already-closed sockets should not be re-closed");
        assert_eq!(
            *expired_closed.lock().unwrap(),
            Some((AUTH_EXPIRED_CLOSE_CODE, "Session expired or revoked".to_string())),
            "close code/reason from the original close must be preserved"
        );
    }
}
