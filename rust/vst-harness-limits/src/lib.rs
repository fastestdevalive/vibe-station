//! `vst-harness-limits` — the daemon's harness usage-limit scheduler.
//!
//! - Owns the limits cache, timers, and in-flight/backoff state (`LimitsHandle`).
//! - Pure policy (timings, backoff, turn-finished) lives in `policy`.
//! - Probe-result merge semantics live in `merge`.
//! - No `vst-agents` dependency edge: probes and the session→harness resolver
//!   are injected at construction in `vst-daemon`.

#![forbid(unsafe_code)]

pub mod handle;
pub mod merge;
pub mod policy;

pub use handle::*;
pub use policy::LimitsTiming;
