//! Behavior contract for `git.ts`'s `listSubmodules` (part 03-git-worktree).
//! Ported from `daemon/src/__tests__/git.submodules.test.ts`.

mod common;

use common::{git, git_fixture, rm_git_fixture};
use vst_git::git::{
    commit_exists, list_commits, list_submodules, resolve_submodule_dir, submodule_pin_at,
    SubmoduleDirError, SubmoduleStatus,
};
use vst_testkit::GitFixture;

#[tokio::test]
async fn repo_with_no_gitmodules_returns_empty_without_throwing() {
    let fx = git_fixture("vst-git-submodules-outer-test").await;
    let result = list_submodules(fx.dir.to_str().unwrap()).await;
    assert!(result.is_empty());
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn empty_repo_returns_empty_without_throwing() {
    let fx = git_fixture("vst-git-submodules-empty-test").await;
    let result = list_submodules(fx.dir.to_str().unwrap()).await;
    assert!(result.is_empty());
    rm_git_fixture(&fx).await;
}

#[tokio::test]
async fn initialized_submodule_populates_all_fields() {
    let sub = git_fixture("vst-git-submodules-sub-test").await;
    git(
        &sub,
        &[
            "commit",
            "--allow-empty",
            "-q",
            "-m",
            "submodule initial commit",
        ],
    )
    .await;

    let outer = git_fixture("vst-git-submodules-outer-test").await;
    git(
        &outer,
        &[
            "commit",
            "--allow-empty",
            "-q",
            "-m",
            "outer initial commit",
        ],
    )
    .await;
    git(
        &outer,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            sub.dir.to_str().unwrap(),
            "vendor/widget",
        ],
    )
    .await;
    git(
        &outer,
        &["commit", "-q", "-m", "add vendor/widget submodule"],
    )
    .await;

    let sub_sha = git(&sub, &["rev-parse", "HEAD"]).await;

    let result = list_submodules(outer.dir.to_str().unwrap()).await;
    assert_eq!(result.len(), 1);
    let entry = &result[0];
    assert_eq!(entry.path, "vendor/widget");
    assert_eq!(entry.sha.as_deref(), Some(sub_sha.as_str()));
    assert_eq!(entry.short_sha.as_deref(), Some(&sub_sha[..7]));
    assert_eq!(entry.subject.as_deref(), Some("submodule initial commit"));
    assert_eq!(entry.status, SubmoduleStatus::Clean);
    assert_eq!(entry.branch, None);

    rm_git_fixture(&outer).await;
    rm_git_fixture(&sub).await;
}

#[tokio::test]
async fn gitmodules_branch_entry_is_surfaced_on_the_matching_submodule() {
    let sub = git_fixture("vst-git-submodules-sub-test").await;
    git(
        &sub,
        &[
            "commit",
            "--allow-empty",
            "-q",
            "-m",
            "submodule initial commit",
        ],
    )
    .await;
    git(&sub, &["branch", "-m", "main", "feature-x"]).await;

    let outer = git_fixture("vst-git-submodules-outer-test").await;
    git(
        &outer,
        &[
            "commit",
            "--allow-empty",
            "-q",
            "-m",
            "outer initial commit",
        ],
    )
    .await;
    git(
        &outer,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            "-b",
            "feature-x",
            sub.dir.to_str().unwrap(),
            "vendor/widget",
        ],
    )
    .await;
    git(
        &outer,
        &[
            "commit",
            "-q",
            "-m",
            "add vendor/widget submodule tracking feature-x",
        ],
    )
    .await;

    let result = list_submodules(outer.dir.to_str().unwrap()).await;
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].branch.as_deref(), Some("feature-x"));

    rm_git_fixture(&outer).await;
    rm_git_fixture(&sub).await;
}

#[tokio::test]
async fn uninitialized_submodule_has_sha_no_subject_and_status_uninitialized() {
    let sub = git_fixture("vst-git-submodules-sub-test").await;
    git(
        &sub,
        &[
            "commit",
            "--allow-empty",
            "-q",
            "-m",
            "submodule initial commit",
        ],
    )
    .await;
    let sub_sha = git(&sub, &["rev-parse", "HEAD"]).await;

    let outer = git_fixture("vst-git-submodules-outer-test").await;
    git(
        &outer,
        &[
            "commit",
            "--allow-empty",
            "-q",
            "-m",
            "outer initial commit",
        ],
    )
    .await;
    git(
        &outer,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            sub.dir.to_str().unwrap(),
            "vendor/widget",
        ],
    )
    .await;
    git(
        &outer,
        &["commit", "-q", "-m", "add vendor/widget submodule"],
    )
    .await;

    git(&outer, &["submodule", "deinit", "-f", "vendor/widget"]).await;

    let result = list_submodules(outer.dir.to_str().unwrap()).await;
    assert_eq!(result.len(), 1);
    let entry = &result[0];
    assert_eq!(entry.path, "vendor/widget");
    assert_eq!(entry.sha.as_deref(), Some(sub_sha.as_str()));
    assert_eq!(entry.subject, None);
    assert_eq!(entry.status, SubmoduleStatus::Uninitialized);

    rm_git_fixture(&outer).await;
    rm_git_fixture(&sub).await;
}

#[tokio::test]
async fn corrupted_repo_fails_open_to_empty() {
    let sub = git_fixture("vst-git-submodules-sub-test").await;
    git(
        &sub,
        &[
            "commit",
            "--allow-empty",
            "-q",
            "-m",
            "submodule initial commit",
        ],
    )
    .await;

    let outer = git_fixture("vst-git-submodules-outer-test").await;
    git(
        &outer,
        &[
            "commit",
            "--allow-empty",
            "-q",
            "-m",
            "outer initial commit",
        ],
    )
    .await;
    git(
        &outer,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            sub.dir.to_str().unwrap(),
            "vendor/widget",
        ],
    )
    .await;
    git(
        &outer,
        &["commit", "-q", "-m", "add vendor/widget submodule"],
    )
    .await;

    std::fs::remove_dir_all(outer.dir.join(".git")).unwrap();

    let result = list_submodules(outer.dir.to_str().unwrap()).await;
    assert!(result.is_empty());

    rm_git_fixture(&outer).await;
    rm_git_fixture(&sub).await;
}

#[tokio::test]
async fn dirty_working_tree_at_the_pinned_commit_is_reported_modified() {
    let sub = git_fixture("vst-git-submodules-sub-test").await;
    git(
        &sub,
        &[
            "commit",
            "--allow-empty",
            "-q",
            "-m",
            "submodule initial commit",
        ],
    )
    .await;

    let outer = git_fixture("vst-git-submodules-outer-test").await;
    git(
        &outer,
        &[
            "commit",
            "--allow-empty",
            "-q",
            "-m",
            "outer initial commit",
        ],
    )
    .await;
    git(
        &outer,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            sub.dir.to_str().unwrap(),
            "vendor/widget",
        ],
    )
    .await;
    git(
        &outer,
        &["commit", "-q", "-m", "add vendor/widget submodule"],
    )
    .await;

    std::fs::write(
        outer.dir.join("vendor/widget/dirty.txt"),
        "uncommitted change\n",
    )
    .unwrap();

    let result = list_submodules(outer.dir.to_str().unwrap()).await;
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].status, SubmoduleStatus::Modified);

    rm_git_fixture(&outer).await;
    rm_git_fixture(&sub).await;
}

#[tokio::test]
async fn out_of_date_takes_precedence_over_a_dirty_working_tree() {
    let sub = git_fixture("vst-git-submodules-sub-test").await;
    git(&sub, &["commit", "--allow-empty", "-q", "-m", "c1"]).await;
    git(&sub, &["commit", "--allow-empty", "-q", "-m", "c2"]).await;
    let c1_sha = git(&sub, &["rev-parse", "HEAD~1"]).await;

    let outer = git_fixture("vst-git-submodules-outer-test").await;
    git(
        &outer,
        &[
            "commit",
            "--allow-empty",
            "-q",
            "-m",
            "outer initial commit",
        ],
    )
    .await;
    git(
        &outer,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            sub.dir.to_str().unwrap(),
            "vendor/widget",
        ],
    )
    .await;
    git(
        &outer,
        &[
            "commit",
            "-q",
            "-m",
            "add vendor/widget submodule pinned at c2",
        ],
    )
    .await;

    git(&outer, &["-C", "vendor/widget", "checkout", "-q", &c1_sha]).await;
    std::fs::write(
        outer.dir.join("vendor/widget/dirty.txt"),
        "uncommitted change\n",
    )
    .unwrap();

    let result = list_submodules(outer.dir.to_str().unwrap()).await;
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].status, SubmoduleStatus::OutOfDate);

    rm_git_fixture(&outer).await;
    rm_git_fixture(&sub).await;
}

#[tokio::test]
async fn multiple_submodules_are_all_returned_and_independently_resolved() {
    let sub1 = git_fixture("vst-git-submodules-sub1-test").await;
    let sub2 = git_fixture("vst-git-submodules-sub2-test").await;
    git(
        &sub1,
        &["commit", "--allow-empty", "-q", "-m", "sub1 commit"],
    )
    .await;
    git(
        &sub2,
        &["commit", "--allow-empty", "-q", "-m", "sub2 commit"],
    )
    .await;

    let outer = git_fixture("vst-git-submodules-outer-test").await;
    git(
        &outer,
        &[
            "commit",
            "--allow-empty",
            "-q",
            "-m",
            "outer initial commit",
        ],
    )
    .await;
    git(
        &outer,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            sub1.dir.to_str().unwrap(),
            "vendor/one",
        ],
    )
    .await;
    git(
        &outer,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            sub2.dir.to_str().unwrap(),
            "vendor/two",
        ],
    )
    .await;
    git(&outer, &["commit", "-q", "-m", "add two submodules"]).await;

    let result = list_submodules(outer.dir.to_str().unwrap()).await;
    let mut paths: Vec<&str> = result.iter().map(|r| r.path.as_str()).collect();
    paths.sort_unstable();
    assert_eq!(paths, vec!["vendor/one", "vendor/two"]);
    assert!(result.iter().all(|r| r.status == SubmoduleStatus::Clean));

    rm_git_fixture(&outer).await;
    rm_git_fixture(&sub1).await;
    rm_git_fixture(&sub2).await;
}

/// Adds a commit in `sub` then registers it as `vendor/widget` in `outer`.
/// Returns the submodule's HEAD sha.
async fn add_submodule(outer: &GitFixture, sub: &GitFixture, path: &str) -> String {
    git(
        sub,
        &["commit", "--allow-empty", "-q", "-m", "submodule commit"],
    )
    .await;
    let sha = git(sub, &["rev-parse", "HEAD"]).await;
    git(
        outer,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            sub.dir.to_str().unwrap(),
            path,
        ],
    )
    .await;
    git(outer, &["commit", "-q", "-m", &format!("add {path} submodule")]).await;
    sha
}

#[tokio::test]
async fn resolve_submodule_dir_returns_ok_for_an_initialized_submodule() {
    let sub = git_fixture("vst-git-submodule-resolve-sub-test").await;
    let outer = git_fixture("vst-git-submodule-resolve-outer-test").await;
    git(&outer, &["commit", "--allow-empty", "-q", "-m", "outer"]).await;
    add_submodule(&outer, &sub, "vendor/widget").await;

    let dir = resolve_submodule_dir(outer.dir.to_str().unwrap(), "vendor/widget")
        .await
        .unwrap();
    assert_eq!(dir, outer.dir.join("vendor/widget"));

    rm_git_fixture(&outer).await;
    rm_git_fixture(&sub).await;
}

#[tokio::test]
async fn resolve_submodule_dir_rejects_unknown_dotdot_and_absolute_paths() {
    let sub = git_fixture("vst-git-submodule-resolve-sub-test").await;
    let outer = git_fixture("vst-git-submodule-resolve-outer-test").await;
    git(&outer, &["commit", "--allow-empty", "-q", "-m", "outer"]).await;
    add_submodule(&outer, &sub, "vendor/widget").await;

    let repo = outer.dir.to_str().unwrap();
    for bad in ["vendor/other", "vendor/../widget", "/vendor/widget", ""] {
        assert_eq!(
            resolve_submodule_dir(repo, bad).await,
            Err(SubmoduleDirError::NotFound),
            "expected NotFound for {bad:?}"
        );
    }

    rm_git_fixture(&outer).await;
    rm_git_fixture(&sub).await;
}

#[tokio::test]
async fn resolve_submodule_dir_returns_not_initialized_and_never_main_repo_commits() {
    let sub = git_fixture("vst-git-submodule-resolve-sub-test").await;
    let outer = git_fixture("vst-git-submodule-resolve-outer-test").await;
    git(&outer, &["commit", "--allow-empty", "-q", "-m", "outer"]).await;
    add_submodule(&outer, &sub, "vendor/widget").await;
    git(&outer, &["submodule", "deinit", "-f", "vendor/widget"]).await;

    let repo = outer.dir.to_str().unwrap();
    assert_eq!(
        resolve_submodule_dir(repo, "vendor/widget").await,
        Err(SubmoduleDirError::NotInitialized)
    );

    // The route rejects BEFORE ever running git on the submodule dir, so the
    // uninitialized empty dir can never fall through to the main repo's
    // history/diff (git searches upward out of an empty folder).

    rm_git_fixture(&outer).await;
    rm_git_fixture(&sub).await;
}

#[tokio::test]
async fn submodule_pin_at_returns_base_pin_and_none_when_added_later() {
    let sub = git_fixture("vst-git-submodule-pin-sub-test").await;
    let outer = git_fixture("vst-git-submodule-pin-outer-test").await;
    git(&outer, &["commit", "--allow-empty", "-q", "-m", "before sub"]).await;
    let base = git(&outer, &["rev-parse", "HEAD"]).await;
    let sub_sha = add_submodule(&outer, &sub, "vendor/widget").await;
    let head = git(&outer, &["rev-parse", "HEAD"]).await;

    let repo = outer.dir.to_str().unwrap();
    // Base commit predates the submodule — no gitlink there.
    assert_eq!(submodule_pin_at(repo, &base, "vendor/widget").await, None);
    // HEAD pins the gitlink at the submodule's HEAD sha.
    assert_eq!(
        submodule_pin_at(repo, &head, "vendor/widget").await,
        Some(sub_sha)
    );

    rm_git_fixture(&outer).await;
    rm_git_fixture(&sub).await;
}

#[tokio::test]
async fn list_commits_on_resolved_dir_returns_submodule_commits() {
    let sub = git_fixture("vst-git-submodule-list-sub-test").await;
    let outer = git_fixture("vst-git-submodule-list-outer-test").await;
    git(&outer, &["commit", "--allow-empty", "-q", "-m", "outer"]).await;
    add_submodule(&outer, &sub, "vendor/widget").await;

    let dir = resolve_submodule_dir(outer.dir.to_str().unwrap(), "vendor/widget")
        .await
        .unwrap();
    let commits = list_commits(dir.to_str().unwrap(), 200, None)
        .await
        .unwrap();
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0].subject, "submodule commit");
    // The main repo's own commit must not leak into the submodule's log.
    assert!(commits.iter().all(|c| c.subject != "outer"));

    rm_git_fixture(&outer).await;
    rm_git_fixture(&sub).await;
}

#[tokio::test]
async fn commit_exists_reflects_object_store_membership() {
    let sub = git_fixture("vst-git-submodule-exists-sub-test").await;
    let outer = git_fixture("vst-git-submodule-exists-outer-test").await;
    git(&outer, &["commit", "--allow-empty", "-q", "-m", "outer"]).await;
    let outer_sha = add_submodule(&outer, &sub, "vendor/widget").await;
    let dir = resolve_submodule_dir(outer.dir.to_str().unwrap(), "vendor/widget")
        .await
        .unwrap();

    // The submodule HEAD is in the submodule's store but not the main repo's.
    assert!(commit_exists(dir.to_str().unwrap(), &outer_sha).await);
    assert!(!commit_exists(outer.dir.to_str().unwrap(), &outer_sha).await);
    assert!(!commit_exists(dir.to_str().unwrap(), "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef").await);

    rm_git_fixture(&outer).await;
    rm_git_fixture(&sub).await;
}
