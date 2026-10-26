//! The restart / rollback timing budget, in one place.
//!
//! **The budget.** After `POST /daemon/restart` the web overlay
//! (`web-ui/src/components/update/RestartOverlay.tsx`, `RESTART_WAIT_MS`) and
//! `vst daemon restart` wait [`UI_CLI_RESTART_WAIT`] for a new boot id. The
//! rollback watcher must reach its verdict, and a restored daemon must be able to
//! bind, before they give up:
//!
//! ```text
//! WATCH_PHASE_A_MAX + WATCH_PHASE_B + RESTART_LOCK_RETRY <= UI_CLI_RESTART_WAIT
//! ```
//!
//! The restart handoff file must also outlive the watcher
//! (`WATCH_PHASE_A_MAX + WATCH_PHASE_B < HANDOFF_TTL`), or a rollback after a
//! failed boot would find no auth to hand back. `watch.rs`'s
//! `timing_budget_holds` test asserts both, so retuning one constant cannot
//! silently break the rest.
//!
//! **Mirrors in other languages** (no codegen; `tests/update_ui_mirrors.rs`
//! fails if they drift): `RESTART_WAIT_MS` in `RestartOverlay.tsx` =
//! [`UI_CLI_RESTART_WAIT`]; `FORCE_FLOOR_MS` in `UpdateSetting.tsx` =
//! `service::FORCE_FLOOR`.

use std::time::Duration;

use crate::lock::LockWait;

/// What the web overlay and `vst daemon restart` wait for a new boot id.
pub const UI_CLI_RESTART_WAIT: Duration = Duration::from_secs(75);

// ── Old daemon, on its way out ──────────────────────────────────────────────

/// Let the 202 and the `daemon:restarting` broadcast reach clients before the
/// drain and exec start.
pub const RESTART_FLUSH_DELAY: Duration = Duration::from_millis(300);

// ── Successor boot ──────────────────────────────────────────────────────────

/// Poll spacing for the successor's lock and bind retries.
pub const RESTART_RETRY_INTERVAL: Duration = Duration::from_millis(250);
/// The successor waits this long for the old daemon to release `.daemon.lock`.
pub const RESTART_LOCK_RETRY: Duration = Duration::from_secs(15);
/// ...and for the old daemon's listener to free the port.
pub const RESTART_BIND_RETRY: Duration = Duration::from_secs(15);
/// How often the successor checks that it is serving before deleting the handoff.
pub const HANDOFF_DELETE_POLL: Duration = Duration::from_millis(250);
/// Stop waiting after this long; the TTL then reaps the file.
pub const HANDOFF_DELETE_GIVE_UP: Duration = Duration::from_secs(60);
/// A handoff file is valid this long (it must outlive the watcher, see above).
pub const HANDOFF_TTL: Duration = Duration::from_secs(120);

// ── Rollback watcher ────────────────────────────────────────────────────────

/// Phase A: how long the old daemon may keep serving its old boot id (a drain
/// that outlasts this hung; nothing was replaced, so no rollback).
pub const WATCH_PHASE_A_MAX: Duration = Duration::from_secs(15);
/// Phase B: how long the successor gets to serve a new boot id (its boot
/// budget; the UI/CLI waits are sized from it).
pub const WATCH_PHASE_B: Duration = Duration::from_secs(30);
/// `/health` poll spacing and per-request timeout in both phases.
pub const WATCH_POLL: Duration = Duration::from_millis(500);
/// The killed `--pid`'s flock is released by the kernel shortly after SIGKILL.
pub const WATCH_DAEMON_LOCK_WAIT: LockWait = LockWait {
    attempts: 30,
    interval: Duration::from_millis(100),
};
/// An install or the CLI fallback may hold `.update.lock`; give it a moment,
/// then skip the state write rather than race the holder.
pub const WATCH_UPDATE_LOCK_WAIT: LockWait = LockWait {
    attempts: 15,
    interval: Duration::from_millis(200),
};
