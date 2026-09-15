//! `ping` handler: reply with `pong`.

use vst_types::ws::ServerMessage;

use crate::connection::WsConnection;

pub fn handle_ping(conn: &WsConnection) {
    conn.send(ServerMessage::Pong);
}
