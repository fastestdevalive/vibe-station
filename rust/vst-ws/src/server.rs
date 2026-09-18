//! `WsServer` — message dispatcher + connection lifecycle + heartbeat.
//!
//! Ports the dispatch logic of `daemon/src/ws/server.ts` (the Fastify/axum
//! socket transport itself lives in `vst-daemon`; this crate owns the message
//! routing and connection bookkeeping). Each parsed `ClientMessage` is routed
//! to its handler. `session:open`/`session:close` are awaited so their keyed
//! session-lock critical sections (including the attach park point) complete.

use std::sync::Arc;

use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;
use vst_types::ws::ClientMessage;

use crate::broadcaster::WsHub;
use crate::connection::WsConnection;
use crate::handlers::chat_open::{handle_chat_close, handle_chat_open};
use crate::handlers::debug_log::handle_debug_log;
use crate::handlers::file_watch::{
    handle_file_unwatch, handle_file_watch, WatcherRegistry, WorktreePathResolver,
};
use crate::handlers::ping::handle_ping;
use crate::handlers::session_close::handle_session_close;
use crate::handlers::session_input::handle_session_input;
use crate::handlers::session_lookup::SessionLookup;
use crate::handlers::session_open::{handle_session_open, DirectStreamRegistry};
use crate::handlers::session_resize::handle_session_resize;
use crate::handlers::subscribe::{handle_subscribe, handle_unsubscribe};
use crate::handlers::tree_watch::{handle_tree_unwatch, handle_tree_watch};

/// Dependencies every WS handler needs, resolved once at server setup.
#[derive(Clone)]
pub struct DispatchContext {
    pub hub: Arc<WsHub>,
    pub store: StoreHandle,
    pub json_registry: Arc<JsonAgentRegistry<JsonAgentSession>>,
    pub broadcaster: Broadcaster,
    pub daemon_port: u16,
    pub direct_streams: DirectStreamRegistry,
    pub watchers: WatcherRegistry,
    pub resolve_worktree_root: WorktreePathResolver,
}

impl DispatchContext {
    // (handlers build their own SessionLookup from the store on demand)
}

/// Dispatch a parsed client message to its handler.
pub async fn dispatch(conn: &WsConnection, ctx: &DispatchContext, msg: &ClientMessage) {
    match msg {
        ClientMessage::Subscribe { .. } => handle_subscribe(conn, msg),
        ClientMessage::Unsubscribe { .. } => handle_unsubscribe(conn, msg),
        ClientMessage::Ping => handle_ping(conn),
        ClientMessage::SessionOpen { .. } => {
            let lookup = SessionLookup::from_store(&ctx.store).await;
            handle_session_open(conn, &lookup, &ctx.direct_streams, msg).await;
        }
        ClientMessage::SessionClose { .. } => {
            handle_session_close(conn, msg).await;
        }
        ClientMessage::SessionResize { .. } => {
            let lookup = SessionLookup::from_store(&ctx.store).await;
            handle_session_resize(conn, &lookup, msg).await;
        }
        ClientMessage::SessionInput { .. } => {
            let lookup = SessionLookup::from_store(&ctx.store).await;
            handle_session_input(conn, &lookup, msg).await;
        }
        ClientMessage::FileWatch { .. } => {
            handle_file_watch(conn, &ctx.watchers, &ctx.resolve_worktree_root, msg);
        }
        ClientMessage::FileUnwatch { .. } => {
            handle_file_unwatch(conn, &ctx.watchers, msg).await;
        }
        ClientMessage::TreeWatch { .. } => {
            handle_tree_watch(conn, &ctx.watchers, &ctx.resolve_worktree_root, msg).await;
        }
        ClientMessage::TreeUnwatch { .. } => {
            handle_tree_unwatch(conn, &ctx.watchers, msg).await;
        }
        ClientMessage::ChatOpen { .. } => {
            handle_chat_open(
                conn,
                &ctx.store,
                ctx.json_registry.as_ref(),
                ctx.broadcaster.clone(),
                ctx.daemon_port,
                msg,
            )
            .await;
        }
        ClientMessage::ChatClose { .. } => {
            handle_chat_close(conn, msg);
        }
        ClientMessage::DebugLog { .. } => {
            handle_debug_log(conn, msg);
        }
    }
}

/// Handle a parse/validation failure, sending a `system:error` (mirrors
/// `server.ts`'s catch block).
pub fn send_parse_error(conn: &WsConnection, is_invalid_json: bool) {
    if is_invalid_json {
        conn.send(vst_types::ws::ServerMessage::SystemError {
            message: "Invalid JSON".to_string(),
        });
    } else {
        conn.send(vst_types::ws::ServerMessage::SystemError {
            message: "Invalid message format".to_string(),
        });
    }
}
