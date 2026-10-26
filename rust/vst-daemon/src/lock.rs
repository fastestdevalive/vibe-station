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
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};

/// How long to keep trying a contended lock: `attempts` tries `interval` apart.
/// Every lock in the daemon, the update feature and the CLI is taken through
/// [`try_lock`], so each retry policy is a named `LockWait` with its reason at
/// the definition (see `update/timing.rs`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LockWait {
    pub attempts: u32,
    pub interval: Duration,
}

impl LockWait {
    /// One try, no waiting.
    pub const NONE: LockWait = LockWait {
        attempts: 1,
        interval: Duration::ZERO,
    };

    /// Enough `interval`-spaced tries to cover `total` (a zero `total` is [`Self::NONE`]).
    pub fn covering(total: Duration, interval: Duration) -> LockWait {
        if total.is_zero() || interval.is_zero() {
            return LockWait::NONE;
        }
        let tries = total.as_millis().div_ceil(interval.as_millis()) as u32;
        LockWait {
            attempts: tries.saturating_add(1),
            interval,
        }
    }
}

/// Open `path` (creating it and its parent directory, never truncating) and
/// take an exclusive `flock` on it, retrying per `wait`. Blocking.
///
/// `Ok(None)` = another process still holds it. The returned `File` IS the
/// lock: the caller must keep it alive for as long as the lock is needed.
pub fn try_lock(path: &Path, wait: LockWait) -> std::io::Result<Option<File>> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Explicitly NOT truncating at open time: acquire the flock FIRST, so a
    // losing racer never destroys the winner's content (see `acquire_lock`).
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    Ok(vst_proc::try_lock_with_retry(&file, wait.attempts, wait.interval)?.then_some(file))
}

/// [`try_lock`] on the blocking pool, for async callers.
pub async fn try_lock_async(path: PathBuf, wait: LockWait) -> std::io::Result<Option<File>> {
    tokio::task::spawn_blocking(move || try_lock(&path, wait))
        .await
        .map_err(std::io::Error::other)?
}

/// Acquire `~/.vibe-station/.daemon.lock`.
///
/// Returns the open `File` holding the lock — the caller MUST keep it alive
/// for as long as the daemon runs; dropping it (or process exit) releases
/// the lock immediately. If another live process already holds the lock,
/// bails with a human-readable message.
pub async fn acquire_lock(lock_path: &PathBuf) -> Result<File> {
    acquire_lock_with_retry(lock_path, Duration::ZERO).await
}

/// [`acquire_lock`], retrying contention every 250 ms up to `total`. Used
/// during a planned restart handoff where the old daemon is releasing the lock
/// concurrently.
pub async fn acquire_lock_with_retry(lock_path: &PathBuf, total: Duration) -> Result<File> {
    let wait = LockWait::covering(total, crate::update::timing::RESTART_RETRY_INTERVAL);
    let mut file = match try_lock_async(lock_path.clone(), wait)
        .await
        .context("flock lock file")?
    {
        Some(f) => f,
        None if total.is_zero() => bail!(
            "Daemon is already running. \
             Use `vst daemon stop` first."
        ),
        None => bail!(
            "Daemon is already running. \
             Timed out waiting for lock release after {}s.",
            total.as_secs()
        ),
    };
    // Truncate before writing (after winning the lock): a pre-existing file's
    // old PID content may be longer than the new one, which would otherwise
    // leave trailing garbage. The PID is for human debugging only
    // (`cat ~/.vibe-station/.daemon.lock`); the flock is the sole source of truth.
    file.set_len(0).context("truncate lock file")?;
    file.write_all(std::process::id().to_string().as_bytes())
        .context("write pid to lock file")?;
    file.flush().context("flush lock file")?;
    Ok(file)
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

    #[tokio::test]
    async fn retry_times_out_while_held_and_succeeds_after_release() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".daemon.lock");
        let held = acquire_lock(&path).await.unwrap();
        let err = acquire_lock_with_retry(&path, Duration::from_millis(300))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("Timed out waiting"));
        release_lock(held).await;
        acquire_lock_with_retry(&path, Duration::from_millis(300))
            .await
            .unwrap();
    }

    #[test]
    fn lock_wait_covers_the_total() {
        let w = LockWait::covering(Duration::from_secs(15), Duration::from_millis(250));
        assert_eq!(w.attempts, 61);
        assert_eq!(
            LockWait::covering(Duration::ZERO, Duration::from_millis(250)),
            LockWait::NONE
        );
    }
}
