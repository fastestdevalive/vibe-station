//! RAII guards for tests that start real processes (a `vst-daemon` binary, a
//! detached `vst daemon run`), so a panicking test never leaves one behind.
//!
//! An orphaned debug daemon is not harmless: on 2026-11-12 three of them ran
//! for hours on a dev Mac and pegged it. Rules these helpers encode:
//!
//! * a test-spawned child lives in its **own process group**, and the guard's
//!   `Drop` (which also runs when a panic unwinds) sends that group `SIGTERM`,
//!   then `SIGKILL`, and reaps the child;
//! * signalling is by PID / PGID captured at launch only, never by name;
//! * binary-spawning tests are opt-in via [`NATIVE_DAEMON_TESTS_ENV`] (set in
//!   the CI container and in GitHub CI), so `cargo test` on a dev host starts
//!   no daemon at all.
//!
//! Signals go through the `kill` utility: this crate forbids `unsafe`, and a
//! direct `kill(2)` needs FFI. Only the `kill -<SIG> -- -<pgid>` spelling is
//! used: procps-ng (Linux) rejects `-s <SIG> -- -<pgid>` and reads
//! `-<SIG> -<pgid>` as a PID list, while BSD/macOS accept all three. The
//! group leader is additionally killed through `Child::kill`, so it dies even
//! where the utility misbehaves. A process that leaves the group (`setsid`,
//! e.g. a tmux server) is out of the guard's reach.
//!
//! Limits: `Drop` runs on unwind only. A test binary that is itself killed
//! (Ctrl-C, a CI cancel) drops nothing, and a guarded child no longer shares
//! the terminal's foreground group, so it does not get that Ctrl-C either.
//! That is one more reason these tests run only in a throwaway container.

use std::ops::{Deref, DerefMut};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Env var that opts in to tests which start a real daemon binary.
pub const NATIVE_DAEMON_TESTS_ENV: &str = "VST_NATIVE_DAEMON_TESTS";

/// How long a group gets to exit after `SIGTERM` before `SIGKILL`.
const TERM_GRACE: Duration = Duration::from_secs(2);
/// How long to wait for the group to disappear after `SIGKILL`.
const KILL_GRACE: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(20);

/// `true` when [`NATIVE_DAEMON_TESTS_ENV`] is `1`. Otherwise prints why the
/// test is skipped (to stderr, visible with `--nocapture`) and returns
/// `false`; the caller returns early before spawning anything.
#[must_use]
pub fn native_daemon_tests_enabled(test: &str) -> bool {
    if std::env::var(NATIVE_DAEMON_TESTS_ENV).as_deref() == Ok("1") {
        return true;
    }
    eprintln!(
        "{test}: skipped ({NATIVE_DAEMON_TESTS_ENV}=1 not set). It starts a real daemon \
         binary, so it runs only in Docker/CI: scripts/ci-local.sh --only rust"
    );
    false
}

fn signal_group(signal: &str, pgid: u32) -> bool {
    Command::new("kill")
        .arg(format!("-{signal}"))
        .arg("--")
        .arg(format!("-{pgid}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Whether process group `pgid` still has a member (zombies included).
#[must_use]
pub fn group_alive(pgid: u32) -> bool {
    signal_group("0", pgid)
}

/// Whether process `pid` still exists (a zombie counts).
#[must_use]
pub fn pid_alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn wait_group_gone(pgid: u32, mut child: Option<&mut Child>, grace: Duration) -> bool {
    let deadline = Instant::now() + grace;
    loop {
        // Reap our own child first: an unreaped zombie keeps the group "alive".
        if let Some(c) = child.as_deref_mut() {
            let _ = c.try_wait();
        }
        if !group_alive(pgid) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(POLL);
    }
}

fn terminate_group_inner(pgid: u32, mut child: Option<&mut Child>) -> bool {
    // 0 and 1 would address our own group / every process: never signal them.
    if pgid <= 1 {
        return true;
    }
    if !group_alive(pgid) {
        // Never block here: a `kill` that could not even be spawned also reads
        // as "not alive". The caller kills the child directly before waiting.
        if let Some(c) = child {
            let _ = c.try_wait();
        }
        return true;
    }
    signal_group("TERM", pgid);
    if wait_group_gone(pgid, child.as_deref_mut(), TERM_GRACE) {
        return true;
    }
    signal_group("KILL", pgid);
    wait_group_gone(pgid, child, KILL_GRACE)
}

/// `SIGTERM`, then `SIGKILL`, process group `pgid`, waiting for it to empty.
/// Returns whether the group is gone. Only pass a PGID you captured from a
/// process you started (a `setsid` process's PID is its PGID).
pub fn terminate_group(pgid: u32) -> bool {
    terminate_group_inner(pgid, None)
}

/// A spawned [`Child`] in its own process group, killed (group and all) and
/// reaped when the guard drops. Derefs to the `Child`.
#[derive(Debug)]
pub struct ChildGuard {
    child: Child,
    pgid: u32,
}

impl ChildGuard {
    /// Spawn `cmd` as the leader of a new process group and guard it.
    ///
    /// # Errors
    /// Whatever [`Command::spawn`] returns.
    pub fn spawn(cmd: &mut Command) -> std::io::Result<Self> {
        use std::os::unix::process::CommandExt;
        let child = cmd.process_group(0).spawn()?;
        let pgid = child.id();
        Ok(Self { child, pgid })
    }

    /// The child's process group id (equal to its PID).
    #[must_use]
    pub fn pgid(&self) -> u32 {
        self.pgid
    }
}

impl Deref for ChildGuard {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.child
    }
}

impl DerefMut for ChildGuard {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        terminate_group_inner(self.pgid, Some(&mut self.child));
        // Belt and braces: SIGKILL the leader directly (no-op once reaped), so
        // the `wait` below can never block on a live child.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Guard for a daemon a test starts *indirectly* and detached (`vst daemon
/// run` via the CLI's self-heal), where the test never holds a `Child`.
///
/// Create it **before** anything can spawn. On drop it reads the PID the
/// daemon recorded under `<home>/.vibe-station` (`config.json`, and
/// `.daemon.lock` which is written earlier in boot) and terminates that
/// process group: the daemon is `setsid`-detached, so its PID is its PGID.
/// PIDs already on disk when the guard was created (a test's stale
/// placeholder) are never signalled.
#[derive(Debug)]
pub struct DaemonHomeGuard {
    vst_home: PathBuf,
    preexisting: Vec<u32>,
}

impl DaemonHomeGuard {
    /// Guard the daemon that will run with `HOME = home`.
    #[must_use]
    pub fn new(home: &Path) -> Self {
        let vst_home = home.join(".vibe-station");
        let preexisting = recorded_pids(&vst_home);
        Self {
            vst_home,
            preexisting,
        }
    }

    fn spawned_pids(&self) -> Vec<u32> {
        let mut pids = recorded_pids(&self.vst_home);
        pids.retain(|p| !self.preexisting.contains(p));
        pids
    }
}

impl Drop for DaemonHomeGuard {
    fn drop(&mut self) {
        let mut pids = self.spawned_pids();
        // A spawn was attempted (its log exists) but no PID is recorded yet:
        // give the daemon a moment to get as far as its lock file.
        if pids.is_empty() && self.vst_home.join("logs").join("daemon.log").exists() {
            let deadline = Instant::now() + Duration::from_secs(3);
            while pids.is_empty() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(100));
                pids = self.spawned_pids();
            }
        }
        // Killing the lock holder can let a slow racer (a second self-heal
        // spawn still on its way to the flock) take over as the daemon: re-read
        // until no new PID shows up.
        let mut done: Vec<u32> = Vec::new();
        for _ in 0..5 {
            pids.retain(|p| !done.contains(p));
            if pids.is_empty() {
                break;
            }
            for pid in &pids {
                terminate_group(*pid);
            }
            done.append(&mut pids);
            std::thread::sleep(Duration::from_millis(500));
            pids = self.spawned_pids();
        }
    }
}

fn recorded_pids(vst_home: &Path) -> Vec<u32> {
    let mut pids = Vec::new();
    if let Ok(content) = std::fs::read_to_string(vst_home.join("config.json")) {
        let pid = serde_json::from_str::<serde_json::Value>(&content)
            .ok()
            .and_then(|j| j.get("pid").and_then(serde_json::Value::as_u64))
            .and_then(|p| u32::try_from(p).ok());
        pids.extend(pid);
    }
    if let Ok(content) = std::fs::read_to_string(vst_home.join(".daemon.lock")) {
        pids.extend(content.trim().parse::<u32>().ok());
    }
    pids.sort_unstable();
    pids.dedup();
    pids
}
