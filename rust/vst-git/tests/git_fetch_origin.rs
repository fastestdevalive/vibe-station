//! Behavior contract for `git.ts`'s `fetchOrigin` (part 03-git-worktree).
//! Ported from `daemon/src/__tests__/git.fetchOrigin.test.ts`.
//!
//! The TS tests shadow `git` on PATH with fake scripts; in Rust we inject the
//! fake script as the `git_bin` on a `GitService`, and inject a fake clock to
//! drive the cooldown window — both are `#[doc(hidden)]` test seams on
//! `GitService`.

mod common;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use std::os::unix::fs::PermissionsExt;

use common::{git, git_fixture, rm_git_fixture};
use vst_git::git::{Clock, GitService};

fn real_clock() -> Clock {
    Arc::new(SystemTime::now)
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

struct FakeGit {
    _dir: tempfile::TempDir,
    script: PathBuf,
}

impl FakeGit {
    fn install_script(body: &str) -> FakeGit {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("git");
        std::fs::write(&script, body).unwrap();
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();
        FakeGit { _dir: dir, script }
    }
}

fn counting_fake(counter: &PathBuf) -> FakeGit {
    FakeGit::install_script(&format!(
        "#!/bin/sh\necho invoked >> \"{}\"\nexit 0\n",
        counter.display()
    ))
}

fn failing_fake(counter: &PathBuf) -> FakeGit {
    FakeGit::install_script(&format!(
        "#!/bin/sh\necho invoked >> \"{}\"\nexit 1\n",
        counter.display()
    ))
}

async fn count_invocations(counter: &PathBuf) -> u64 {
    match tokio::fs::read_to_string(counter).await {
        Ok(text) => text.lines().filter(|l| !l.trim().is_empty()).count() as u64,
        Err(_) => 0,
    }
}

#[tokio::test]
async fn updates_the_origin_ref_remote_tracking_ref_on_success() {
    let origin = git_fixture("vst-git-fetchorigin-origin-test").await;
    std::fs::write(origin.dir.join("seed.txt"), "seed\n").unwrap();
    git(&origin, &["add", "-A"]).await;
    git(&origin, &["commit", "-q", "-m", "origin seed"]).await;
    let origin_tip = git(&origin, &["rev-parse", "HEAD"]).await;

    let fx = git_fixture("vst-git-fetchorigin-test").await;
    git(
        &fx,
        &["remote", "add", "origin", origin.dir.to_str().unwrap()],
    )
    .await;

    let svc = GitService::new();
    svc.fetch_origin(fx.dir.to_str().unwrap(), "main").await;

    let tracking = vst_git::git::rev_parse(fx.dir.to_str().unwrap(), "origin/main")
        .await
        .unwrap();
    assert_eq!(tracking, origin_tip);

    rm_git_fixture(&fx).await;
    rm_git_fixture(&origin).await;
}

#[tokio::test]
async fn swallows_errors_and_resolves_without_throwing_when_no_remote() {
    let fx = git_fixture("vst-git-fetchorigin-test").await;
    let svc = GitService::new();
    svc.fetch_origin(fx.dir.to_str().unwrap(), "main").await;
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn does_not_hang_past_the_bounded_timeout() {
    let fx = git_fixture("vst-git-fetchorigin-test").await;
    let hanging = FakeGit::install_script("#!/bin/sh\nsleep 2\n");
    let svc = GitService::with_deps(hanging.script.to_string_lossy().into_owned(), real_clock());
    let start = std::time::Instant::now();
    svc.fetch_origin_with_timeout(fx.dir.to_str().unwrap(), "main", 300)
        .await;
    assert!(start.elapsed() < Duration::from_millis(2_000));
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn dedupes_concurrent_calls_for_the_same_key_into_exactly_one_subprocess() {
    let fx = git_fixture("vst-git-fetchorigin-test").await;
    let counter = fx.dir.join("counter.txt");
    let fake = counting_fake(&counter);
    let svc = GitService::with_deps(fake.script.to_string_lossy().into_owned(), real_clock());
    let repo = fx.dir.to_str().unwrap().to_string();
    tokio::join!(
        svc.fetch_origin(&repo, "main"),
        svc.fetch_origin(&repo, "main")
    );
    assert_eq!(count_invocations(&counter).await, 1);
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn does_not_dedupe_a_different_ref_for_the_same_repo() {
    let fx = git_fixture("vst-git-fetchorigin-test").await;
    let counter = fx.dir.join("counter.txt");
    let fake = counting_fake(&counter);
    let svc = GitService::with_deps(fake.script.to_string_lossy().into_owned(), real_clock());
    let repo = fx.dir.to_str().unwrap().to_string();
    tokio::join!(
        svc.fetch_origin(&repo, "main"),
        svc.fetch_origin(&repo, "other")
    );
    assert_eq!(count_invocations(&counter).await, 2);
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn does_not_dedupe_the_same_ref_for_a_different_repo() {
    let fx = git_fixture("vst-git-fetchorigin-test").await;
    let other = git_fixture("vst-git-fetchorigin-other-repo").await;
    let counter = fx.dir.join("counter.txt");
    let fake = counting_fake(&counter);
    let svc = GitService::with_deps(fake.script.to_string_lossy().into_owned(), real_clock());
    let a = fx.dir.to_str().unwrap().to_string();
    let b = other.dir.to_str().unwrap().to_string();
    tokio::join!(svc.fetch_origin(&a, "main"), svc.fetch_origin(&b, "main"));
    assert_eq!(count_invocations(&counter).await, 2);
    rm_git_fixture(&fx).await;
    rm_git_fixture(&other).await;
}

#[tokio::test]
async fn same_key_call_within_cooldown_resolves_without_a_new_subprocess() {
    let fx = git_fixture("vst-git-fetchorigin-test").await;
    let counter = fx.dir.join("counter.txt");
    let fake = counting_fake(&counter);
    let svc = GitService::with_deps(fake.script.to_string_lossy().into_owned(), real_clock());
    let repo = fx.dir.to_str().unwrap().to_string();
    svc.fetch_origin(&repo, "main").await;
    assert_eq!(count_invocations(&counter).await, 1);
    svc.fetch_origin(&repo, "main").await;
    assert_eq!(count_invocations(&counter).await, 1);
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn same_key_call_after_the_cooldown_window_performs_a_real_fetch_again() {
    let fx = git_fixture("vst-git-fetchorigin-test").await;
    let counter = fx.dir.join("counter.txt");
    let fake = counting_fake(&counter);
    let fake_ms = Arc::new(AtomicU64::new(epoch_ms()));
    let clock: Clock = {
        let fake_ms = fake_ms.clone();
        Arc::new(move || UNIX_EPOCH + Duration::from_millis(fake_ms.load(Ordering::SeqCst)))
    };
    let svc = GitService::with_deps(fake.script.to_string_lossy().into_owned(), clock);
    let repo = fx.dir.to_str().unwrap().to_string();

    svc.fetch_origin(&repo, "main").await;
    assert_eq!(count_invocations(&counter).await, 1);

    fake_ms.store(epoch_ms() + 5_001, Ordering::SeqCst);
    svc.fetch_origin(&repo, "main").await;
    assert_eq!(count_invocations(&counter).await, 2);
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn failing_fetch_clears_in_flight_and_does_not_enter_cooldown() {
    let fx = git_fixture("vst-git-fetchorigin-test").await;
    let counter = fx.dir.join("counter.txt");
    let fake = failing_fake(&counter);
    let svc = GitService::with_deps(fake.script.to_string_lossy().into_owned(), real_clock());
    let repo = fx.dir.to_str().unwrap().to_string();

    svc.fetch_origin(&repo, "main").await;
    assert_eq!(count_invocations(&counter).await, 1);

    svc.fetch_origin(&repo, "main").await;
    assert_eq!(count_invocations(&counter).await, 2);
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn clear_state_for_test_restores_real_fetch_behavior_after_a_primed_cooldown() {
    let fx = git_fixture("vst-git-fetchorigin-test").await;
    let counter = fx.dir.join("counter.txt");
    let fake = counting_fake(&counter);
    let svc = GitService::with_deps(fake.script.to_string_lossy().into_owned(), real_clock());
    let repo = fx.dir.to_str().unwrap().to_string();

    svc.fetch_origin(&repo, "main").await;
    assert_eq!(count_invocations(&counter).await, 1);
    svc.fetch_origin(&repo, "main").await;
    assert_eq!(count_invocations(&counter).await, 1);

    svc.clear_fetch_origin_state_for_test();
    svc.fetch_origin(&repo, "main").await;
    assert_eq!(count_invocations(&counter).await, 2);
    rm_git_fixture(&fx).await;
}
