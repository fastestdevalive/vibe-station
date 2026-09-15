//! Error types for `vst-ws`.

/// Errors surfaced by the WS transport layer.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A session stream operation failed (attach/detach/write/resize).
    #[error("stream error: {0}")]
    Stream(String),

    /// The session record could not be resolved.
    #[error("session not found: {0}")]
    SessionNotFound(String),

    /// The underlying process/PTY layer failed.
    #[error("proc error: {0}")]
    Proc(#[from] vst_proc::ProcError),

    /// A tmux command failed.
    #[error("tmux error: {0}")]
    Tmux(#[from] vst_proc::TmuxError),

    /// A chat/agent resolution failed.
    #[error("agent error: {0}")]
    Agent(String),
}
