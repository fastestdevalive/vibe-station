#![forbid(unsafe_code)]
//! `vst-lifecycle` — session lifecycle + PR-status pollers, subagent notify,
//! channel/manifest helpers, GitHub auth/API, tunnel management.
//!
//! Two-axis status model (Gotcha #3):
//!   - `lifecycle.state` is written **only** by `lifecycle.rs` (1s poller).
//!     Its setter is fully private — no other module can call it.
//!   - `pr` is written **only** by `pr_poller.rs` (30s poller).
//!     Its setter is fully private.
//!
//! A `trybuild` compile-fail fixture (`tests/compile_fail/`) proves that
//! cross-writes are impossible at the type level.

pub mod channel;
pub mod cloudflared;
pub mod github;
pub mod github_auth;
pub mod handoff;
pub mod lifecycle;
pub mod manifest;
pub mod mutex;
pub mod pr_poller;
pub mod subagent_notify;
pub mod tailscale_serve;
pub mod tool_result_cap;
pub(crate) mod util;
