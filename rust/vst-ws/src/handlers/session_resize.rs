//! `session:resize` handler — resize the session's PTY to match the client.

use vst_store::StoreHandle;
use vst_types::ws::ClientMessage;

use crate::connection::WsConnection;

/// Resize the session's PTY to match the client viewport.
///
/// Tmux mode: update BOTH the tmux pane and the `tmux attach-session` PTY's
/// terminal size. When no stream is registered (mid attach/detach) we still
/// apply `tmux resize-window` so the next attach starts at the correct size.
///
/// Direct-pty mode: resize the open stream's PTY; dropped if none.
pub async fn handle_session_resize(conn: &WsConnection, store: &StoreHandle, msg: &ClientMessage) {
    let ClientMessage::SessionResize {
        session_id,
        cols,
        rows,
    } = msg
    else {
        return;
    };
    let cols = *cols;
    let rows = *rows;

    let Some((_project, session)) = store.find_session(session_id).await else {
        return;
    };

    let entry = conn.open_stream_entry(session_id);

    if session.use_tmux {
        if let Some(entry) = entry {
            entry
                .stream
                .resize(cols, rows, Some(&entry.subscriber_id))
                .await;
        } else {
            // `tokio::process`, not `std::process`: a synchronous subprocess
            // round-trip here pins a shared tokio worker thread, and a worktree
            // switch fires one resize per mounted terminal at once. Awaited (not
            // fire-and-forget) so rapid resizes still apply in order.
            let _ = tokio::process::Command::new("tmux")
                .args([
                    "resize-window",
                    "-t",
                    &session.tmux_name,
                    "-x",
                    &cols.to_string(),
                    "-y",
                    &rows.to_string(),
                ])
                .output()
                .await;
        }
        return;
    }

    // Direct-pty mode.
    if let Some(entry) = entry {
        entry
            .stream
            .resize(cols, rows, Some(&entry.subscriber_id))
            .await;
    }
}
