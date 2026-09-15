//! `chat:open` / `chat:close` handlers — JSON agent-chat WS subscription +
//! bounded replay.
//!
//! Ports `daemon/src/ws/handlers/chatOpen.ts`. `chat:open` subscribes the
//! connection to a session's normalized event stream and replays a BOUNDED
//! window via `chat:replay` (tail-N + keyset cursor, or a `sinceSeq` delta on
//! reconnect). It bridges the session's `JsonAgentStream` → `session:message` /
//! `session:meta` frames for as long as the chat is open.
//!
//! Reaches plugin resolution ONLY through `vst_agents::json_agent_chat` —
//! never imports `vst-agents::registry` directly (System Boundary restricted
//! call-site rule).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use vst_agents::json_agent_chat::{
    find_json_session_context, read_session_meta, read_session_since, read_session_tail,
    resolve_json_agent, JsonSessionContext,
};
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_store::StoreHandle;
use vst_types::domain::LifecycleState;
use vst_types::events::Broadcaster;
use vst_types::ws::ClientMessage;
use vst_types::ws::ServerMessage;
use vst_types::{NormalizedEvent, SessionMeta};

use crate::connection::{ChatStreamEntry, WsConnection};

/// Default bounded replay window on open (turns).
const TAIL_TURNS: i64 = 15;

pub async fn handle_chat_open(
    conn: &WsConnection,
    store: &StoreHandle,
    registry: &JsonAgentRegistry<JsonAgentSession>,
    broadcaster: Broadcaster,
    daemon_port: u16,
    msg: &ClientMessage,
) {
    let ClientMessage::ChatOpen {
        session_id,
        since_seq,
    } = msg
    else {
        return;
    };
    let session_id = session_id.clone();
    let since_seq = *since_seq;

    let Some(ctx) = find_json_session_context(store, &session_id).await else {
        conn.send(ServerMessage::SessionError {
            session_id: session_id.clone(),
            message: format!("Session '{session_id}' not found"),
            reason: None,
        });
        return;
    };

    conn.subscribe(std::slice::from_ref(&session_id));

    // A session marked `done` has had its JsonAgentSession released — resolving
    // it would lazily RE-CREATE it. Serve it from disk instead.
    if ctx.session.lifecycle.state == LifecycleState::Done {
        conn.unregister_chat_stream(&session_id);
        send_snapshot(conn, &ctx, registry, &session_id, since_seq);
        let meta = read_session_meta(&ctx, registry).await;
        conn.send(ServerMessage::SessionMetaEvent {
            session_id: session_id.clone(),
            meta: Box::new(meta),
        });
        return;
    }

    let resolved = resolve_json_agent(&session_id, daemon_port, store, registry, broadcaster)
        .await
        .ok();

    let Some(resolved) = resolved else {
        send_snapshot(conn, &ctx, registry, &session_id, since_seq);
        return;
    };

    // Attach the live listeners FIRST, then take the snapshot synchronously
    // (R2.7 read→subscribe gap). Replace any prior subscription.
    conn.unregister_chat_stream(&session_id);
    let active = Arc::new(AtomicBool::new(true));

    // The fan-out body lives in an `Arc` so it can be shared between the
    // stream listener (registered below) and the stored entry, without
    // registering the same behaviour twice.
    let c = conn.clone();
    let sid = session_id.clone();
    let active_msg = active.clone();
    let on_message_arc: Arc<dyn Fn(&NormalizedEvent) + Send + Sync> = Arc::new(move |event| {
        if active_msg.load(Ordering::SeqCst) {
            c.send(ServerMessage::SessionMessage {
                session_id: sid.clone(),
                event: Box::new(event.clone()),
            });
        }
    });
    let c = conn.clone();
    let sid = session_id.clone();
    let active_meta = active.clone();
    let on_meta_arc: Arc<dyn Fn(&SessionMeta) + Send + Sync> = Arc::new(move |meta| {
        if active_meta.load(Ordering::SeqCst) {
            c.send(ServerMessage::SessionMetaEvent {
                session_id: sid.clone(),
                meta: Box::new(meta.clone()),
            });
        }
    });

    // Register the closures on the stream, and keep the SAME Arc bodies in the
    // entry so `unregister` can mark them inert via the shared `active` flag.
    {
        let f = on_message_arc.clone();
        resolved.agent.stream().on_message(Box::new(move |e| f(e)));
        let g = on_meta_arc.clone();
        resolved.agent.stream().on_meta(Box::new(move |m| g(m)));
    }

    let entry = ChatStreamEntry {
        on_message: Box::new(move |e| on_message_arc(e)),
        on_meta: Box::new(move |m| on_meta_arc(m)),
        active,
    };
    conn.register_chat_stream(&session_id, entry);

    // Snapshot AFTER attach — synchronous, so nothing interleaves (R2.7).
    send_snapshot(conn, &ctx, registry, &session_id, since_seq);
    let meta = resolved.agent.get_meta();
    conn.send(ServerMessage::SessionMetaEvent {
        session_id: session_id.clone(),
        meta: Box::new(meta),
    });
}

fn send_snapshot(
    conn: &WsConnection,
    ctx: &JsonSessionContext,
    registry: &JsonAgentRegistry<JsonAgentSession>,
    session_id: &str,
    since_seq: Option<i64>,
) {
    if let Some(since) = since_seq {
        let page = read_session_since(ctx, registry, since);
        conn.send(ServerMessage::ChatReplay {
            session_id: session_id.to_string(),
            events: page.events,
            oldest_seq: None,
            has_more: Some(page.has_more),
            next_seq: page.next_seq,
        });
    } else {
        let page = read_session_tail(ctx, registry, TAIL_TURNS);
        conn.send(ServerMessage::ChatReplay {
            session_id: session_id.to_string(),
            events: page.events,
            oldest_seq: page.oldest_seq,
            has_more: Some(page.has_more),
            next_seq: None,
        });
    }
}

pub fn handle_chat_close(conn: &WsConnection, msg: &ClientMessage) {
    if let ClientMessage::ChatClose { session_id } = msg {
        conn.unregister_chat_stream(session_id);
        conn.unsubscribe(std::slice::from_ref(session_id));
    }
}
