//! Behavior contract tests for `vst-ws::connection` — the `WSConnection`
//! per-`(connection, sessionId)` keyed lock, the refcounted watcher maps, and
//! `send()` backpressure coalescing (socket-cycling fix).
//!
//! Ports `daemon/src/__tests__/connection.test.ts` and adds the plan's mandated
//! concurrency regression tests (Gotcha #1 / AGENTS.md § WebSocket):
//!
//! - Interleaved `session:open`/`session:close` on the same
//!   `(connection, sessionId)` must never yield >1 live stream at any instant
//!   (the double-echo / ghost-stream bug).
//! - Two DIFFERENT connection ids may hold two live streams concurrently for
//!   the SAME session id (tabs are independent).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use vst_ws::connection::{OpenStreamEntry, SessionStream, WsConnection, WsSink, WsSinkHandle};

/// A fake stream whose `new`/`detach` maintain a shared live-count, and whose
/// `attach` can optionally park on a `Notify` so a test can prove the keyed
/// lock serializes concurrent attach/detach. A `max_live` high-water mark is
/// tracked so the "≤1 live at every instant" invariant is observable.
struct FakeStream {
    live: Arc<AtomicUsize>,
    park: Option<Arc<tokio::sync::Notify>>,
}

impl FakeStream {
    fn new(live: Arc<AtomicUsize>, max_live: Arc<AtomicUsize>) -> Self {
        let l = live.fetch_add(1, Ordering::SeqCst) + 1;
        max_live.fetch_max(l, Ordering::SeqCst);
        FakeStream { live, park: None }
    }
}

#[async_trait::async_trait]
impl SessionStream for FakeStream {
    async fn attach(
        &self,
        _cols: i64,
        _rows: i64,
        _subscriber_id: &str,
    ) -> Result<(), vst_ws::Error> {
        if let Some(notify) = &self.park {
            notify.notified().await;
        }
        Ok(())
    }
    fn write(&self, _data: &str) {}
    async fn resize(&self, _cols: i64, _rows: i64, _subscriber_id: Option<&str>) {}
    async fn detach(&self, _subscriber_id: &str) -> Result<(), vst_ws::Error> {
        self.live.fetch_sub(1, Ordering::SeqCst);
        Ok(())
    }
    fn on_chunk(&self) -> tokio::sync::broadcast::Receiver<String> {
        let (_t, r) = tokio::sync::broadcast::channel(1);
        r
    }
    fn on_close(&self) -> tokio::sync::broadcast::Receiver<()> {
        let (_t, r) = tokio::sync::broadcast::channel(1);
        r
    }
    fn on_opened(&self) -> tokio::sync::broadcast::Receiver<()> {
        let (_t, r) = tokio::sync::broadcast::channel(1);
        r
    }
    fn on_error(&self) -> tokio::sync::broadcast::Receiver<String> {
        let (_t, r) = tokio::sync::broadcast::channel(1);
        r
    }
}

async fn open_conn(
    conn: &WsConnection,
    session: &str,
    live: Arc<AtomicUsize>,
    max_live: Arc<AtomicUsize>,
    park: Option<Arc<tokio::sync::Notify>>,
) {
    let c = conn.clone();
    let session = session.to_string();
    let lock_conn = c.clone();
    let sid_arg = session.clone();
    lock_conn
        .with_session_lock(&sid_arg, move || {
            let c = c.clone();
            async move {
                let mut stream = Arc::new(FakeStream::new(live.clone(), max_live.clone()));
                if let Some(p) = park {
                    if let Some(s) = Arc::get_mut(&mut stream) {
                        s.park = Some(p);
                    }
                }
                let entry = OpenStreamEntry {
                    kind: "tmux".into(),
                    stream,
                    subscriber_id: format!("conn:{session}"),
                };
                c.register_open_stream(&session, entry);
                let entry = c.open_stream_entry(&session).unwrap();
                entry.stream.attach(80, 24, &entry.subscriber_id).await
            }
        })
        .await
        .unwrap();
}

async fn close_conn(conn: &WsConnection, session: &str) {
    let c = conn.clone();
    let session = session.to_string();
    let lock_conn = c.clone();
    let sid_arg = session.clone();
    lock_conn
        .with_session_lock(&sid_arg, move || {
            let c = c.clone();
            async move {
                let entry = c.open_stream_entry(&session);
                if let Some(entry) = entry {
                    entry.stream.detach(&entry.subscriber_id).await?;
                    c.unregister_open_stream(&session);
                }
                Ok::<(), vst_ws::Error>(())
            }
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn with_session_lock_serializes_same_session_on_same_connection() {
    let live = Arc::new(AtomicUsize::new(0));
    let max_live = Arc::new(AtomicUsize::new(0));
    let sink_handle = WsSinkHandle::mock(0);
    let conn = WsConnection::new(sink_handle);

    // Interleave 25 open + 25 close under the lock for the same session id,
    // simulating a terminal remount firing close-then-open back-to-back.
    let session = "s1".to_string();

    let mut handles = Vec::new();
    for _ in 0..25 {
        let c = conn.clone();
        let s = session.clone();
        let live = live.clone();
        let max = max_live.clone();
        handles.push(tokio::spawn(async move {
            open_conn(&c, &s, live, max, None).await;
        }));
        let c = conn.clone();
        let s = session.clone();
        handles.push(tokio::spawn(async move {
            close_conn(&c, &s).await;
        }));
    }
    for h in handles {
        let _ = h.await;
    }

    // Because the lock serializes, no more than one stream is live at any
    // instant, and none remain after all closes.
    assert_eq!(
        max_live.load(Ordering::SeqCst),
        1,
        "same (connection, session) must never hold >1 live stream (Gotcha #1)"
    );
    assert_eq!(
        live.load(Ordering::SeqCst),
        0,
        "no stream should remain live after all closes"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn keyed_lock_two_connections_hold_two_live_handles_concurrently() {
    // The plan's System Boundary test: two DIFFERENT connection ids may hold
    // two live handles for the SAME session_id (tabs are independent). Only
    // same-connection-same-session is serialized.
    let live = Arc::new(AtomicUsize::new(0));
    let max_live = Arc::new(AtomicUsize::new(0));
    let sink1 = WsSinkHandle::mock(0);
    let sink2 = WsSinkHandle::mock(0);
    let conn1 = WsConnection::new(sink1);
    let conn2 = WsConnection::new(sink2);

    let session = "shared-session".to_string();
    let park1 = Arc::new(tokio::sync::Notify::new());
    let park2 = Arc::new(tokio::sync::Notify::new());

    let h1 = {
        let c = conn1.clone();
        let s = session.clone();
        let live = live.clone();
        let max = max_live.clone();
        let park = park1.clone();
        tokio::spawn(async move { open_conn(&c, &s, live, max, Some(park)).await })
    };
    let h2 = {
        let c = conn2.clone();
        let s = session.clone();
        let live = live.clone();
        let max = max_live.clone();
        let park = park2.clone();
        tokio::spawn(async move { open_conn(&c, &s, live, max, Some(park)).await })
    };

    // Give both tasks time to register + park at the attach.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    // Both connections have a live stream for the same session id.
    assert_eq!(
        live.load(Ordering::SeqCst),
        2,
        "two connections may hold two live handles concurrently"
    );
    assert!(conn1.has_open_stream(&session));
    assert!(conn2.has_open_stream(&session));

    // Release the parks and let them finish.
    park1.notify_one();
    park2.notify_one();
    h1.await.unwrap();
    h2.await.unwrap();
}

/// A test sink capturing sent frames + close.
struct FakeSink {
    sent: Arc<Mutex<Vec<serde_json::Value>>>,
    buffered: Arc<AtomicUsize>,
    closed: Arc<Mutex<Option<(u16, String)>>>,
}

impl FakeSink {
    fn new(buffered: usize) -> (Self, WsSinkHandle) {
        let sink = FakeSink {
            sent: Arc::new(Mutex::new(Vec::new())),
            buffered: Arc::new(AtomicUsize::new(buffered)),
            closed: Arc::new(Mutex::new(None)),
        };
        let handle = WsSinkHandle::from_parts(
            sink.sent.clone(),
            sink.buffered.clone(),
            sink.closed.clone(),
        );
        (sink, handle)
    }
}

impl WsSink for FakeSink {
    fn ready_state(&self) -> u8 {
        1
    }
    fn buffered_amount(&self) -> usize {
        self.buffered.load(Ordering::SeqCst)
    }
    fn send_text(&self, text: String) {
        self.sent
            .lock()
            .unwrap()
            .push(serde_json::from_str(&text).unwrap());
    }
    fn close(&self, code: u16, reason: &str) {
        *self.closed.lock().unwrap() = Some((code, reason.to_string()));
    }
    fn ping(&self) {}
    fn closed_state(&self) -> Option<(u16, String)> {
        self.closed.lock().unwrap().clone()
    }
}

#[tokio::test]
async fn send_does_not_close_under_soft_limit() {
    let (sink, handle) = FakeSink::new(2_000_000);
    let conn = WsConnection::new(handle);
    conn.send(serde_json::json!({"type": "session:output", "sessionId": "s1", "chunk": "hello"}));
    assert!(sink.closed.lock().unwrap().is_none());
    conn.cleanup().await;
}

#[tokio::test]
async fn send_coalesces_session_output_when_backed_up() {
    let (sink, handle) = FakeSink::new(2_000_000);
    let conn = WsConnection::new(handle.clone());
    conn.send(serde_json::json!({"type": "session:output", "sessionId": "s1", "chunk": "a"}));
    conn.send(serde_json::json!({"type": "session:output", "sessionId": "s1", "chunk": "b"}));
    // Coalesced, not sent individually; socket stays open.
    assert!(sink.sent.lock().unwrap().is_empty());
    assert!(sink.closed.lock().unwrap().is_none());
    conn.cleanup().await;
}

#[tokio::test]
async fn send_delivers_small_frames_under_backpressure() {
    let (sink, handle) = FakeSink::new(2_000_000);
    let conn = WsConnection::new(handle);
    conn.send(serde_json::json!({"type": "pong"}));
    assert_eq!(sink.sent.lock().unwrap().len(), 1);
    conn.cleanup().await;
}

#[tokio::test]
async fn send_closes_only_at_hard_limit() {
    let (sink, handle) = FakeSink::new(51 * 1024 * 1024);
    let conn = WsConnection::new(handle);
    conn.send(serde_json::json!({"type": "pong"}));
    let closed = conn.closed();
    assert_eq!(closed.map(|c| c.0), Some(1009));
    assert_eq!(
        sink.closed.lock().unwrap().as_ref().map(|c| c.0),
        Some(1009)
    );
}

#[tokio::test]
async fn send_flushes_coalesced_once_buffer_drains() {
    let (sink, handle) = FakeSink::new(2_000_000);
    let conn = WsConnection::new(handle);
    conn.send(serde_json::json!({"type": "session:output", "sessionId": "s1", "chunk": "abc"}));
    assert!(sink.sent.lock().unwrap().is_empty());
    // Buffer drains; a later non-output send must flush coalesced FIRST.
    sink.buffered.store(0, Ordering::SeqCst);
    conn.send(serde_json::json!({"type": "pong"}));
    {
        let sent = sink.sent.lock().unwrap();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0]["type"], "session:output");
        assert_eq!(sent[0]["chunk"], "abc");
        assert_eq!(sent[1]["type"], "pong");
    }
    conn.cleanup().await;
}

// ---- refcounted watcher maps (ports connection.test.ts) ----

#[tokio::test]
async fn tree_watcher_refcount_contract() {
    let (_, handle) = FakeSink::new(0);
    let conn = WsConnection::new(handle);
    let key = "tree:wt-1:";

    assert!(!conn.retain_tree_watcher(key));
    conn.register_tree_watcher(key, "watcher-A".to_string());
    assert!(conn.retain_tree_watcher(key));
    assert_eq!(conn.tree_watch_count(key), 2);

    // release returns None while refCount > 0, then the watcher at 0.
    assert!(conn.release_tree_watcher(key).is_none());
    assert!(conn.has_tree_watcher(key));
    assert_eq!(
        conn.release_tree_watcher(key),
        Some("watcher-A".to_string())
    );
    assert!(!conn.has_tree_watcher(key));

    // unknown key release returns None
    assert!(conn.release_tree_watcher("tree:unknown:").is_none());
}

#[tokio::test]
async fn tree_watcher_unregister_force_removes_and_debt_prevents_closing_new() {
    let (_, handle) = FakeSink::new(0);
    let conn = WsConnection::new(handle);
    let key = "tree:wt-1:";

    conn.register_tree_watcher(key, "watcher-A".to_string());
    conn.retain_tree_watcher(key); // refCount 2
    conn.unregister_tree_watcher(key); // force-remove, records debt = 2
    assert!(!conn.has_tree_watcher(key));

    // new unrelated consumer registers under same key
    assert!(!conn.retain_tree_watcher(key));
    conn.register_tree_watcher(key, "watcher-B".to_string());

    // stale retainers' releases drain the debt and must NOT close watcher-B
    assert!(conn.release_tree_watcher(key).is_none());
    assert!(conn.release_tree_watcher(key).is_none());
    assert_eq!(conn.tree_watch_count(key), 1);
    assert_eq!(
        conn.tree_watcher_instance(key),
        Some("watcher-B".to_string())
    );

    // legitimate consumer closes watcher-B
    assert_eq!(
        conn.release_tree_watcher(key),
        Some("watcher-B".to_string())
    );
    assert!(!conn.has_tree_watcher(key));
}

#[tokio::test]
async fn cleanup_closes_watchers_regardless_of_refcount() {
    let (_, handle) = FakeSink::new(0);
    let conn = WsConnection::new(handle);
    conn.register_tree_watcher("tree:wt-1:", "tw".to_string());
    conn.retain_tree_watcher("tree:wt-1:");
    conn.register_file_watcher("file:wt-1:a.txt", "fw".to_string());
    conn.retain_file_watcher("file:wt-1:a.txt");

    conn.cleanup().await;

    assert!(!conn.has_tree_watcher("tree:wt-1:"));
    assert!(!conn.has_file_watcher("file:wt-1:a.txt"));
}

// ---- subscription set ----

#[tokio::test]
async fn subscribe_unsubscribe_roundtrip() {
    let (_, handle) = FakeSink::new(0);
    let conn = WsConnection::new(handle);
    conn.subscribe(&["s1".to_string(), "s2".to_string()]);
    assert!(conn.is_subscribed_to("s1"));
    assert!(conn.is_subscribed_to("s2"));
    conn.unsubscribe(&["s1".to_string()]);
    assert!(!conn.is_subscribed_to("s1"));
    assert!(conn.is_subscribed_to("s2"));
    let subs = conn.subscriptions();
    assert_eq!(subs.len(), 1);
}
