//! `session:resize` handler — resize the session's PTY to match the client.

use vst_types::ws::ClientMessage;

use super::session_lookup::{find_session_record, SessionLookup};
use crate::connection::WsConnection;

/// Resize the session's PTY to match the client viewport.
///
/// Tmux mode: update BOTH the tmux pane and the `tmux attach-session` PTY's
/// terminal size. When no stream is registered (mid attach/detach) we still
/// apply `tmux resize-window` so the next attach starts at the correct size.
///
/// Direct-pty mode: resize the open stream's PTY; dropped if none.
pub async fn handle_session_resize(
    conn: &WsConnection,
    lookup: &SessionLookup,
    msg: &ClientMessage,
) {
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

    let Some((_project, session)) = find_session_record(lookup, session_id).await else {
        return;
    };

    let entry = conn.open_stream_entry(session_id);

    if session.use_tmux {
        if let Some(entry) = entry {
            entry.stream.resize(cols, rows, Some(&entry.subscriber_id));
        } else {
            let _ = std::process::Command::new("tmux")
                .args([
                    "resize-window",
                    "-t",
                    &session.tmux_name,
                    "-x",
                    &cols.to_string(),
                    "-y",
                    &rows.to_string(),
                ])
                .output();
        }
        return;
    }

    // Direct-pty mode.
    if let Some(entry) = entry {
        entry.stream.resize(cols, rows, Some(&entry.subscriber_id));
    }
}
