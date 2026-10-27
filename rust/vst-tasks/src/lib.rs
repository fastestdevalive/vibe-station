#![forbid(unsafe_code)]
//! `vst-tasks` — the per-session background-task registry behind the task tray.
//!
//! One owner for: the task state machine, expiry, 1 s trailing coalescing of
//! change notifications, buffering of live observations while a rebuild from
//! the transcript is in flight, adapter-epoch staleness, file watchers and the
//! hardened output reader. It never inspects a CLI id: detection is injected
//! as an [`ObservationsFn`] (`AgentPlugin::task_observations` in `vst-agents`).
//!
//! Time model: every timestamp comes from event `ts` (never `now()`), and the
//! registry's own clock is `SystemTime` at construction advanced by tokio's
//! (pausable) clock, so paused-time tests are deterministic and a rebuild
//! yields exactly what live observation produced.

mod clock;
mod observation;
mod output;
mod registry;
mod task;
mod watch;

pub use clock::format_ms;
pub use observation::{ObservationsFn, TaskObservation};
pub use output::{default_roots, read_output_file, FileTail, OutputError};
pub use registry::{OnChange, TaskOutputError, TaskRegistry};

/// A command with no output growth / out-of-band activity for this long goes `Stale`.
pub const TASK_COMMAND_STALE_MS: i64 = 30 * 60 * 1000;
/// A background subagent with no nested activity for this long goes `Stale`.
pub const TASK_SUBAGENT_STALE_MS: i64 = 10 * 60 * 1000;
/// Terminal / stale rows are dropped this long after they ended / went stale.
pub const TASK_EXPIRY_MS: i64 = 60 * 60 * 1000;
/// Per-session task cap.
pub const MAX_TASKS: usize = 50;
/// Bounded `tool_id -> command` launch map.
pub const MAX_LAUNCHES: usize = 256;
/// Subagent nested-line ring size.
pub const MAX_RING_LINES: usize = 500;
/// Task label cap (chars).
pub const MAX_LABEL_CHARS: usize = 200;
/// Concurrent output-file watchers per session.
pub const MAX_WATCHERS: usize = 8;
/// Trailing coalesce window for change notifications.
pub const COALESCE_MS: u64 = 1_000;
/// Live observations buffered while a rebuild is in flight.
pub const MAX_PENDING_OPS: usize = 1_024;
/// Output tail cap (lines) for file output.
pub const MAX_TAIL_LINES: usize = 200;
/// Output tail cap (bytes) read from the end of the file.
pub const MAX_TAIL_BYTES: u64 = 256 * 1024;
/// Output read timeout.
pub const OUTPUT_READ_TIMEOUT_MS: u64 = 2_000;

pub(crate) const REASON_NO_END_SIGNAL: &str = "No end signal from the agent";
pub(crate) const REASON_RESTARTED: &str = "Agent restarted";
pub(crate) const REASON_TURN_ENDED: &str = "Turn ended";
