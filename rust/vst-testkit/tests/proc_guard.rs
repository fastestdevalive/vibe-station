//! The leak guards must clean up when a test panics. Uses `sleep`, never a
//! daemon, so it is safe (and runs) on a dev host.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use vst_testkit::{group_alive, pid_alive, ChildGuard, DaemonHomeGuard};

fn wait_for_pid_file(path: &Path) -> u32 {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(pid) = std::fs::read_to_string(path)
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
        {
            return pid;
        }
        assert!(Instant::now() < deadline, "no pid in {}", path.display());
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn wait_gone(pid: u32) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while pid_alive(pid) {
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    true
}

#[test]
fn guarded_child_and_grandchild_are_gone_after_a_panic_unwinds() {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("grandchild.pid");
    let pid_file_for_panic = pid_file.clone();

    let result = std::panic::catch_unwind(move || {
        // sh (child) backgrounds a `sleep` (grandchild, same group), then waits.
        let child = ChildGuard::spawn(
            Command::new("sh")
                .arg("-c")
                .arg("sleep 300 & echo $! > \"$1\"; wait")
                .arg("sh")
                .arg(&pid_file_for_panic)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null()),
        )
        .expect("spawn sh");
        let grandchild = wait_for_pid_file(&pid_file_for_panic);
        let ids = (child.id(), child.pgid(), grandchild);
        assert!(pid_alive(ids.0) && pid_alive(ids.2), "both running");
        // Also proves the `kill` spelling the guard relies on works here.
        assert!(group_alive(ids.1), "group probe sees the running group");
        std::panic::panic_any(ids);
    });

    let (child, pgid, grandchild) = *result
        .expect_err("closure panics")
        .downcast::<(u32, u32, u32)>()
        .expect("panic payload carries the pids");
    assert_eq!(child, pgid, "child leads its own process group");
    assert!(wait_gone(child), "child {child} survived the panic");
    assert!(
        wait_gone(grandchild),
        "grandchild {grandchild} survived the panic"
    );
    assert!(!group_alive(pgid), "process group {pgid} still has members");
}

#[test]
fn guard_kills_a_child_that_ignores_sigterm() {
    let dir = tempfile::tempdir().unwrap();
    let ready = dir.path().join("ready");
    let pid = {
        let child = ChildGuard::spawn(
            Command::new("sh")
                .arg("-c")
                .arg("trap '' TERM; echo $$ > \"$1\"; while :; do sleep 1; done")
                .arg("sh")
                .arg(&ready)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null()),
        )
        .expect("spawn sh");
        assert_eq!(wait_for_pid_file(&ready), child.id());
        child.id()
    };
    assert!(wait_gone(pid), "SIGTERM-ignoring child {pid} survived drop");
}

#[test]
fn daemon_home_guard_kills_the_recorded_pid_but_not_a_preexisting_one() {
    let home = tempfile::tempdir().unwrap();
    let vst_home = home.path().join(".vibe-station");
    std::fs::create_dir_all(&vst_home).unwrap();

    // A bystander whose pid is on disk BEFORE the guard exists: never touched.
    let bystander = ChildGuard::spawn(Command::new("sleep").arg("300")).expect("spawn sleep");
    std::fs::write(
        vst_home.join("config.json"),
        format!(r#"{{"pid": {}}}"#, bystander.id()),
    )
    .unwrap();

    let result = std::panic::catch_unwind(|| {
        let _guard = DaemonHomeGuard::new(home.path());
        // Stand-in for the detached daemon: own group, pid recorded in config.json.
        let mut cmd = Command::new("sleep");
        cmd.arg("300");
        let daemon = {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0).spawn().expect("spawn sleep")
        };
        let pid = daemon.id();
        std::fs::write(vst_home.join("config.json"), format!(r#"{{"pid": {pid}}}"#)).unwrap();
        std::panic::panic_any((daemon, pid));
    });
    let (mut daemon, pid) = *result
        .expect_err("closure panics")
        .downcast::<(std::process::Child, u32)>()
        .expect("panic payload");

    // Reaping proves it was signalled; it must not still be running.
    let deadline = Instant::now() + Duration::from_secs(5);
    while daemon.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "recorded daemon {pid} survived");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(pid_alive(bystander.id()), "pre-existing pid was signalled");
}
