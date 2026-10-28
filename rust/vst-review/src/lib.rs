//! Terminal delivery for scheduled messages, and the review-comments owner.
//!
//! Tier: beside `vst-git`/`vst-activity` — depends on `vst-types`, `vst-store`,
//! `vst-proc`, `vst-git`, `vst-fswatch` and `vst-artifacts` (never `vst-agents`, `vst-routes`).
//! It is CLI-agnostic: anything that differs per agent CLI is injected by the
//! daemon (`run.rs`) as closures, never imported from `vst-agents`.
//!
//! - [`ReviewHandle`] owns review comments: CRUD, attach leases, Copy as text and
//!   the coalesced `comments:changed` events.
//! - [`TerminalDeliveryHandle`] owns delivery: jobs, the per-session FIFO, the
//!   `deliveryPhase` writes and the [`OutcomeObserver`] calls.
//! - [`ReadyGate`] decides when a pane is provably at its prompt.
//! - [`sanitize_paste_text`] strips everything a terminal could interpret.
//! - [`PaneIo`] is the tmux surface a job uses ([`vst_proc::tmux::Tmux`] implements it).

pub mod anchor;
pub mod boot;
mod clock;
pub mod delivery;
pub mod holds;
pub mod md_plain;
pub mod pane_io;
pub mod probe;
mod reanchor;
pub mod sanitize;
pub mod schedule;
pub mod service;
pub mod terminal;
pub mod terminal_text;

pub use boot::{BootReport, TranscriptReader};
pub use delivery::{
    is_delivery_row, BoxFuture, NotifyScheduled, OutcomeObserver, PasteBody, RowCapture,
    TargetResolver, TerminalDeliveryHandle, TerminalTarget, JOB_TIMEOUT, MAX_PASTE_BYTES,
    POLL_INTERVAL, PROBE_TIMEOUT,
};
pub use holds::{hooks, persisted_review, CardRestoreError, RestoredFromCard};
pub use pane_io::PaneIo;
pub use probe::{pane_hash, PostEnterGuard, ReadyGate, MIN_GAP_AFTER_ENTER, READY_POLLS};
pub use reanchor::{Dirty, REANCHOR_DEBOUNCE, REANCHOR_MAX_WAIT};
pub use sanitize::sanitize_paste_text;
pub use service::{
    CommentList, NowSecs, ReviewHandle, EVENT_COALESCE, LEASE_SECS, LEASE_SWEEP_INTERVAL,
};
pub use terminal::{restore_reason, review_paste_body, TerminalError, TerminalWiring};
pub use terminal_text::{
    check_terminal_text, held_snapshot, validate_terminal_schedule, TerminalTextError,
    MAX_TERMINAL_MESSAGE_BYTES,
};
