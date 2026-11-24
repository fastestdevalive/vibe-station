//! Small, documented `unsafe` POSIX FFI wrappers used by the update feature
//! (free-space check, effective uid, signal delivery, pid liveness).
//!
//! Each function carries its own `#[allow(unsafe_code)]` + SAFETY comment,
//! following the `flock.rs` precedent. `vst-proc` is the sanctioned FFI crate.

use std::ffi::CString;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

/// Bytes available to an unprivileged user on the filesystem holding `path`
/// (`statvfs`: `f_bavail * f_frsize`).
#[allow(unsafe_code)]
pub fn free_bytes(path: &Path) -> io::Result<u64> {
    let c = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))?;
    // SAFETY: `statvfs` is a plain-old-data struct for which all-zero bytes
    // are a valid value; it is fully overwritten by a successful call.
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `c` is a valid NUL-terminated string that outlives the call and
    // `st` is a valid, writable `statvfs` out-pointer.
    let ret = unsafe { libc::statvfs(c.as_ptr(), &mut st) };
    if ret != 0 {
        return Err(io::Error::last_os_error());
    }
    #[allow(clippy::unnecessary_cast)]
    Ok((st.f_bavail as u64).saturating_mul(st.f_frsize as u64))
}

/// True when the filesystem holding `dir` is mounted read-only (`statvfs`
/// `f_flag & ST_RDONLY`). An unreadable/missing path reports `false`: the
/// caller's own write probe decides in that case.
#[allow(unsafe_code)]
pub fn is_read_only(dir: &Path) -> bool {
    // `ST_RDONLY` (Linux) and `MNT_RDONLY` (macOS `statvfs`) are both 1.
    const RDONLY_FLAG: u64 = 1;
    let Ok(c) = CString::new(dir.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `statvfs` is a plain-old-data struct for which all-zero bytes
    // are a valid value; it is fully overwritten by a successful call.
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `c` is a valid NUL-terminated string that outlives the call and
    // `st` is a valid, writable `statvfs` out-pointer.
    let ret = unsafe { libc::statvfs(c.as_ptr(), &mut st) };
    if ret != 0 {
        return false;
    }
    #[allow(clippy::unnecessary_cast)]
    let flag = st.f_flag as u64;
    flag & RDONLY_FLAG != 0
}

/// Effective uid of this process (`geteuid`).
#[allow(unsafe_code)]
pub fn effective_uid() -> u32 {
    // SAFETY: `geteuid` takes no arguments, has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

/// Send signal `sig` to process `pid` (`kill(2)`).
#[allow(unsafe_code)]
pub fn kill_pid(pid: u32, sig: i32) -> io::Result<()> {
    let pid = libc::pid_t::try_from(pid)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "pid out of range"))?;
    // SAFETY: `kill` takes two integers by value and touches no memory of ours.
    let ret = unsafe { libc::kill(pid, sig) };
    if ret == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// True if a process with `pid` exists and we may signal it
/// (`kill(pid, 0) == 0`).
#[allow(unsafe_code)]
pub fn pid_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // SAFETY: signal 0 performs only the existence/permission check; no
    // signal is delivered and no memory is touched.
    unsafe { libc::kill(pid, 0) == 0 }
}

/// Soft limit to request, or `None` when it is already at or above
/// `min(hard, target)`. An infinite hard limit is treated as unbounded.
fn nofile_target(soft: u64, hard: u64, target: u64) -> Option<u64> {
    let new = if hard == libc::RLIM_INFINITY {
        target
    } else {
        hard.min(target)
    };
    (new > soft).then_some(new)
}

/// Raise the soft `RLIMIT_NOFILE` towards `target` (clamped to the hard limit);
/// never lowers it. Returns `(old_soft, new_soft)`.
#[allow(unsafe_code)]
pub fn raise_nofile_limit(target: u64) -> io::Result<(u64, u64)> {
    let mut lim = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `lim` is a valid, writable `rlimit` out-pointer.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let soft = lim.rlim_cur;
    let Some(new) = nofile_target(soft, lim.rlim_max, target) else {
        return Ok((soft, soft));
    };
    lim.rlim_cur = new;
    // SAFETY: `lim` is a valid `rlimit`; the soft value is <= the hard value.
    if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &lim) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((soft, new))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nofile_target_table() {
        let inf = libc::RLIM_INFINITY;
        assert_eq!(nofile_target(256, 1_000_000, 10_240), Some(10_240));
        assert_eq!(nofile_target(256, 4096, 10_240), Some(4096));
        assert_eq!(nofile_target(256, inf, 10_240), Some(10_240));
        assert_eq!(nofile_target(20_000, inf, 10_240), None);
        assert_eq!(nofile_target(10_240, 1_000_000, 10_240), None);
        assert_eq!(nofile_target(4096, 4096, 10_240), None);
    }

    #[test]
    fn raise_to_current_soft_is_noop() {
        let (soft, _) = raise_nofile_limit(0).unwrap();
        assert_eq!(raise_nofile_limit(soft).unwrap(), (soft, soft));
    }

    #[test]
    fn free_bytes_reports_nonzero_for_tmp() {
        let dir = tempfile::tempdir().unwrap();
        assert!(free_bytes(dir.path()).unwrap() > 0);
        assert!(free_bytes(Path::new("/definitely/not/here")).is_err());
    }

    #[test]
    fn uid_and_pid_helpers() {
        let _ = effective_uid();
        assert!(pid_alive(std::process::id()));
        assert!(kill_pid(std::process::id(), 0).is_ok());
        assert!(!pid_alive(u32::MAX));
    }
}
