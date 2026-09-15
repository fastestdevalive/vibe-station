//! Behavior contract for `git.ts`'s commit-list half (part 03-git-worktree).
//! Ported from `daemon/src/__tests__/git.commits.test.ts`.

mod common;

use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use common::{git, git_fixture, rm_git_fixture};
use vst_git::git::{
    get_diff_stat, list_commits, resolve_parent_sha, CommitLogEntry, EMPTY_TREE_SHA,
};
use vst_testkit::GitFixture;

async fn write_file(fx: &GitFixture, name: &str, content: &str) {
    let path = fx.dir.join(name);
    std::fs::write(path, content).unwrap();
}

#[tokio::test]
async fn empty_repo_returns_empty_list_without_throwing() {
    let fx = git_fixture("vst-git-commits-test").await;
    let commits = list_commits(fx.dir.to_str().unwrap(), 200, None)
        .await
        .unwrap();
    assert!(commits.is_empty());
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn binary_file_excluded_from_diffstat_sum_but_text_file_counted() {
    let fx = git_fixture("vst-git-commits-test").await;
    write_file(&fx, "text.txt", "one\ntwo\nthree\n").await;
    std::fs::write(fx.dir.join("blob.bin"), [0x00, 0x01, 0x02, 0x03]).unwrap();
    git(&fx, &["add", "-A"]).await;
    git(
        &fx,
        &[
            "commit",
            "-q",
            "-m",
            "add text file and binary blob together",
        ],
    )
    .await;

    let commits = list_commits(fx.dir.to_str().unwrap(), 200, None)
        .await
        .unwrap();
    assert_eq!(commits.len(), 1);
    let c = &commits[0];
    assert!(c.has_binary_changes);
    assert_eq!(c.insertions, 3);
    assert_eq!(c.deletions, 0);
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn subject_containing_delimiter_bytes_does_not_corrupt_the_commit_list() {
    let fx = git_fixture("vst-git-commits-test").await;
    write_file(&fx, "a.txt", "a\n").await;
    git(&fx, &["add", "-A"]).await;
    let msg_file = std::env::temp_dir().join(format!(
        "vst-adversarial-msg-{}-{}",
        std::process::id(),
        epoch_ms()
    ));
    std::fs::write(&msg_file, "evil\x1esubject\x1fwith-delimiters").unwrap();
    git(&fx, &["commit", "-q", "-F", msg_file.to_str().unwrap()]).await;
    std::fs::remove_file(&msg_file).unwrap();

    write_file(&fx, "b.txt", "b\nb2\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "normal follow-up commit"]).await;

    let commits = list_commits(fx.dir.to_str().unwrap(), 200, None)
        .await
        .unwrap();
    let follow_up = commits
        .iter()
        .find(|c| c.subject == "normal follow-up commit");
    assert!(follow_up.is_some());
    assert_eq!(follow_up.unwrap().insertions, 2);
    for c in &commits {
        assert!(is_full_sha(&c.sha), "bad sha {:?}", c.sha);
    }
    let adversarial = commits.iter().find(|c| c.subject == "evil");
    assert!(adversarial.is_some());
    assert_eq!(adversarial.unwrap().insertions, 0);
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn multi_paragraph_body_round_trips_through_attach_full_bodies() {
    let fx = git_fixture("vst-git-commits-test").await;
    write_file(&fx, "a.txt", "a\n").await;
    git(&fx, &["add", "-A"]).await;
    let body =
        "First paragraph of the body.\n\nSecond paragraph, with more detail\nspanning two lines.";
    git(
        &fx,
        &["commit", "-q", "-m", "adversarial body commit", "-m", body],
    )
    .await;

    let commits = list_commits(fx.dir.to_str().unwrap(), 200, None)
        .await
        .unwrap();
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0].subject, "adversarial body commit");
    assert_eq!(
        commits[0].body,
        format!("adversarial body commit\n\n{body}")
    );
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn commit_with_no_body_has_body_equal_subject_and_metadata_populated() {
    let fx = git_fixture("vst-git-commits-test").await;
    write_file(&fx, "a.txt", "a\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["config", "user.name", "Ada Lovelace"]).await;
    git(&fx, &["config", "user.email", "ada@example.com"]).await;
    git(&fx, &["commit", "-q", "-m", "single line commit"]).await;

    let commits = list_commits(fx.dir.to_str().unwrap(), 200, None)
        .await
        .unwrap();
    assert_eq!(commits.len(), 1);
    let c = &commits[0];
    assert_eq!(c.subject, "single line commit");
    assert_eq!(c.body, "single line commit");
    assert!(is_full_sha(&c.sha));
    assert_eq!(c.short_sha, &c.sha[..7]);
    assert_eq!(c.author_name, "Ada Lovelace");
    assert_eq!(c.author_email, "ada@example.com");
    assert!(c.date.starts_with(|d: char| d.is_ascii_digit()));
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn merge_commits_get_a_real_first_parent_diffstat() {
    let fx = git_fixture("vst-git-commits-test").await;
    write_file(&fx, "base.txt", "base\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "base commit"]).await;

    git(&fx, &["checkout", "-q", "-b", "feature"]).await;
    write_file(&fx, "feature.txt", "line one\nline two\nline three\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "feature commit"]).await;

    git(&fx, &["checkout", "-q", "main"]).await;
    git(
        &fx,
        &[
            "merge",
            "-q",
            "--no-ff",
            "-m",
            "merge feature into main",
            "feature",
        ],
    )
    .await;

    let commits = list_commits(fx.dir.to_str().unwrap(), 200, None)
        .await
        .unwrap();
    let merge = commits
        .iter()
        .find(|c| c.subject == "merge feature into main")
        .unwrap();
    assert_eq!(merge.insertions, 3);
    assert_eq!(merge.deletions, 0);
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn is_on_branch_true_since_base_sha_and_false_at_or_before_it() {
    let fx = git_fixture("vst-git-commits-test").await;
    write_file(&fx, "a.txt", "a\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "base commit 1"]).await;
    write_file(&fx, "b.txt", "b\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "base commit 2"]).await;
    let base_sha = git(&fx, &["rev-parse", "HEAD"]).await;

    write_file(&fx, "c.txt", "c\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "own commit 1"]).await;
    write_file(&fx, "d.txt", "d\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "own commit 2"]).await;

    let commits = list_commits(fx.dir.to_str().unwrap(), 200, Some(&base_sha))
        .await
        .unwrap();
    let by_subject: std::collections::HashMap<&str, &CommitLogEntry> =
        commits.iter().map(|c| (c.subject.as_str(), c)).collect();
    assert!(by_subject["own commit 2"].is_on_branch);
    assert!(by_subject["own commit 1"].is_on_branch);
    assert!(!by_subject["base commit 2"].is_on_branch);
    assert!(!by_subject["base commit 1"].is_on_branch);
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn no_base_sha_every_commit_is_conservatively_on_branch() {
    let fx = git_fixture("vst-git-commits-test").await;
    write_file(&fx, "a.txt", "a\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "commit 1"]).await;
    write_file(&fx, "b.txt", "b\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "commit 2"]).await;

    let commits = list_commits(fx.dir.to_str().unwrap(), 200, None)
        .await
        .unwrap();
    assert_eq!(commits.len(), 2);
    assert!(commits.iter().all(|c| c.is_on_branch));
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn invalid_base_sha_fails_open_leaving_every_commit_on_branch() {
    let fx = git_fixture("vst-git-commits-test").await;
    write_file(&fx, "a.txt", "a\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "commit 1"]).await;

    let bogus = "0".repeat(40);
    let commits = list_commits(fx.dir.to_str().unwrap(), 200, Some(&bogus))
        .await
        .unwrap();
    assert_eq!(commits.len(), 1);
    assert!(commits[0].is_on_branch);
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn resolve_parent_sha_returns_the_correct_parent_for_a_non_root_commit() {
    let fx = git_fixture("vst-git-resolveparentsha-test").await;
    write_file(&fx, "a.txt", "a\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "first"]).await;
    let first_sha = git(&fx, &["rev-parse", "HEAD"]).await;

    write_file(&fx, "b.txt", "b\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "second"]).await;
    let second_sha = git(&fx, &["rev-parse", "HEAD"]).await;

    let parent = resolve_parent_sha(fx.dir.to_str().unwrap(), &second_sha)
        .await
        .unwrap();
    assert_eq!(parent, first_sha);
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn resolve_parent_sha_falls_back_to_empty_tree_for_a_root_commit() {
    let fx = git_fixture("vst-git-resolveparentsha-test").await;
    write_file(&fx, "a.txt", "a\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "root commit"]).await;
    let root_sha = git(&fx, &["rev-parse", "HEAD"]).await;

    let parent = resolve_parent_sha(fx.dir.to_str().unwrap(), &root_sha)
        .await
        .unwrap();
    assert_eq!(parent, EMPTY_TREE_SHA);
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn resolve_parent_sha_propagates_error_for_an_unresolvable_sha() {
    let fx = git_fixture("vst-git-resolveparentsha-test").await;
    write_file(&fx, "a.txt", "a\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "root commit"]).await;

    let bogus = "0".repeat(40);
    let res = resolve_parent_sha(fx.dir.to_str().unwrap(), &bogus).await;
    assert!(res.is_err());
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn get_diff_stat_parses_both_insertions_and_deletions() {
    let fx = git_fixture("vst-git-diffstat-test").await;
    write_file(&fx, "a.txt", "one\ntwo\nthree\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "base"]).await;
    let base_sha = git(&fx, &["rev-parse", "HEAD"]).await;

    write_file(&fx, "a.txt", "one\nTWO-CHANGED\nfour\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "modify"]).await;

    let stat = get_diff_stat(fx.dir.to_str().unwrap(), &base_sha)
        .await
        .unwrap();
    assert_eq!(stat.insertions, 2);
    assert_eq!(stat.deletions, 2);
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn get_diff_stat_parses_insertions_only() {
    let fx = git_fixture("vst-git-diffstat-test").await;
    write_file(&fx, "a.txt", "one\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "base"]).await;
    let base_sha = git(&fx, &["rev-parse", "HEAD"]).await;

    write_file(&fx, "b.txt", "new file\nline two\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "add file"]).await;

    let stat = get_diff_stat(fx.dir.to_str().unwrap(), &base_sha)
        .await
        .unwrap();
    assert_eq!(stat.insertions, 2);
    assert_eq!(stat.deletions, 0);
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn get_diff_stat_parses_deletions_only() {
    let fx = git_fixture("vst-git-diffstat-test").await;
    write_file(&fx, "a.txt", "one\ntwo\nthree\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "base"]).await;
    let base_sha = git(&fx, &["rev-parse", "HEAD"]).await;

    write_file(&fx, "a.txt", "one\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "remove lines"]).await;

    let stat = get_diff_stat(fx.dir.to_str().unwrap(), &base_sha)
        .await
        .unwrap();
    assert_eq!(stat.insertions, 0);
    assert_eq!(stat.deletions, 2);
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn get_diff_stat_returns_zeroes_when_no_changes() {
    let fx = git_fixture("vst-git-diffstat-test").await;
    write_file(&fx, "a.txt", "one\n").await;
    git(&fx, &["add", "-A"]).await;
    git(&fx, &["commit", "-q", "-m", "base"]).await;
    let base_sha = git(&fx, &["rev-parse", "HEAD"]).await;

    let stat = get_diff_stat(fx.dir.to_str().unwrap(), &base_sha)
        .await
        .unwrap();
    assert_eq!(stat.insertions, 0);
    assert_eq!(stat.deletions, 0);
    rm_git_fixture(&fx).await;
}

fn is_full_sha(s: &str) -> bool {
    s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit())
}

fn epoch_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
