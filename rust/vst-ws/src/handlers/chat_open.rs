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
    find_json_session_context, read_schedule_state, read_session_meta, read_session_since,
    read_session_tail, resolve_json_agent, JsonSessionContext,
};
use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_store::transcript::{SincePage, TranscriptPage};
use vst_store::StoreHandle;
use vst_types::domain::LifecycleState;
use vst_types::events::Broadcaster;
use vst_types::ws::ClientMessage;
use vst_types::ws::ServerMessage;
use vst_types::{NormalizedEvent, SessionMeta};

use crate::connection::{ChatStreamEntry, WsConnection};

/// Default bounded replay window on open (turns).
const TAIL_TURNS: i64 = 15;
/// Default bounded replay window on open (bytes). `TranscriptStore::tail`
/// ALWAYS includes the newest turn whole, so the worst-case frame is this plus
/// one (unbounded) turn.
const TAIL_BYTE_BUDGET: usize = 300 * 1024;

/// Which source produced a replay frame — used for the one log line per
/// `chat:open`.
#[derive(Clone, Copy, PartialEq, Debug)]
enum ReplayMode {
    /// A fresh open's budgeted tail window.
    Tail,
    /// A reconnect delta that fits the bounded window.
    Since,
    /// A reconnect delta that overflowed (too many events or too many bytes).
    SinceOverflow,
}

impl ReplayMode {
    fn as_str(self) -> &'static str {
        match self {
            ReplayMode::Tail => "tail",
            ReplayMode::Since => "since",
            ReplayMode::SinceOverflow => "since_overflow",
        }
    }
}

/// A replay frame plus the metrics for its one log line.
struct Snapshot {
    frame: ServerMessage,
    mode: ReplayMode,
    events: usize,
    bytes: usize,
    has_more: bool,
}

impl Snapshot {
    fn from_tail(session_id: &str, page: TranscriptPage) -> Snapshot {
        let events = page.events.len();
        let bytes = page.payload_bytes;
        let has_more = page.has_more;
        Snapshot {
            frame: ServerMessage::ChatReplay {
                session_id: session_id.to_string(),
                events: page.events,
                oldest_seq: page.oldest_seq,
                has_more: Some(has_more),
                next_seq: None,
            },
            mode: ReplayMode::Tail,
            events,
            bytes,
            has_more,
        }
    }

    fn from_since(session_id: &str, page: SincePage) -> Snapshot {
        let events = page.events.len();
        let bytes = page.payload_bytes;
        let has_more = page.has_more;
        Snapshot {
            frame: ServerMessage::ChatReplay {
                session_id: session_id.to_string(),
                events: page.events,
                oldest_seq: None,
                has_more: None,
                next_seq: page.next_seq,
            },
            mode: ReplayMode::Since,
            events,
            bytes,
            has_more,
        }
    }
}

fn send_snapshot(
    conn: &WsConnection,
    ctx: &JsonSessionContext,
    registry: &JsonAgentRegistry<JsonAgentSession>,
    session_id: &str,
    since_seq: Option<i64>,
) {
    let read_start = std::time::Instant::now();
    let snap = if let Some(since) = since_seq {
        let page = read_session_since(ctx, registry, since);
        since_or_tail_snapshot(session_id, page, || {
            read_session_tail(ctx, registry, TAIL_TURNS, TAIL_BYTE_BUDGET)
        })
    } else {
        Snapshot::from_tail(
            session_id,
            read_session_tail(ctx, registry, TAIL_TURNS, TAIL_BYTE_BUDGET),
        )
    };
    let read_ms = read_start.elapsed().as_millis() as u64;
    let send_start = std::time::Instant::now();
    conn.send(snap.frame);
    let send_ms = send_start.elapsed().as_millis() as u64;
    // ONE info line per `chat:open` replay, recording how the window was
    // bounded and how long read/send took.
    tracing::info!(
        session_id,
        mode = snap.mode.as_str(),
        events = snap.events,
        bytes = snap.bytes,
        has_more = snap.has_more,
        read_ms,
        send_ms,
        "[chat-open] replay"
    );
}

/// A reconnect delta that fits in the bounded window is served as a delta
/// frame; one that overflows (`page.has_more`) OR carries more bytes than the
/// replay budget (`page.payload_bytes > TAIL_BYTE_BUDGET` — a delta under 200
/// events can still be MBs) is served as the normal budgeted tail frame so the
/// client's existing gap detection drops its stale cache instead of silently
/// paging forever (Decision 5).
fn since_or_tail_snapshot(
    session_id: &str,
    page: SincePage,
    tail: impl FnOnce() -> TranscriptPage,
) -> Snapshot {
    if page.has_more || page.payload_bytes > TAIL_BYTE_BUDGET {
        let mut snap = Snapshot::from_tail(session_id, tail());
        snap.mode = ReplayMode::SinceOverflow;
        snap
    } else {
        Snapshot::from_since(session_id, page)
    }
}

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

    // The chat's own subscription membership, NOT the client's explicit
    // `subscribe` set: `chat:open`/`chat:close` are dispatched on their own
    // ordering lane, so mutating the shared set here could undo a `subscribe`
    // the client issued in between (see `ConnectionState::chat_subscriptions`).
    conn.subscribe_chat(&session_id);

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
        send_schedule_state(conn, store, &session_id).await;
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
    // The meta MUST go out with no await between `get_meta()` and `send`: the
    // live listener is already attached, so awaiting here would let a fresher
    // live `session:meta` arrive first and then be overwritten by this older
    // snapshot (R2.7). The store-backed scheduled fields follow as their own
    // slim event, which patches only those fields.
    let meta = resolved.agent.get_meta();
    conn.send(ServerMessage::SessionMetaEvent {
        session_id: session_id.clone(),
        meta: Box::new(meta),
    });
    send_schedule_state(conn, store, &session_id).await;
}

/// Send the session's scheduled-send state as a slim `session:scheduled` event
/// (the same message live changes use), so it can't clobber turn state.
async fn send_schedule_state(conn: &WsConnection, store: &StoreHandle, session_id: &str) {
    let st = read_schedule_state(store, session_id).await;
    conn.send(ServerMessage::SessionScheduled {
        session_id: session_id.to_string(),
        scheduled_sends: st.sends,
        scheduled_failed: st.failed,
        scheduled_turn_ids: st.turn_ids,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use vst_types::ws::ServerMessage;

    fn since_page(has_more: bool) -> SincePage {
        SincePage {
            events: vec![],
            next_seq: Some(123),
            has_more,
            payload_bytes: 0,
        }
    }

    fn tail_page() -> TranscriptPage {
        TranscriptPage {
            events: vec![],
            oldest_seq: Some(50),
            has_more: true,
            payload_bytes: 0,
        }
    }

    #[test]
    fn overflowing_since_page_answers_with_tail_frame() {
        let snap = since_or_tail_snapshot("s1", since_page(true), tail_page);
        assert_eq!(snap.mode, ReplayMode::SinceOverflow);
        match snap.frame {
            ServerMessage::ChatReplay {
                session_id,
                has_more,
                oldest_seq,
                next_seq,
                ..
            } => {
                assert_eq!(session_id, "s1");
                assert_eq!(has_more, Some(true));
                assert_eq!(oldest_seq, Some(50));
                assert_eq!(next_seq, None);
            }
            other => panic!("expected ChatReplay, got {other:?}"),
        }
    }

    #[test]
    fn fitting_since_page_stays_delta() {
        let snap = since_or_tail_snapshot("s1", since_page(false), || {
            panic!("tail closure must not be called for a fitting delta")
        });
        assert_eq!(snap.mode, ReplayMode::Since);
        match snap.frame {
            ServerMessage::ChatReplay {
                session_id,
                has_more,
                oldest_seq,
                next_seq,
                ..
            } => {
                assert_eq!(session_id, "s1");
                assert_eq!(has_more, None);
                assert_eq!(oldest_seq, None);
                assert_eq!(next_seq, Some(123));
            }
            other => panic!("expected ChatReplay, got {other:?}"),
        }
    }

    // a delta that fits by EVENT count but exceeds the byte budget is
    // served as a tail frame (mode `since_overflow`).
    #[test]
    fn overweight_since_page_answers_with_tail_frame() {
        let mut page = since_page(false);
        page.payload_bytes = TAIL_BYTE_BUDGET + 1;
        let snap = since_or_tail_snapshot("s1", page, tail_page);
        assert_eq!(snap.mode, ReplayMode::SinceOverflow);
        match snap.frame {
            ServerMessage::ChatReplay {
                has_more, next_seq, ..
            } => {
                assert_eq!(has_more, Some(true));
                assert_eq!(next_seq, None);
            }
            other => panic!("expected ChatReplay, got {other:?}"),
        }
    }
}

pub fn handle_chat_close(conn: &WsConnection, msg: &ClientMessage) {
    if let ClientMessage::ChatClose { session_id } = msg {
        conn.unregister_chat_stream(session_id);
        // Releases only this chat's own membership; an explicit client
        // `subscribe` for the same session survives (and vice versa).
        conn.unsubscribe_chat(session_id);
    }
}
