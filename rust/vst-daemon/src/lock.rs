#![forbid(unsafe_code)]

//! Daemon lock-file management — ports `acquireLock`/`releaseLock` from `daemon/src/main.ts`.

use std::path::PathBuf;

use anyhow::{bail, Context, Result};

/// Check whether a process with the given PID is currently alive.
///
/// Uses `/proc/<pid>` on Linux (no unsafe, no external crate).
fn pid_is_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    std::path::Path::new(&format!("/proc/{pid}")).exists()
}

/// Acquire `~/.vibe-station/.daemon.lock`.
///
/// Writes the current PID. If the file already exists the PID inside is
/// probed via `/proc/<pid>` — if the process is gone we take over the lock,
/// otherwise we bail with a human-readable message.
pub async fn acquire_lock(lock_path: &PathBuf) -> Result<()> {
    if let Some(parent) = lock_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .context("create ~/.vibe-station")?;
    }

    let pid_str = std::process::id().to_string();

    match tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(lock_path)
        .await
    {
        Ok(f) => {
            use tokio::io::AsyncWriteExt;
            let mut f = f;
            f.write_all(pid_str.as_bytes()).await?;
            return Ok(());
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // Fall through to stale-pid check.
        }
        Err(e) => return Err(e).context("open lock file"),
    }

    // Lock file exists — read the stored PID.
    let existing = tokio::fs::read_to_string(lock_path)
        .await
        .unwrap_or_default();
    let stored_pid: i32 = existing.trim().parse().unwrap_or(0);

    if stored_pid > 0 && pid_is_alive(stored_pid) {
        bail!(
            "Daemon is already running (pid {stored_pid}). \
             Use `vst daemon stop` first."
        );
    }

    // Process is gone — take over.
    tokio::fs::write(lock_path, &pid_str)
        .await
        .context("overwrite stale lock")?;
    Ok(())
}

pub async fn release_lock(lock_path: &PathBuf) {
    let _ = tokio::fs::remove_file(lock_path).await;
}
