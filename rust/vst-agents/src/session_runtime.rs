//! Session runtime teardown — ports `services/sessionRuntime.ts`.
//!
//! `release_session_runtime` frees every LIVE runtime resource a session holds
//! without touching anything persisted (transcript, manifest, worktree).
//!
//! Freed here:
//! - the `JsonAgentSession` (in-flight turn process group, queue, SQLite WAL
//!   handle, stream listeners) and its registry entry
//! - the tmux pane (and with it the agent CLI's whole process tree) or, for
//!   `use_tmux: false`, the direct-pty child
//! - the lifecycle poller's idle-hash entry (via `on_clear_idle` callback)
//!
//! NOT touched (session stays resumable):
//! - `SessionRecord` in the manifest
//! - session data dir (system prompt, JSON transcript SQLite file)
//! - staged attachments unless `ReleaseOpts::clear_attachments` is set

use std::sync::Arc;

use vst_git::DirectPtyRegistry;
use vst_types::domain::SessionRecord;

use crate::json_agent_registry::JsonAgentRegistry;

// ---------------------------------------------------------------------------
// Public traits for dependency injection / testability
// ---------------------------------------------------------------------------

/// Tmux operations needed by release — injected so tests can provide mocks.
pub trait TmuxSessionOps: Send + Sync {
    fn kill_session(&self, name: &str);
    fn has_session(&self, name: &str) -> bool;
}

/// A session handle that can be released — the minimal interface from
/// `JsonAgentSession` that `release_session_runtime` needs.
pub trait Releasable: Send + Sync {
    fn release(&self) -> impl std::future::Future<Output = ()> + Send;
}

// ---------------------------------------------------------------------------
// Production impl: wrap sync Tmux calls in spawn_blocking
// ---------------------------------------------------------------------------

impl TmuxSessionOps for vst_proc::tmux::Tmux {
    fn kill_session(&self, name: &str) {
        // Inherent method; `self.kill_session()` here is NOT recursive — Rust
        // resolves inherent methods before trait methods inside a trait impl.
        <vst_proc::tmux::Tmux>::kill_session(self, name);
    }

    fn has_session(&self, name: &str) -> bool {
        <vst_proc::tmux::Tmux>::has_session(self, name)
    }
}

// ---------------------------------------------------------------------------
// Production impl: JsonAgentSession
// ---------------------------------------------------------------------------

impl Releasable for crate::json_agent_session::JsonAgentSession {
    fn release(&self) -> impl std::future::Future<Output = ()> + Send {
        crate::json_agent_session::JsonAgentSession::release(self)
    }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
pub struct ReleaseOpts {
    pub clear_attachments: bool,
}

/// Callbacks injected into the release path. Bundled into one struct so
/// `release_session_runtime_with_warn` stays within clippy's argument limit.
pub struct ReleaseCallbacks {
    pub on_clear_idle: Arc<dyn Fn(&str) + Send + Sync>,
    pub on_clear_attachments: Arc<dyn Fn(&str) + Send + Sync>,
    /// Receives the warning text when a tmux session survives two kill attempts.
    pub on_warn: Arc<dyn Fn(&str) + Send + Sync>,
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/// Release all live runtime resources for `session`.
///
/// Uses a default warn callback (`eprintln!`). For tests that need to capture
/// warnings, build `ReleaseCallbacks` explicitly and call
/// `release_session_runtime_with_warn`.
pub async fn release_session_runtime<R: Releasable>(
    session: &SessionRecord,
    opts: ReleaseOpts,
    json_registry: &JsonAgentRegistry<R>,
    direct_pty: &DirectPtyRegistry,
    tmux: &(impl TmuxSessionOps + ?Sized),
    on_clear_idle: Arc<dyn Fn(&str) + Send + Sync>,
    on_clear_attachments: Arc<dyn Fn(&str) + Send + Sync>,
) {
    let cbs = ReleaseCallbacks {
        on_clear_idle,
        on_clear_attachments,
        on_warn: Arc::new(|msg: &str| eprintln!("{msg}")),
    };
    release_session_runtime_with_warn(session, opts, json_registry, direct_pty, tmux, cbs).await;
}

/// Same as `release_session_runtime` but with fully injectable callbacks.
/// Used by tests that need to capture the warning message.
pub async fn release_session_runtime_with_warn<R: Releasable>(
    session: &SessionRecord,
    opts: ReleaseOpts,
    json_registry: &JsonAgentRegistry<R>,
    direct_pty: &DirectPtyRegistry,
    tmux: &(impl TmuxSessionOps + ?Sized),
    cbs: ReleaseCallbacks,
) {
    // Unregister BEFORE releasing so a concurrent request can't hand out a
    // handle that is mid-teardown; `release()` is idempotent either way.
    let agent = json_registry.remove(&session.id);
    // Awaited: `release()` latches the session against late writes, kills the
    // turn's process group, and closes SQLite. Without the await the drain's
    // trailing lifecycle persist could land after the caller writes `done`.
    if let Some(a) = agent {
        a.release().await;
    }

    if opts.clear_attachments {
        (cbs.on_clear_attachments)(&session.id);
    }

    if !session.use_tmux {
        // Direct-pty (json sessions are always `use_tmux: false` — any entry in
        // the direct-pty registry is a non-json terminal session or test double).
        if let Some(pty) = direct_pty.get(&session.id) {
            pty.kill();
        }
    } else {
        tmux.kill_session(&session.tmux_name);
        if tmux.has_session(&session.tmux_name) {
            // First kill-session didn't take — try exactly once more.
            tmux.kill_session(&session.tmux_name);
            if tmux.has_session(&session.tmux_name) {
                (cbs.on_warn)(&format!(
                    "[sessionRuntime] tmux session '{}' (session {}) survived two \
                     kill-session attempts — it may still be running.",
                    session.tmux_name, session.id
                ));
            }
        }
    }

    // Always clear the lifecycle poller's idle-hash entry.
    (cbs.on_clear_idle)(&session.id);
}
