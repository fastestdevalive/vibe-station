#![forbid(unsafe_code)]

//! Daemon lock-file management — race-free singleton guarantee via `flock(2)`.
//!
//! Previously checked PID liveness via `/proc/<pid>`, which always reports
//! "dead" on macOS (no `/proc` there) — a live macOS daemon looked dead to
//! its own lock, letting a second one start and clobber `config.json`. An
//! `flock`-based lock is race-free by construction (the OS, not a PID string
//! we'd have to read-then-write, is the source of truth on "is this held")
//! and immune to PID reuse (a lock is tied to an open file description, not
//! a PID value stored inside the file).

use std::fs::File;
use std::io::Write;
use std::path::PathBuf;

use anyhow::{bail, Context, Result};

/// Acquire `~/.vibe-station/.daemon.lock`.
///
/// Returns the open `File` holding the lock — the caller MUST keep it alive
/// for as long as the daemon runs; dropping it (or process exit) releases
/// the lock immediately. If another live process already holds the lock,
/// bails with a human-readable message.
pub async fn acquire_lock(lock_path: &PathBuf) -> Result<File> {
    if let Some(parent) = lock_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .context("create ~/.vibe-station")?;
    }

    let lock_path = lock_path.clone();
    tokio::task::spawn_blocking(move || -> Result<File> {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            // Explicitly NOT truncating at open time — clippy's own
            // suggested fix here (.truncate(true)) would be a real bug: we
            // must acquire the flock FIRST and only truncate afterward (see
            // the set_len(0) call below), so a losing racer never destroys
            // the winner's file content before even knowing whether it won.
            .truncate(false)
            .write(true)
            .open(&lock_path)
            .context("open lock file")?;

        match vst_proc::try_lock_exclusive(&file) {
            Ok(true) => {}
            Ok(false) => {
                bail!(
                    "Daemon is already running. \
                     Use `vst daemon stop` first."
                );
            }
            Err(e) => return Err(e).context("flock lock file"),
        }

        // Truncate before writing: a pre-existing file's old PID content may
        // be longer than the new one, which would otherwise leave trailing
        // garbage bytes behind. The PID written here is for human debugging
        // only (e.g. `cat ~/.vibe-station/.daemon.lock`) — nothing re-reads
        // it for correctness; the flock itself is the sole source of truth.
        file.set_len(0).context("truncate lock file")?;
        let pid_str = std::process::id().to_string();
        file.write_all(pid_str.as_bytes())
            .context("write pid to lock file")?;
        file.flush().context("flush lock file")?;

        Ok(file)
    })
    .await
    .context("spawn_blocking acquire_lock")?
}

/// No-op — releasing the lock is `acquire_lock`'s returned `File` being
/// dropped (or the process exiting), which the kernel turns into an
/// automatic `flock` release. Kept as an explicit call for symmetry with the
/// SIGINT/SIGTERM shutdown sequence's other cleanup steps.
///
/// MUST NEVER delete the lock file: unlinking it while a lock might still
/// conceivably be held would let a new process `create`+lock a *different*
/// file at the same path, while the original (still open, still locked, just
/// unlinked) inode's lock is held by a process that hasn't exited yet — the
/// two would never contend, silently reintroducing the exact bug this module
/// exists to fix.
pub async fn release_lock(_file: File) {
    // Dropping `_file` here releases the flock. No filesystem mutation.
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn acquire_lock_creates_file_with_current_pid() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".daemon.lock");
        let file = acquire_lock(&path).await.unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, std::process::id().to_string());
        release_lock(file).await;
        // File must still exist after release — release_lock never unlinks.
        assert!(path.exists());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
    }

    #[tokio::test]
    async fn acquire_lock_creates_parent_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("dir").join(".daemon.lock");
        let file = acquire_lock(&path).await.unwrap();
        assert!(path.exists());
        release_lock(file).await;
    }

    #[tokio::test]
    async fn acquire_lock_rejects_when_flock_held() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".daemon.lock");
        let _held = acquire_lock(&path).await.unwrap();

        let result = acquire_lock(&path).await;
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Daemon is already running"));
    }

    #[tokio::test]
    async fn acquire_lock_overwrites_a_stale_unheld_lock_file() {
        // Simulates upgrading from an old-format lock file (or a lock file
        // left behind by a process that has since exited, releasing its
        // flock along with it): the file exists on disk with a bogus/old PID
        // string, but nothing holds a flock on it.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".daemon.lock");
        std::fs::write(&path, "999999").unwrap();

        let file = acquire_lock(&path).await.unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, std::process::id().to_string());
        release_lock(file).await;
    }
}
