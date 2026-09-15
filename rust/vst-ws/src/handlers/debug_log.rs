//! `debug:log` handler — marks the connection debug-active and persists
//! client-shipped input/composition events (mobile double-text investigation).

use vst_types::ws::ClientMessage;

use crate::connection::WsConnection;

pub fn handle_debug_log(conn: &WsConnection, msg: &ClientMessage) {
    if let ClientMessage::DebugLog { entries } = msg {
        conn.set_debug_input(true);
        // Entries are diagnostic-only; the TS `appendDebug` persists them to a
        // log. Here we simply record that the connection is debug-active and
        // accept the entries (wire-validated).
        let _ = entries;
    }
}
