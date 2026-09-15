//! `JsonAgentStream` — the EventEmitter adapter bridging a `JsonAgentSession`
//! to WebSocket subscribers. Ports `daemon/src/ws/streams/jsonAgentStream.ts`.
//!
//! Kept separate from the session so the transport layer (persistence, queue,
//! spawn) never imports `ws`. The session emits normalized chat events
//! (`message`) and meta updates (`meta`) here; the WS layer attaches listeners
//! to fan them out as `session:message` / `session:meta` frames.
//!
//! Rust has no `EventEmitter`; listeners are stored as `Arc<dyn Fn>` so an
//! `emit` can snapshot the list out of the lock and invoke it WITHOUT holding
//! the mutex across the callbacks (re-entrant `on_*`/`emit_*` inside a listener
//! cannot deadlock). `Arc` is cloneable, so each emit clones the (cheap) Arc
//! handles, drops the guard, then invokes — matching the TS's synchronous,
//! ordered fan-out.

use std::sync::{Arc, Mutex};

use vst_types::{NormalizedEvent, SessionMeta};

type MessageListener = dyn Fn(&NormalizedEvent) + Send + Sync;
type MetaListener = dyn Fn(&SessionMeta) + Send + Sync;

#[derive(Default)]
struct Inner {
    message: Vec<Arc<MessageListener>>,
    meta: Vec<Arc<MetaListener>>,
}

/// The session's chat-event emitter. Shared with the WS layer via `Arc`.
#[derive(Default)]
pub struct JsonAgentStream {
    inner: Arc<Mutex<Inner>>,
}

impl JsonAgentStream {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a `message` listener (fan-out on every `emit_message`).
    pub fn on_message(&self, f: Box<MessageListener>) {
        self.inner.lock().unwrap().message.push(Arc::from(f));
    }

    /// Register a `meta` listener (fan-out on every `emit_meta`).
    pub fn on_meta(&self, f: Box<MetaListener>) {
        self.inner.lock().unwrap().meta.push(Arc::from(f));
    }

    /// Emit a normalized chat event to every `message` listener, in order.
    pub fn emit_message(&self, event: &NormalizedEvent) {
        let listeners = self.inner.lock().unwrap().message.clone();
        for listener in &listeners {
            listener(event);
        }
    }

    /// Emit a meta update to every `meta` listener, in order.
    pub fn emit_meta(&self, meta: &SessionMeta) {
        let listeners = self.inner.lock().unwrap().meta.clone();
        for listener in &listeners {
            listener(meta);
        }
    }
}

impl std::fmt::Debug for JsonAgentStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let inner = self.inner.lock().unwrap();
        f.debug_struct("JsonAgentStream")
            .field("message_listeners", &inner.message.len())
            .field("meta_listeners", &inner.meta.len())
            .finish()
    }
}
