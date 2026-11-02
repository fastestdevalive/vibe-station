//! Global git concurrency pools (plan Phase 4.T3 & review fix F2/F14).
//!
//! Every ordinary git exec takes a permit from the process-global short pool
//! (`SHORT_GIT_CONCURRENCY`); heavy operations (clone/fetch/push/worktree add/rm)
//! do not take short permits and are unthrottled.
//!
//! Synchronization between test runner and fake git scripts uses release files
//! rather than wall-clock sleeps to prevent flakiness.

#[path = "common/script.rs"]
mod script;

use std::fs;
use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use vst_git::{short_git_semaphore, GitRunner, SHORT_GIT_CONCURRENCY};

/// Both tests drive the SAME process-global semaphore, and cargo runs test
/// functions in parallel threads of one process — so they must not interleave.
async fn semaphore_guard() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

fn count_lines(path: &Path) -> usize {
    fs::read_to_string(path)
        .map(|text| text.lines().count())
        .unwrap_or(0)
}

async fn wait_for_count(path: &Path, expected: usize) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while count_lines(path) < expected {
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {expected} events in {} (saw {})",
            path.display(),
            count_lines(path)
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn controlled_runner(dir: &Path, name: &str, started: &Path, release: &Path) -> GitRunner {
    let path = dir.join(name);
    script::install_executable_script(
        &path,
        &format!(
            "#!/bin/sh\n\
             echo s >> '{}'\n\
             while [ ! -f '{}' ]; do\n\
                 sleep 0.01\n\
             done\n",
            started.display(),
            release.display()
        ),
    );
    GitRunner::with_program(path.to_string_lossy().to_string())
}

#[tokio::test]
async fn short_execs_are_capped_at_four() {
    let _guard = semaphore_guard().await;

    let dir = tempfile::tempdir().unwrap();
    let started = dir.path().join("short-started");
    let release = dir.path().join("short-release");
    let runner = controlled_runner(dir.path(), "short.sh", &started, &release);

    let mut handles = Vec::new();
    for _ in 0..(SHORT_GIT_CONCURRENCY * 2) {
        let runner = runner.clone();
        handles.push(tokio::spawn(async move {
            runner.run(&["--version"], None).await
        }));
    }

    // Exactly 4 should start and wait on the release file.
    wait_for_count(&started, SHORT_GIT_CONCURRENCY).await;
    assert_eq!(
        count_lines(&started),
        SHORT_GIT_CONCURRENCY,
        "a burst of {} execs must be capped at {SHORT_GIT_CONCURRENCY}",
        SHORT_GIT_CONCURRENCY * 2
    );
    assert_eq!(
        short_git_semaphore().available_permits(),
        0,
        "every short permit must be held by a running exec"
    );

    // Release the first wave so the remaining 4 can acquire permits.
    fs::write(&release, "ok").unwrap();

    for handle in handles {
        handle.await.unwrap().unwrap();
    }
    assert_eq!(
        short_git_semaphore().available_permits(),
        SHORT_GIT_CONCURRENCY,
        "all permits are released when the execs finish"
    );
    assert_eq!(count_lines(&started), SHORT_GIT_CONCURRENCY * 2);
}

#[tokio::test]
async fn heavy_execs_do_not_take_short_permits_and_are_unthrottled() {
    let _guard = semaphore_guard().await;

    let dir = tempfile::tempdir().unwrap();
    let heavy_started = dir.path().join("heavy-started");
    let heavy_release = dir.path().join("heavy-release");
    let heavy = controlled_runner(dir.path(), "heavy.sh", &heavy_started, &heavy_release);

    // Fast short runner (doesn't wait on release)
    let short_script = dir.path().join("quick-short.sh");
    script::install_executable_script(&short_script, "#!/bin/sh\nexit 0\n");
    let short = GitRunner::with_program(short_script.to_string_lossy().to_string());

    // Spawn 6 heavy execs (more than old heavy cap of 2).
    let mut heavy_handles = Vec::new();
    for _ in 0..6 {
        let heavy = heavy.clone();
        heavy_handles.push(tokio::spawn(async move {
            heavy.run_heavy(&["fetch"], None).await
        }));
    }

    // All 6 heavy execs start concurrently because heavy operations are unthrottled.
    wait_for_count(&heavy_started, 6).await;
    assert_eq!(count_lines(&heavy_started), 6);

    // Short permits must be completely untouched.
    assert_eq!(
        short_git_semaphore().available_permits(),
        SHORT_GIT_CONCURRENCY,
        "heavy execs never consume short permits"
    );

    // Short execs run and complete immediately while heavy operations are ongoing.
    let mut short_handles = Vec::new();
    for _ in 0..SHORT_GIT_CONCURRENCY {
        let short = short.clone();
        short_handles.push(tokio::spawn(async move {
            short.run(&["rev-parse"], None).await
        }));
    }
    for handle in short_handles {
        handle.await.unwrap().unwrap();
    }

    // Release heavy operations
    fs::write(&heavy_release, "ok").unwrap();
    for handle in heavy_handles {
        handle.await.unwrap().unwrap();
    }
}
