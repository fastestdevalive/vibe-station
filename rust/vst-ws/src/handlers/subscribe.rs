//! `subscribe` / `unsubscribe` handlers.

use vst_types::ws::ClientMessage;

use crate::connection::WsConnection;

pub fn handle_subscribe(conn: &WsConnection, msg: &ClientMessage) {
    if let ClientMessage::Subscribe { session_ids } = msg {
        conn.subscribe(session_ids);
    }
}

pub fn handle_unsubscribe(conn: &WsConnection, msg: &ClientMessage) {
    if let ClientMessage::Unsubscribe { session_ids } = msg {
        conn.unsubscribe(session_ids);
    }
}
