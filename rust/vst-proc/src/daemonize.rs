//! Spawn a fully-detached child process — used to start a headless daemon
//! that must survive the spawning CLI process exiting (`cli-daemon-unification`
//! Part 03, CUJ2a/CUJ2b). A single, documented `unsafe` FFI boundary, same
//! precedent as `flock.rs`/`raw_fd_write.rs` in this crate.

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};

/// Spawn `exe args...` fully detached: stdin from `/dev/null`, stdout+stderr
/// appended to `log_path` (created/chmod'd `0600`), a fresh session (via
/// `setsid`, so the child has no controlling terminal and isn't killed when
/// the calling process's session ends), `cwd` as its working directory, and
/// exactly `env` as its environment (the caller is responsible for stripping
/// anything session-scoped before calling this — see
/// `cli-daemon-unification` Part 03's Decision 6).
///
/// No double-fork: the caller never `wait()`s on the returned child, so once
/// the caller process exits the child is simply reparented — `setsid` alone
/// is sufficient here because this child (a `vst daemon run` process) never
/// opens a PTY itself (its own tmux/PTY children use `openpty` with
/// `O_NOCTTY`), so it can never acquire a new controlling terminal by
/// accident either.
#[allow(unsafe_code)]
pub fn spawn_detached(
    exe: &Path,
    args: &[&str],
    cwd: &Path,
    env: &HashMap<String, String>,
    log_path: &Path,
) -> io::Result<u32> {
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(log_path)?;
    // `mode()` on OpenOptions only takes effect when the file is actually
    // created — if it already existed from a prior run, force the mode
    // explicitly so a stale, more-permissive mode never lingers.
    let perms = std::fs::Permissions::from_mode(0o600);
    std::fs::set_permissions(log_path, perms)?;

    let log_file_stderr = log_file.try_clone()?;

    let mut cmd = Command::new(exe);
    cmd.args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_file_stderr));

    // SAFETY: `pre_exec` runs in the forked child, after `fork()` and before
    // `exec()`, on a single-threaded copy of the process — calling
    // `libc::setsid()` here (a simple syscall wrapper with no shared-state
    // interaction) is exactly the documented safe use case for `pre_exec`.
    // It cannot fail in a way that leaves the child in a bad state: `setsid`
    // only fails if the calling process is already a process group leader,
    // which a freshly-forked child (not yet execed) never is.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }

    let child = cmd.spawn()?;
    // Found in review: the pid is needed by callers that must tell "our own
    // spawn actually won the single-instance flock race" apart from "some
    // other, already-running daemon just answered slowly" (e.g. deciding
    // whether to present a fresh login URL — presenting one against a daemon
    // we didn't spawn would be pointless at best).
    Ok(child.id())
}
