//! A single, documented `unsafe` FFI boundary: take an OS-level advisory
//! exclusive lock on an open file, via `flock(2)`.
//!
//! Exists for `vst-daemon`'s own startup singleton lock
//! (`~/.vibe-station/.daemon.lock`), which used to check PID liveness via
//! `/proc/<pid>` — a check that always reports "dead" on macOS (no `/proc`
//! there), letting a second daemon start and clobber `config.json`. A
//! `kill(pid, 0)`-based fix would still race two concurrent starters (both
//! could observe "no live PID" before either writes) and would be fooled by
//! PID reuse. `flock` sidesteps both: the lock is associated with the open
//! file description held by the kernel, not with any PID string stored
//! inside the file, so it's race-free by construction and is automatically
//! released on process exit (including a crash) with no manual cleanup.

use std::fs::File;
use std::os::unix::io::AsRawFd;

/// Attempt to take an exclusive, non-blocking advisory lock on `file`.
///
/// Returns `Ok(true)` if the lock was acquired, `Ok(false)` if another
/// process already holds it (`EWOULDBLOCK`), `Err` for any other failure.
///
/// The lock is held for as long as `file` (or any `File` referring to the
/// same open file description, e.g. via `try_clone()`) stays open — the
/// caller MUST keep `file` alive for as long as the lock should be held;
/// dropping it releases the lock immediately.
#[allow(unsafe_code)]
pub fn try_lock_exclusive(file: &File) -> std::io::Result<bool> {
    // SAFETY: `file.as_raw_fd()` returns a valid, open fd borrowed from
    // `file`, which outlives this call. `libc::flock` takes the fd by value
    // and does not take ownership of it (no implicit close, no destructor
    // of any kind) — unlike wrapping it in a new owned `File`/`OwnedFd`.
    let ret = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if ret == 0 {
        Ok(true)
    } else {
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() == Some(libc::EWOULDBLOCK) {
            Ok(false)
        } else {
            Err(err)
        }
    }
}

/// [`try_lock_exclusive`] up to `attempts` times (at least one), sleeping
/// `interval` between tries (blocking). `Ok(false)` = still held after the last
/// try. Callers name their `attempts` x `interval` policy and say why.
pub fn try_lock_with_retry(
    file: &File,
    attempts: u32,
    interval: std::time::Duration,
) -> std::io::Result<bool> {
    let attempts = attempts.max(1);
    for i in 0..attempts {
        if try_lock_exclusive(file)? {
            return Ok(true);
        }
        if i + 1 < attempts {
            std::thread::sleep(interval);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::OpenOptions;

    #[test]
    fn second_handle_fails_while_first_holds_the_lock() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("test.lock");

        let f1 = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .expect("open f1");
        assert!(try_lock_exclusive(&f1).expect("lock f1"));

        // A second, independent File handle to the same path must fail to
        // acquire the lock while f1 holds it.
        let f2 = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .expect("open f2");
        assert!(!try_lock_exclusive(&f2).expect("lock f2 attempt"));

        // Dropping f1 releases the flock; a third attempt now succeeds.
        //
        // Bounded retry: other tests in this binary spawn child processes in
        // parallel (e.g. `tmux::tests`). A child forked while f1 was open
        // shares f1's open file description — and so its flock — until it
        // `exec`s (O_CLOEXEC closes it only at exec), so the lock can outlive
        // `drop(f1)` by a few milliseconds. Production is unaffected: the
        // daemon takes this lock once at startup.
        drop(f1);
        let f3 = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .expect("open f3");
        let acquired = (0..100).any(|_| {
            if try_lock_exclusive(&f3).expect("lock f3") {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
            false
        });
        assert!(acquired, "lock not released within 2s of dropping f1");
    }

    #[test]
    fn retry_gives_up_while_held_and_succeeds_once_released() {
        use std::time::Duration;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("retry.lock");
        let open = || {
            OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(&path)
                .expect("open")
        };
        let held = open();
        assert!(try_lock_exclusive(&held).unwrap());
        let other = open();
        assert!(!try_lock_with_retry(&other, 3, Duration::from_millis(1)).unwrap());
        // `attempts = 0` still tries once.
        assert!(!try_lock_with_retry(&other, 0, Duration::ZERO).unwrap());
        drop(held);
        assert!(try_lock_with_retry(&other, 3, Duration::from_millis(1)).unwrap());
    }
}
