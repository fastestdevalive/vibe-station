//! Error types for `vst-proc`.
//!
//! `ProcError` is the crate's public error enum (thiserror). The two binary
//! crates may wrap it in `anyhow` at their edges; library callers match on the
//! variants below rather than a bare `String`.

/// Errors surfaced by the process/PTY layer.
#[derive(Debug, thiserror::Error)]
pub enum ProcError {
    #[error("pty spawn failed: {0}")]
    Pty(#[from] anyhow::Error),
    #[error("tmux error: {0}")]
    Tmux(#[from] TmuxError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// A `tmux` command failure. Carries the offending argv (joined) and stderr so
/// callers can classify the failure (e.g. "no server running" vs an
/// uninterpretable error) without re-parsing raw process output.
#[derive(Debug, thiserror::Error)]
#[error("tmux {args} failed: {stderr}")]
pub struct TmuxError {
    /// The argv that was passed to `tmux`, space-joined (diagnostic only).
    pub args: String,
    /// The trimmed stderr from the failed `tmux` invocation.
    pub stderr: String,
}

impl TmuxError {
    /// The stderr text, for regex/classification-style checks.
    pub fn stderr(&self) -> &str {
        &self.stderr
    }
}
