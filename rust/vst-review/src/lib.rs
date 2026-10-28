//! Terminal delivery for scheduled messages (and, later, review comments).
//!
//! Tier: beside `vst-git`/`vst-activity` — depends only on `vst-types`,
//! `vst-store` and `vst-proc`. It is CLI-agnostic: anything that differs per
//! agent CLI is injected by the daemon (`run.rs`) as closures, never imported
//! from `vst-agents`.
//!
//! - [`TerminalDeliveryHandle`] owns delivery: jobs, the per-session FIFO, the
//!   `deliveryPhase` writes and the [`OutcomeObserver`] calls.
//! - [`ReadyGate`] decides when a pane is provably at its prompt.
//! - [`sanitize_paste_text`] strips everything a terminal could interpret.
//! - [`PaneIo`] is the tmux surface a job uses ([`vst_proc::tmux::Tmux`] implements it).

mod clock;
pub mod delivery;
pub mod pane_io;
pub mod probe;
pub mod sanitize;

pub use delivery::{
    BoxFuture, NotifyScheduled, OutcomeObserver, PasteBody, TargetResolver, TerminalDeliveryHandle,
    TerminalTarget, JOB_TIMEOUT, MAX_PASTE_BYTES, POLL_INTERVAL, PROBE_TIMEOUT,
};
pub use pane_io::PaneIo;
pub use probe::{pane_hash, PostEnterGuard, ReadyGate, MIN_GAP_AFTER_ENTER, READY_POLLS};
pub use sanitize::sanitize_paste_text;
