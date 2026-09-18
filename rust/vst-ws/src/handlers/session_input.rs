//! `session:input` handler — forward client keystrokes to the session.

use vst_store::StoreHandle;
use vst_types::ws::{ClientMessage, ServerMessage, SessionErrorReason};

use crate::connection::WsConnection;

/// Forward client keystrokes to the session.
///
/// Tmux mode: prefer writing through the open `tmux attach-session` PTY so
/// tmux's input parser sees the bytes and can react to the prefix key; fall
/// back to `tmux send-keys -l` if no stream is registered (mid attach/detach).
///
/// Direct-pty mode: write to the open stream's PTY; drop silently if none.
pub async fn handle_session_input(conn: &WsConnection, store: &StoreHandle, msg: &ClientMessage) {
    let ClientMessage::SessionInput { session_id, data } = msg else {
        return;
    };
    if data.is_empty() {
        return;
    }

    let Some((_project, session)) = store.find_session(session_id).await else {
        conn.send(ServerMessage::SessionError {
            session_id: session_id.clone(),
            message: format!("Session '{session_id}' not found"),
            reason: Some(SessionErrorReason::Gone),
        });
        return;
    };

    let entry = conn.open_stream_entry(session_id);

    if session.use_tmux {
        // `is_attached()` matters as much as the entry existing: `session:open`
        // registers the entry BEFORE `attach()` sets up the PTY, so in that
        // window `stream.write()` has no `master` to write to and drops the
        // keystroke silently — with the entry present, the `send-keys` fallback
        // below was unreachable. Per-session dispatch ordering means a
        // `session:input` can legitimately land there (the client fires
        // keystrokes as soon as the pane has focus, without waiting for
        // `session:opened`), so treat "registered but not attached yet" exactly
        // like "no stream": send the bytes to the tmux session directly.
        if let Some(entry) = entry.filter(|e| e.stream.is_attached()) {
            entry.stream.write(data);
            return;
        }
        // No usable stream — fall back to `tmux send-keys -l`. `data` is passed
        // straight through as a single argv element to `Command::args`
        // (no shell involved), so it must NOT be shell-escaped here. The
        // `'\\''`-escaping below was carried over from the TS original
        // (`daemon/src/ws/handlers/sessionInput.ts`), which needed it
        // because it built a string for `execSync("tmux send-keys ... '...'")`.
        // Applying that same escaping to an argv element corrupts every
        // literal `'` the user types (e.g. while responding to an agent's
        // permission prompt) into four literal characters.
        match run_tmux(conn, &["send-keys", "-t", &session.tmux_name, "-l", data]) {
            Ok(()) => {}
            Err(msg) => {
                conn.send(ServerMessage::SessionError {
                    session_id: session_id.clone(),
                    message: msg,
                    reason: Some(SessionErrorReason::Transient),
                });
            }
        }
        return;
    }

    // Direct-pty mode.
    if let Some(entry) = entry {
        entry.stream.write(data);
    }
}

fn run_tmux(_conn: &WsConnection, args: &[&str]) -> Result<(), String> {
    let out = std::process::Command::new("tmux")
        .args(args)
        .output()
        .map_err(|e| format!("Failed to send input: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}
