//! vst-ws — WebSocket transport layer for the vibe-station daemon.
//!
//! Ports (part `06-ws-realtime`, per `file-map.tsv`):
//! - `ws/connection.ts`           → [`connection`] (`WsConnection`)
//! - `ws/handlers/*`              → [`handlers`]
//! - `ws/streams/*`               → [`streams`] (except `jsonAgentStream`, already in `vst-agents`)
//! - `ws/server.ts`               → [`server`] (dispatcher + connection registry)
//! - `broadcaster.ts` (receiver side) → [`broadcaster`]
//! - `state/attachmentRegistry.ts`   → [`state`]
//! - `services/pendingFileOpens.ts`  → [`services`]
//! - `services/fileList.ts`          → [`services`]
//! - `services/ignoreFilter.ts`      → [`services`]
//!
//! ## Wire / event architecture
//!
//! The wire messages are `vst_types::ws::{ClientMessage, ServerMessage}` (part
//! 00). Internal daemon broadcasts are `vst_types::events::{ServerEvent,
//! Broadcaster}` (part 00). This crate owns the **receiver** side: it
//! subscribes to the `Broadcaster`, converts each `ServerEvent` to a
//! `ServerMessage`, and fans it out to the WS connections that care
//! (`[`broadcaster`]`).
//!
//! `vst-ws` is a transport **library**: it exposes the connection/handler/
//! stream/broadcaster logic. The actual socket transport (axum upgrade, auth,
//! ping frames, buffered-amount accounting) is plugged in via the [`WsSink`]
//! trait and wired together in `vst-daemon`.
//!
//! ## Concurrency invariant (Gotcha #1 / AGENTS.md § WebSocket)
//!
//! `session:open` and `session:close` for the same `(connection, sessionId)`
//! MUST be serialized, via [`WsConnection::with_session_lock`] — a **per-key**
//! `tokio::sync::Mutex`, deliberately not global. The entire handler body,
//! including the `await stream.attach` park point, lives inside the lock. This
//! is what prevents the double-echo / ghost-stream bug (two `tmux
//! attach-session` clients, the orphaned one forwarding duplicate output).

#![forbid(unsafe_code)]

pub mod broadcaster;
pub mod connection;
pub mod error;
pub mod handlers;
pub mod server;
pub mod services;
pub mod state;
pub mod streams;

pub use error::Error;
