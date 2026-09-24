//! Behavior contract for `JsonAgentStream` — ports
//! `daemon/src/ws/streams/jsonAgentStream.ts`, the EventEmitter adapter that
//! bridges a `JsonAgentSession` to WebSocket subscribers. Kept separate from
//! the session so the transport layer (persistence, queue, spawn) never
//! imports `ws`.
//!
//! A `message` listener receives every emitted `NormalizedEvent`; a `meta`
//! listener receives every emitted `SessionMeta`. Listeners are synchronous
//! and fan-out preserves registration order.

mod common;

use std::sync::{Arc, Mutex};

use vst_agents::json_agent_stream::JsonAgentStream;
use vst_types::{NormalizedEvent, NormalizedEventKind, SessionMeta};

fn sample_event(text: &str) -> NormalizedEvent {
    let mut e = NormalizedEvent::default();
    e.id = "e-1".into();
    e.session_id = "sess-1".into();
    e.ts = "t".into();
    e.kind = NormalizedEventKind::Text;
    e.text = Some(text.to_string());
    e
}

/// `emit_message` fans out to every registered `message` listener, in order.
#[test]
fn emit_message_fans_out_to_all_listeners_in_order() {
    let stream = JsonAgentStream::new();
    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    for i in 0..3 {
        let seen = Arc::clone(&seen);
        stream.on_message(Box::new(move |ev: &NormalizedEvent| {
            seen.lock().unwrap().push(format!(
                "listener-{i}:{}",
                ev.text.clone().unwrap_or_default()
            ));
        }));
    }
    stream.emit_message(&sample_event("hi"));
    let seen = seen.lock().unwrap();
    assert_eq!(
        *seen,
        vec!["listener-0:hi", "listener-1:hi", "listener-2:hi"],
        "fan-out preserves registration order"
    );
}

/// `emit_meta` fans out to every registered `meta` listener.
#[test]
fn emit_meta_fans_out_to_meta_listeners() {
    let stream = JsonAgentStream::new();
    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let seen2 = Arc::clone(&seen);
    stream.on_meta(Box::new(move |meta: &SessionMeta| {
        seen2.lock().unwrap().push(meta.session_id.clone());
    }));
    let meta = SessionMeta {
        session_id: "sess-1".into(),
        channel: vst_types::Channel::Json,
        mode_id: None,
        mode_name: None,
        cli: "claude".into(),
        model: None,
        turn_state: vst_types::TurnState::Idle,
        queue_depth: 0,
        queued_turn_ids: vec![],
        editing_turn_ids: vec![],
        usage: None,
        cwd: None,
        can_steer: None,
        commands: None,
        notice_slot: None,
        active_turn_id: None,
    };
    stream.emit_meta(&meta);
    assert_eq!(*seen.lock().unwrap(), vec!["sess-1".to_string()]);
}

/// A message listener does NOT receive meta events and vice versa (distinct
/// channels).
#[test]
fn message_and_meta_channels_are_distinct() {
    let stream = JsonAgentStream::new();
    let messages: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let metas: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

    let m2 = Arc::clone(&messages);
    stream.on_message(Box::new(move |ev: &NormalizedEvent| {
        m2.lock().unwrap().push(ev.id.clone());
    }));
    let g2 = Arc::clone(&metas);
    stream.on_meta(Box::new(move |_meta: &SessionMeta| {
        g2.lock().unwrap().push("meta".to_string());
    }));

    stream.emit_message(&sample_event("hi"));
    let meta = SessionMeta {
        session_id: "sess-1".into(),
        channel: vst_types::Channel::Json,
        mode_id: None,
        mode_name: None,
        cli: "claude".into(),
        model: None,
        turn_state: vst_types::TurnState::Idle,
        queue_depth: 0,
        queued_turn_ids: vec![],
        editing_turn_ids: vec![],
        usage: None,
        cwd: None,
        can_steer: None,
        commands: None,
        notice_slot: None,
        active_turn_id: None,
    };
    stream.emit_meta(&meta);

    assert_eq!(
        messages.lock().unwrap().len(),
        1,
        "only the message listener"
    );
    assert_eq!(metas.lock().unwrap().len(), 1, "only the meta listener");
}
