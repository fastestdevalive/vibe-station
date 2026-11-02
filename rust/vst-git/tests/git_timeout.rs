//! `GitRunner` timeout / kill-on-drop contract (poller-redesign Phase 1).
//!
//! These tests point the runner at a fake shell script instead of the real
//! `git`, so they never touch the process-global `PATH` and never depend on a
//! network or a repo.

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use vst_git::git::GitError;
use vst_git::GitRunner;

fn script(dir: &std::path::Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, body).unwrap();
    let mut perms = std::fs::metadata(&path).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&path, perms).unwrap();
    path
}

#[tokio::test]
async fn a_slow_program_times_out_promptly() {
    let dir = tempfile::tempdir().unwrap();
    let slow = script(dir.path(), "slow.sh", "#!/bin/sh\nsleep 5\nprintf done\n");
    let runner = GitRunner::with_program(slow.to_string_lossy().to_string())
        .with_timeout(Duration::from_millis(150));
    assert_eq!(runner.timeout(), Duration::from_millis(150));
    assert_eq!(runner.program(), &*slow.to_string_lossy());

    let started = Instant::now();
    let err = runner.run(&["--version"], None).await.unwrap_err();
    let elapsed = started.elapsed();

    match err {
        GitError::Timeout { args } => {
            assert_eq!(args, "--version");
        }
        other => panic!("expected a Timeout error, got {other:?}"),
    }
    assert!(
        elapsed < Duration::from_secs(2),
        "timeout took {elapsed:?}, expected well under the 5 s script"
    );
}

#[tokio::test]
async fn a_timed_out_child_is_killed() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("finished");
    let slow = script(
        dir.path(),
        "slow-writes.sh",
        &format!("#!/bin/sh\nsleep 1\ntouch '{}'\n", marker.to_string_lossy()),
    );
    let runner = GitRunner::with_program(slow.to_string_lossy().to_string())
        .with_timeout(Duration::from_millis(100));
    assert!(runner.run(&[], None).await.is_err());

    // If the child survived the timeout it would touch the marker at ~1 s.
    tokio::time::sleep(Duration::from_millis(1_400)).await;
    assert!(
        !marker.exists(),
        "timed-out child kept running and wrote {}",
        marker.display()
    );
}

#[tokio::test]
async fn successful_runs_trim_and_raw_preserve_output() {
    let dir = tempfile::tempdir().unwrap();
    let out = script(
        dir.path(),
        "out.sh",
        "#!/bin/sh\nprintf '  padded value  \\n'\n",
    );
    let runner = GitRunner::with_program(out.to_string_lossy().to_string());
    assert_eq!(runner.run(&[], None).await.unwrap(), "padded value");
    assert_eq!(
        runner.run_raw(&[], None).await.unwrap(),
        "  padded value  \n"
    );
}

#[tokio::test]
async fn non_zero_exit_carries_stderr() {
    let dir = tempfile::tempdir().unwrap();
    let failing = script(dir.path(), "fail.sh", "#!/bin/sh\necho boom >&2\nexit 3\n");
    let runner = GitRunner::with_program(failing.to_string_lossy().to_string());
    match runner.run(&["status"], None).await.unwrap_err() {
        GitError::Command { args, stderr } => {
            assert_eq!(args, "status");
            assert_eq!(stderr, "boom");
        }
        other => panic!("expected a Command error, got {other:?}"),
    }
}

#[tokio::test]
async fn exit_status_reports_code_one_without_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let failing = script(dir.path(), "exit-one.sh", "#!/bin/sh\nexit 1\n");
    let runner = GitRunner::with_program(failing.to_string_lossy().to_string());
    let status = runner.exit_status(&[], None).await.unwrap();
    assert_eq!(status.code(), Some(1));
}

#[tokio::test]
async fn exit_status_times_out_too() {
    let dir = tempfile::tempdir().unwrap();
    let slow = script(dir.path(), "slow-status.sh", "#!/bin/sh\nsleep 5\n");
    let runner = GitRunner::with_program(slow.to_string_lossy().to_string())
        .with_timeout(Duration::from_millis(100));
    let err = runner.exit_status(&[], None).await.unwrap_err();
    assert!(matches!(err, GitError::Timeout { .. }));
}

#[tokio::test]
async fn short_execs_force_git_optional_locks_and_heavy_execs_do_not() {
    let dir = tempfile::tempdir().unwrap();
    let print_env = script(
        dir.path(),
        "print-env.sh",
        "#!/bin/sh\nprintf '%s' \"$GIT_OPTIONAL_LOCKS\"\n",
    );
    let runner = GitRunner::with_program(print_env.to_string_lossy().to_string());
    let short_out = runner.run(&[], None).await.unwrap();
    assert_eq!(short_out, "0");

    // Heavy execs must not force the variable: they see exactly what the parent
    // process has (CI containers export GIT_OPTIONAL_LOCKS=0 globally, so
    // asserting "unset" would depend on the environment).
    let heavy_out = runner.run_heavy(&[], None).await.unwrap();
    let inherited = std::env::var("GIT_OPTIONAL_LOCKS").unwrap_or_default();
    assert_eq!(heavy_out, inherited);
}
