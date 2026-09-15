//! Session handoff — ports `services/handoff.ts`.
//!
//! Behavior contract:
//! - Returns `false` immediately for `json`-channel sessions.
//! - Deletes a stale handoff file before delivering the instruction.
//! - Delivers instruction via tmux paste-buffer (tmux channel) or direct PTY
//!   write (pty channel).
//! - Polls for file existence after delivery.

use std::path::Path;
use std::time::Duration;

use thiserror::Error;
use vst_proc::tmux::Tmux;
use vst_types::domain::Channel;

#[derive(Debug, Error)]
pub enum HandoffError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("handoff timed out")]
    Timeout,
}

pub type HandoffResult<T> = Result<T, HandoffError>;

const POLL_INTERVAL_MS: u64 = 100;
const TIMEOUT_MS: u64 = 30_000;

/// Attempt to deliver a handoff instruction to a session.
/// Returns `false` for json-channel sessions (not applicable).
pub async fn run_handoff_turn(
    tmux_name: &str,
    channel: Channel,
    instruction_path: &Path,
    instruction: &str,
) -> HandoffResult<bool> {
    if channel == Channel::Json {
        return Ok(false);
    }

    // Delete stale file first.
    if instruction_path.exists() {
        tokio::fs::remove_file(instruction_path).await?;
    }

    // Deliver the instruction.
    match channel {
        Channel::Tmux => {
            let tmux = Tmux::new();
            let target = tmux_name.to_string();
            let data = instruction.to_string();
            let buf_id = format!("handoff-{tmux_name}");
            tokio::task::spawn_blocking(move || tmux.paste_buffer(&target, &buf_id, &data))
                .await
                .map_err(|e| HandoffError::Io(std::io::Error::other(e.to_string())))?
                .map_err(|e| HandoffError::Io(std::io::Error::other(e.to_string())))?;
        }
        Channel::Pty => {
            // Direct PTY write — caller supplies the instruction content; the
            // polling side writes it via the PTY stream.  For now we write to
            // instruction_path for the PTY caller to pick up.
            tokio::fs::write(instruction_path, instruction).await?;
        }
        Channel::Json => unreachable!(),
    }

    // Poll for file existence (pty-channel acknowledgment pattern).
    let deadline = tokio::time::Instant::now() + Duration::from_millis(TIMEOUT_MS);
    loop {
        if instruction_path.exists() {
            return Ok(true);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(HandoffError::Timeout);
        }
        tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
    }
}

/// Read the handoff file if it exists, returning `None` if absent.
pub async fn read_handoff_file_or_null(path: &Path) -> HandoffResult<Option<String>> {
    match tokio::fs::read_to_string(path).await {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(HandoffError::Io(e)),
    }
}
