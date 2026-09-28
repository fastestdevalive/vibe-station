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
        drop(f1);
        let f3 = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .expect("open f3");
        assert!(try_lock_exclusive(&f3).expect("lock f3"));
    }
}
