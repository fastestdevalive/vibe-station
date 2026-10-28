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

use std::sync::{Arc, Mutex, Weak};

use vst_types::{NormalizedEvent, SessionMeta};

type MessageListener = dyn Fn(&NormalizedEvent) + Send + Sync;
type MetaListener = dyn Fn(&SessionMeta) + Send + Sync;

#[derive(Default)]
struct Inner {
    next_id: u64,
    message: Vec<(u64, Arc<MessageListener>)>,
    meta: Vec<(u64, Arc<MetaListener>)>,
}

/// RAII handle for a registered listener: dropping it removes the listener
/// from the stream, which releases whatever the closure captured (e.g. a
/// `WsConnection` clone — a listener that outlives its connection keeps the
/// connection's outbound channel open forever). Holds only a `Weak` ref so it
/// never keeps the stream alive.
pub struct ListenerGuard {
    inner: Weak<Mutex<Inner>>,
    id: u64,
}

impl Drop for ListenerGuard {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.upgrade() {
            let mut inner = inner.lock().unwrap();
            inner.message.retain(|(id, _)| *id != self.id);
            inner.meta.retain(|(id, _)| *id != self.id);
        }
    }
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

    /// Register a permanent `message` listener (fan-out on every
    /// `emit_message`). Use [`Self::subscribe_message`] for a listener that
    /// must be removable.
    pub fn on_message(&self, f: Box<MessageListener>) {
        self.add_message(f);
    }

    /// Register a permanent `meta` listener (fan-out on every `emit_meta`).
    pub fn on_meta(&self, f: Box<MetaListener>) {
        self.add_meta(f);
    }

    /// Like [`Self::on_message`], but the listener is removed when the
    /// returned guard is dropped.
    #[must_use = "dropping the guard immediately removes the listener"]
    pub fn subscribe_message(&self, f: Box<MessageListener>) -> ListenerGuard {
        ListenerGuard {
            inner: Arc::downgrade(&self.inner),
            id: self.add_message(f),
        }
    }

    /// Like [`Self::on_meta`], but the listener is removed when the returned
    /// guard is dropped.
    #[must_use = "dropping the guard immediately removes the listener"]
    pub fn subscribe_meta(&self, f: Box<MetaListener>) -> ListenerGuard {
        ListenerGuard {
            inner: Arc::downgrade(&self.inner),
            id: self.add_meta(f),
        }
    }

    fn add_message(&self, f: Box<MessageListener>) -> u64 {
        let mut inner = self.inner.lock().unwrap();
        inner.next_id += 1;
        let id = inner.next_id;
        inner.message.push((id, Arc::from(f)));
        id
    }

    fn add_meta(&self, f: Box<MetaListener>) -> u64 {
        let mut inner = self.inner.lock().unwrap();
        inner.next_id += 1;
        let id = inner.next_id;
        inner.meta.push((id, Arc::from(f)));
        id
    }

    /// Emit a normalized chat event to every `message` listener, in order.
    pub fn emit_message(&self, event: &NormalizedEvent) {
        let listeners: Vec<_> = self
            .inner
            .lock()
            .unwrap()
            .message
            .iter()
            .map(|(_, l)| l.clone())
            .collect();
        for listener in &listeners {
            listener(event);
        }
    }

    /// Emit a meta update to every `meta` listener, in order.
    pub fn emit_meta(&self, meta: &SessionMeta) {
        let listeners: Vec<_> = self
            .inner
            .lock()
            .unwrap()
            .meta
            .iter()
            .map(|(_, l)| l.clone())
            .collect();
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
