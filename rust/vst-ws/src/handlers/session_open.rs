//! `session:open` handler.
//!
//! Wraps its ENTIRE body — including the `await stream.attach` park point — in
//! `WsConnection::with_session_lock` (Gotcha #1). This is what prevents a
//! close-then-open remount from racing past the stale-stream check and spawning
//! two `tmux attach-session` clients (the orphaned one forwarding duplicate
//! output → double echo).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use vst_types::ws::{ClientMessage, ServerMessage, SessionErrorReason};

use super::session_lookup::{find_session_record, SessionLookup};
use crate::connection::{OpenStreamEntry, SessionStream, WsConnection};
use crate::streams::tmux_output::TmuxOutputStream;
use crate::Error;

/// Registry of live direct-PTY streams keyed by session id.
///
/// This is the `directPtyRegistry` equivalent. `vst-ws` owns the liveness
/// bookkeeping ("at most one live handle per key") here.
pub type DirectStreamRegistry = Arc<Mutex<HashMap<String, Arc<dyn SessionStream>>>>;

pub async fn handle_session_open(
    conn: &WsConnection,
    lookup: &SessionLookup,
    direct: &DirectStreamRegistry,
    msg: &ClientMessage,
) {
    let ClientMessage::SessionOpen {
        session_id,
        cols,
        rows,
    } = msg
    else {
        return;
    };
    let session_id = session_id.clone();
    let cols = *cols;
    let rows = *rows;
    let conn = conn.clone();
    let lookup = lookup.clone();
    let direct = direct.clone();

    let c = conn.clone();
    let sid = session_id.clone();
    conn.with_session_lock(&session_id, move || {
        let c = c.clone();
        let lookup = lookup.clone();
        let direct = direct.clone();
        let sid = sid.clone();
        async move { open_session_locked(&c, &lookup, &direct, &sid, cols, rows).await }
    })
    .await;
}

async fn open_session_locked(
    conn: &WsConnection,
    lookup: &SessionLookup,
    direct: &DirectStreamRegistry,
    session_id: &str,
    cols: i64,
    rows: i64,
) {
    // If a stale stream is still registered, tear it down so this open can
    // attach to the freshly-spawned pane.
    if let Some(entry) = conn.open_stream_entry(session_id) {
        let _ = entry.stream.detach(&entry.subscriber_id).await;
        conn.unregister_open_stream(session_id);
    }

    let Some((_project, session)) = find_session_record(lookup, session_id).await else {
        conn.send(ServerMessage::SessionError {
            session_id: session_id.to_string(),
            message: format!("Session '{session_id}' not found"),
            reason: Some(SessionErrorReason::Gone),
        });
        return;
    };

    let subscriber_id = format!("{}:{session_id}", conn.id());

    let stream: Arc<dyn SessionStream> = if session.use_tmux {
        Arc::new(TmuxOutputStream::new(session.tmux_name.clone(), None))
    } else {
        let existing = {
            let reg = direct.lock().unwrap();
            reg.get(session_id).cloned()
        };
        let Some(existing) = existing else {
            conn.send(ServerMessage::SessionError {
                session_id: session_id.to_string(),
                message: format!("Session '{session_id}' not running"),
                reason: Some(SessionErrorReason::Gone),
            });
            return;
        };
        existing
    };

    let mut chunk_rx = stream.on_chunk();
    let mut close_rx = stream.on_close();
    let mut opened_rx = stream.on_opened();
    let mut error_rx = stream.on_error();

    // Register the stream entry BEFORE spawning the event-forwarding tasks so a
    // follow-up open/close in the same connection finds it.
    let entry = OpenStreamEntry {
        kind: if session.use_tmux {
            "tmux".into()
        } else {
            "direct".into()
        },
        stream: stream.clone(),
        subscriber_id: subscriber_id.clone(),
    };
    conn.register_open_stream(session_id, entry);

    // Forward stream events to the connection.
    {
        let c = conn.clone();
        let sid = session_id.to_string();
        tokio::spawn(async move {
            use tokio::sync::broadcast::error::RecvError;
            loop {
                match chunk_rx.recv().await {
                    Ok(chunk) => {
                        c.send(ServerMessage::SessionOutput {
                            session_id: sid.clone(),
                            chunk,
                        });
                    }
                    // The receiver fell behind the sender — catch up and keep
                    // going. Without this, `while let Ok(...)` would treat
                    // Lagged as a break condition and silently kill forwarding.
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => break,
                }
            }
        });
    }
    {
        let c = conn.clone();
        let sid = session_id.to_string();
        tokio::spawn(async move {
            while opened_rx.recv().await.is_ok() {
                c.send(ServerMessage::SessionOpened {
                    session_id: sid.clone(),
                });
            }
        });
    }
    {
        let c = conn.clone();
        let sid = session_id.to_string();
        tokio::spawn(async move {
            while let Ok(err) = error_rx.recv().await {
                c.send(ServerMessage::SessionError {
                    session_id: sid.clone(),
                    message: err,
                    reason: Some(SessionErrorReason::Transient),
                });
            }
        });
    }
    {
        let c = conn.clone();
        let sid = session_id.to_string();
        // Captured for identity comparison below — `subscriber_id` is the
        // same string for every open of this session on this connection, so
        // it can't distinguish "this task's own stream generation" from a
        // newer one that has already replaced it in the registry. Only an
        // Arc-identity check on `stream` (this generation's own PTY handle)
        // tells the two apart. Without this, a stream that dies
        // asynchronously (PTY/tmux crash) racing a fresh session:open can
        // unregister the NEW live entry, orphaning its tmux attach client —
        // which stays subscribed and keeps echoing input, compounding into
        // multiplied keystrokes ("s" -> "ss" -> "sss") on repeated
        // close/open remounts (e.g. worktree switches).
        let this_stream = stream.clone();
        tokio::spawn(async move {
            while close_rx.recv().await.is_ok() {
                if let Some(entry) = c.open_stream_entry(&sid) {
                    if Arc::ptr_eq(&entry.stream, &this_stream) {
                        c.unregister_open_stream(&sid);
                    }
                }
            }
        });
    }

    // Start attachment — the park point INSIDE the session lock.
    if let Err(e) = stream.attach(cols, rows, &subscriber_id).await {
        // A stream that reports the session itself is gone is terminal: no
        // `session:opened` will ever follow, so it must be classified `gone`
        // (same as the not-running direct-pty branch above) rather than
        // `transient` — a transient error leaves the client's spawning overlay
        // waiting on an attach that can never happen. Everything else is a
        // stream hiccup and stays `transient`.
        let (message, reason) = match e {
            Error::SessionNotFound(message) => (message, SessionErrorReason::Gone),
            other => (other.to_string(), SessionErrorReason::Transient),
        };
        conn.send(ServerMessage::SessionError {
            session_id: session_id.to_string(),
            message,
            reason: Some(reason),
        });
    }
}
