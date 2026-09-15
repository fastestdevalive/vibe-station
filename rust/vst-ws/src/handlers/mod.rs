//! WebSocket message handlers.
//!
//! Ports `daemon/src/ws/handlers/*`. Each handler is a free function taking a
//! `WsConnection` (+ any dependencies it needs), mirroring the TS handler
//! shape. `session:open`/`session:close` wrap their bodies in
//! `WsConnection::with_session_lock` (Gotcha #1) — the entire body, including
//! the `await stream.attach` park point, stays inside the lock.

pub mod chat_open;
pub mod debug_log;
pub mod file_unwatch;
pub mod file_watch;
pub mod ping;
pub mod session_close;
pub mod session_input;
pub mod session_lookup;
pub mod session_open;
pub mod session_resize;
pub mod subscribe;
pub mod tree_unwatch;
pub mod tree_watch;
