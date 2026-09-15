//! Behavior contract for `git.ts`'s `resolveBaseSha` (part 03-git-worktree).
//! Ported from `daemon/src/__tests__/git.resolveBaseSha.test.ts`.

mod common;

use common::{git, git_fixture, rm_git_fixture};
use vst_git::git::resolve_base_sha;
use vst_testkit::GitFixture;

async fn write_file(fx: &GitFixture, name: &str, content: &str) {
    std::fs::write(fx.dir.join(name), content).unwrap();
}

#[tokio::test]
async fn returns_the_live_merge_base_with_base_branch_not_a_stale_cached_value() {
    let fx = git_fixture("vst-git-resolve-base-test").await;
    write_file(&fx, "a.txt", "a\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "commit 1"]).await;
    let stale_base_sha = git(&fx, &["rev-parse", "HEAD"]).await;

    git(&fx, &["checkout", "-q", "-b", "feature"]).await;
    write_file(&fx, "b.txt", "b\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "own commit"]).await;

    git(&fx, &["checkout", "-q", "main"]).await;
    write_file(&fx, "c.txt", "c\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "main advances"]).await;
    let new_main_tip = git(&fx, &["rev-parse", "HEAD"]).await;

    git(&fx, &["checkout", "-q", "feature"]).await;
    git(&fx, &["merge", "-q", "-m", "sync with main", "main"]).await;

    let resolved = resolve_base_sha(
        fx.dir.to_str().unwrap(),
        Some("main"),
        Some(&stale_base_sha),
    )
    .await
    .unwrap()
    .expect("must resolve");
    assert_eq!(resolved, new_main_tip);
    assert_ne!(resolved, stale_base_sha);
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn falls_back_to_the_stored_base_sha_when_base_branch_doesnt_resolve() {
    let fx = git_fixture("vst-git-resolve-base-test").await;
    write_file(&fx, "a.txt", "a\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "commit 1"]).await;
    let base_sha = git(&fx, &["rev-parse", "HEAD"]).await;

    let resolved = resolve_base_sha(
        fx.dir.to_str().unwrap(),
        Some("does-not-exist-branch"),
        Some(&base_sha),
    )
    .await
    .unwrap()
    .expect("must resolve");
    assert_eq!(resolved, base_sha);
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn returns_null_when_neither_base_branch_nor_the_fallback_resolves() {
    let fx = git_fixture("vst-git-resolve-base-test").await;
    write_file(&fx, "a.txt", "a\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "commit 1"]).await;

    let resolved = resolve_base_sha(
        fx.dir.to_str().unwrap(),
        Some("does-not-exist-branch"),
        Some(&"f".repeat(40)),
    )
    .await
    .unwrap();
    assert!(resolved.is_none());
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn returns_null_when_base_branch_absent_and_no_fallback_given() {
    let fx = git_fixture("vst-git-resolve-base-test").await;
    let resolved = resolve_base_sha(fx.dir.to_str().unwrap(), None, None)
        .await
        .unwrap();
    assert!(resolved.is_none());
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn prefers_fresh_origin_over_a_stale_local_base_branch() {
    let origin = git_fixture("vst-git-resolve-base-origin-test").await;
    write_file(&origin, "seed.txt", "seed\n").await;
    git(&origin, &["add", "-A"]).await;
    git(&origin, &["commit", "-q", "-m", "origin seed commit"]).await;

    let fx = git_fixture("vst-git-resolve-base-clone-test").await;
    git(
        &fx,
        &["remote", "add", "origin", origin.dir.to_str().unwrap()],
    )
    .await;
    git(&fx, &["fetch", "-q", "origin"]).await;
    git(&fx, &["reset", "-q", "--hard", "origin/main"]).await;

    git(&fx, &["checkout", "-q", "-b", "feature"]).await;
    let seed_sha = git(&fx, &["rev-parse", "main"]).await;
    write_file(&fx, "feature.txt", "feature work\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "feature commit"]).await;

    write_file(&origin, "advance.txt", "advance\n").await;
    git(&origin, &["add", "-A"]).await;
    git(&origin, &["commit", "-q", "-m", "origin advances"]).await;
    let new_origin_tip = git(&origin, &["rev-parse", "HEAD"]).await;

    git(&fx, &["fetch", "-q", "origin", "main"]).await;
    let stale_local_main = git(&fx, &["rev-parse", "main"]).await;
    let fresh_origin_main = git(&fx, &["rev-parse", "origin/main"]).await;
    assert_eq!(stale_local_main, seed_sha);
    assert_eq!(fresh_origin_main, new_origin_tip);

    git(
        &fx,
        &["merge", "-q", "-m", "sync with origin/main", "origin/main"],
    )
    .await;

    let resolved = resolve_base_sha(fx.dir.to_str().unwrap(), Some("main"), None)
        .await
        .unwrap()
        .expect("must resolve");
    assert_eq!(resolved, new_origin_tip);
    assert_ne!(resolved, stale_local_main);

    rm_git_fixture(&fx).await;
    rm_git_fixture(&origin).await;
}

#[tokio::test]
async fn prefers_the_local_base_branch_when_local_is_more_advanced() {
    let origin = git_fixture("vst-git-resolve-base-origin2-test").await;
    write_file(&origin, "seed.txt", "seed\n").await;
    git(&origin, &["add", "-A"]).await;
    git(&origin, &["commit", "-q", "-m", "origin seed commit"]).await;

    let fx = git_fixture("vst-git-resolve-base-clone2-test").await;
    git(
        &fx,
        &["remote", "add", "origin", origin.dir.to_str().unwrap()],
    )
    .await;
    git(&fx, &["fetch", "-q", "origin"]).await;
    git(&fx, &["reset", "-q", "--hard", "origin/main"]).await;

    git(&fx, &["checkout", "-q", "-b", "feature"]).await;
    let seed_sha = git(&fx, &["rev-parse", "main"]).await;
    write_file(&fx, "feature.txt", "feature work\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "feature commit"]).await;

    git(&fx, &["checkout", "-q", "main"]).await;
    write_file(&fx, "advance.txt", "advance\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "local main advances"]).await;
    let new_local_main_tip = git(&fx, &["rev-parse", "main"]).await;

    let stale_origin_main = git(&fx, &["rev-parse", "origin/main"]).await;
    assert_eq!(stale_origin_main, seed_sha);

    git(&fx, &["checkout", "-q", "feature"]).await;
    git(&fx, &["merge", "-q", "-m", "sync with local main", "main"]).await;

    let resolved = resolve_base_sha(fx.dir.to_str().unwrap(), Some("main"), None)
        .await
        .unwrap()
        .expect("must resolve");
    assert_eq!(resolved, new_local_main_tip);
    assert_ne!(resolved, stale_origin_main);

    rm_git_fixture(&fx).await;
    rm_git_fixture(&origin).await;
}

#[tokio::test]
async fn falls_back_to_the_local_base_branch_when_origin_doesnt_resolve() {
    let no_remote = git_fixture("vst-git-resolve-base-noremote-test").await;
    write_file(&no_remote, "a.txt", "a\n").await;
    git(&no_remote, &["add", "-A"]).await;
    git(&no_remote, &["commit", "-q", "-m", "commit 1"]).await;
    let local_main_tip = git(&no_remote, &["rev-parse", "main"]).await;

    git(&no_remote, &["checkout", "-q", "-b", "feature"]).await;
    write_file(&no_remote, "b.txt", "b\n").await;
    git(&no_remote, &["add", "-A"]).await;
    git(&no_remote, &["commit", "-q", "-m", "feature commit"]).await;

    let resolved = resolve_base_sha(no_remote.dir.to_str().unwrap(), Some("main"), None)
        .await
        .unwrap()
        .expect("must resolve");
    assert_eq!(resolved, local_main_tip);
    rm_git_fixture(&no_remote).await;
}
