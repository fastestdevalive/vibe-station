#![forbid(unsafe_code)]
//! `vst-types` — the daemon-rust-port wire contract crate.
//!
//! Owns **all** of the wire: the domain types (mirrors `daemon/src/types.ts`),
//! the WebSocket protocol (`daemon/src/ws/protocol.ts`), every REST
//! request/response shape (`daemon/src/routes/*.ts` zod schemas + handler
//! response literals), and the `events::{ServerEvent, Broadcaster}` cycle
//! breaker. Later crates (`vst-routes`, `vst-ws`, `vst-cli`) never define their
//! own `#[derive(Serialize, Deserialize)]` shapes — they use these, or follow
//! the `vst-types` amendment rule (addition-only + a wire-fixture update).
//!
//! See `.vibekit/feature-plans/pending/daemon-rust-port/arch-daemon-rust-port.md`
//! § vst-types owns the wire, all of it.

pub mod domain;
pub mod events;
pub mod rest;
pub mod serde_ext;
pub mod ws;

pub use domain::*;
pub use events::{Broadcaster, ServerEvent};
pub use ws::*;
