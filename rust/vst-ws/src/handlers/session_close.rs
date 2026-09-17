//! `session:close` handler.
//!
//! Runs under `WsConnection::with_session_lock` (Gotcha #1) so a rapid
//! close+open sequence (e.g. a terminal pane remount) cannot interleave: the
//! open waits for the close to finish before attaching, preventing multiple
//! live tmux clients. Only unregisters the entry if it's still the same one we
//! captured.

use std::sync::Arc;

use vst_types::ws::ClientMessage;

use crate::connection::WsConnection;

pub async fn handle_session_close(conn: &WsConnection, msg: &ClientMessage) {
    let ClientMessage::SessionClose { session_id } = msg else {
        return;
    };
    let session_id = session_id.clone();
    let c = conn.clone();
    let sid = session_id.clone();
    let lock_conn = c.clone();

    lock_conn
        .with_session_lock(&session_id, move || {
            let c = c.clone();
            let sid = sid.clone();
            async move { close_session_locked(&c, &sid).await }
        })
        .await;
}

async fn close_session_locked(conn: &WsConnection, session_id: &str) {
    let Some(entry) = conn.open_stream_entry(session_id) else {
        return;
    };
    if let Err(e) = entry.stream.detach(&entry.subscriber_id).await {
        tracing::warn!("[WS] Error closing session {session_id}: {e}");
    }
    // Unregister only if it's still the same entry we captured. `subscriber_id`
    // is identical for every open of this session on this connection, so it
    // can never distinguish stream generations (same bug fixed in
    // session_open.rs's close-listener guard) — compare `Arc` identity of the
    // stream itself instead.
    if let Some(current) = conn.open_stream_entry(session_id) {
        if Arc::ptr_eq(&current.stream, &entry.stream) {
            conn.unregister_open_stream(session_id);
        }
    }
}
