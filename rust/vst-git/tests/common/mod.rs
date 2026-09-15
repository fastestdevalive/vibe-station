//! Shared test helpers for vst-git's integration tests.
//!
//! The `vst-testkit` git fixture runs synchronous `std::process::Command`
//! git calls (rust-coding §4). From a `#[tokio::test]` body those must go
//! through `spawn_blocking` so they never run on a tokio worker. These
//! helpers wrap the fixture's sync `git()` and the sync creation/removal so
//! test bodies can stay async.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use vst_testkit::{create_git_fixture, remove_git_fixture, GitFixture};

/// vst-testkit's `create_git_fixture` derives the dir from `process::id()`
/// only, so concurrent tests sharing a prefix would collide on the same temp
/// dir. A per-call counter makes each fixture unique.
static FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Create a fixture, running the sync `git init`/config on a blocking thread.
pub async fn git_fixture(prefix: &str) -> GitFixture {
    let n = FIXTURE_COUNTER.fetch_add(1, Ordering::SeqCst);
    let unique = format!("{prefix}-{n}");
    tokio::task::spawn_blocking(move || create_git_fixture(&unique))
        .await
        .unwrap()
}

/// Run `git <args>` in the fixture on a blocking thread.
pub async fn git(fx: &GitFixture, args: &[&str]) -> String {
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let dir = fx.dir.clone();
    tokio::task::spawn_blocking(move || run_git_in(dir, &args))
        .await
        .unwrap()
}

/// Remove a fixture on a blocking thread.
pub async fn rm_git_fixture(fx: &GitFixture) {
    let dir = fx.dir.clone();
    tokio::task::spawn_blocking(move || remove_git_fixture(&GitFixture { dir }))
        .await
        .unwrap();
}

fn run_git_in(dir: PathBuf, args: &[String]) -> String {
    let fx = GitFixture { dir };
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    fx.git(&refs)
}
