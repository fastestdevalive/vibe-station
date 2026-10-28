//! `file_diff` and `rename_map` against a throwaway git repo.

use std::path::Path;
use std::process::Command;

use vst_git::{file_diff, rename_map};
use vst_types::review::DiffScope;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("spawn git");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    git(d.path(), &["init", "-q", "-b", "main"]);
    git(d.path(), &["config", "user.email", "t@example.com"]);
    git(d.path(), &["config", "user.name", "T"]);
    d
}

fn body(n: usize) -> String {
    (1..=n)
        .map(|i| format!("line number {i} of the file\n"))
        .collect()
}

#[tokio::test]
async fn local_file_diff_is_plain_text_against_head() {
    let d = repo();
    std::fs::write(d.path().join("a.txt"), body(10)).unwrap();
    git(d.path(), &["add", "."]);
    git(d.path(), &["commit", "-qm", "init"]);
    let mut changed = body(10);
    changed = changed.replace("line number 4 of the file", "line number FOUR of the file");
    std::fs::write(d.path().join("a.txt"), changed).unwrap();

    let diff = file_diff(d.path(), DiffScope::Local, None, "a.txt", None)
        .await
        .unwrap();
    assert!(diff.contains("-line number 4 of the file"), "{diff}");
    assert!(diff.contains("+line number FOUR of the file"));
    assert!(!diff.contains('\u{1b}'), "no color codes");
}

#[tokio::test]
async fn an_untracked_file_diffs_against_dev_null() {
    let d = repo();
    std::fs::write(d.path().join("seed.txt"), "s\n").unwrap();
    git(d.path(), &["add", "."]);
    git(d.path(), &["commit", "-qm", "init"]);
    std::fs::write(d.path().join("new.txt"), "fresh\n").unwrap();
    let diff = file_diff(d.path(), DiffScope::Local, None, "new.txt", None)
        .await
        .unwrap();
    assert!(diff.contains("+fresh"), "{diff}");
}

#[tokio::test]
async fn branch_diff_uses_the_base_sha() {
    let d = repo();
    std::fs::write(d.path().join("a.txt"), body(5)).unwrap();
    git(d.path(), &["add", "."]);
    git(d.path(), &["commit", "-qm", "base"]);
    let base = git(d.path(), &["rev-parse", "HEAD"]);
    std::fs::write(d.path().join("a.txt"), body(6)).unwrap();
    git(d.path(), &["commit", "-qam", "more"]);
    // Working tree == HEAD: local scope is empty, branch scope shows the commit.
    let local = file_diff(d.path(), DiffScope::Local, None, "a.txt", None)
        .await
        .unwrap();
    assert!(local.is_empty());
    let branch = file_diff(d.path(), DiffScope::Branch, Some(&base), "a.txt", None)
        .await
        .unwrap();
    assert!(branch.contains("+line number 6 of the file"));
}

#[tokio::test]
async fn in_repo_rename_is_found_by_rename_map_in_both_scopes() {
    let d = repo();
    std::fs::create_dir(d.path().join("src")).unwrap();
    std::fs::write(d.path().join("src/old.rs"), body(30)).unwrap();
    std::fs::write(d.path().join("keep.rs"), body(8)).unwrap();
    git(d.path(), &["add", "."]);
    git(d.path(), &["commit", "-qm", "base"]);
    let base = git(d.path(), &["rev-parse", "HEAD"]);

    // Local: a staged `git mv` is a rename against HEAD.
    git(d.path(), &["mv", "src/old.rs", "src/new.rs"]);
    let local = rename_map(d.path(), DiffScope::Local, None).await.unwrap();
    assert_eq!(
        local.get("src/old.rs").map(String::as_str),
        Some("src/new.rs")
    );
    assert!(!local.contains_key("keep.rs"));

    // Branch: after committing, HEAD no longer shows it but the base does.
    git(d.path(), &["commit", "-qm", "move"]);
    assert!(rename_map(d.path(), DiffScope::Local, None)
        .await
        .unwrap()
        .is_empty());
    let branch = rename_map(d.path(), DiffScope::Branch, Some(&base))
        .await
        .unwrap();
    assert_eq!(
        branch.get("src/old.rs").map(String::as_str),
        Some("src/new.rs")
    );

    // The old-side diff of the moved file pairs with the old path.
    let diff = file_diff(
        d.path(),
        DiffScope::Branch,
        Some(&base),
        "src/new.rs",
        Some("src/old.rs"),
    )
    .await
    .unwrap();
    assert!(diff.contains("rename from src/old.rs"), "{diff}");
}

#[tokio::test]
async fn git_dir_of_a_linked_worktree_lives_outside_the_worktree_root() {
    let d = repo();
    std::fs::write(d.path().join("a.txt"), "x\n").unwrap();
    git(d.path(), &["add", "."]);
    git(d.path(), &["commit", "-qm", "init"]);
    let main = vst_git::git_dir(d.path()).await.unwrap();
    assert!(main.ends_with(".git"), "{main:?}");

    let linked = tempfile::tempdir().unwrap();
    let wt = linked.path().join("wt");
    git(
        d.path(),
        &["worktree", "add", "-q", "-b", "feat", wt.to_str().unwrap()],
    );
    let gd = vst_git::git_dir(&wt).await.unwrap();
    assert!(!gd.starts_with(&wt));
    assert!(gd.to_string_lossy().contains("worktrees"), "{gd:?}");
    assert!(gd.join("HEAD").is_file());
    assert!(
        vst_git::git_dir(linked.path()).await.is_err(),
        "not a checkout"
    );
}

#[tokio::test]
async fn option_shaped_base_sha_is_rejected_and_writes_nothing() {
    let d = repo();
    std::fs::write(d.path().join("a.txt"), body(5)).unwrap();
    git(d.path(), &["add", "."]);
    git(d.path(), &["commit", "-qm", "base"]);
    let out = d.path().join("pwned.txt");
    let evil = format!("--output={}", out.display());
    let err = file_diff(d.path(), DiffScope::Branch, Some(&evil), "a.txt", None)
        .await
        .unwrap_err();
    assert!(matches!(err, vst_git::DiffTextError::InvalidBase), "{err}");
    let err = rename_map(d.path(), DiffScope::Branch, Some(&evil))
        .await
        .unwrap_err();
    assert!(matches!(err, vst_git::DiffTextError::InvalidBase), "{err}");
    assert!(!out.exists(), "git must not have written the --output file");
    // A short hex abbreviation still works (and `--end-of-options` is accepted by git).
    let head = git(d.path(), &["rev-parse", "HEAD"]);
    file_diff(d.path(), DiffScope::Branch, Some(&head[..7]), "a.txt", None)
        .await
        .unwrap();
    assert!(vst_git::is_valid_base_sha(&head));
    assert!(!vst_git::is_valid_base_sha("--output=x"));
    assert!(!vst_git::is_valid_base_sha("abc"));
    assert!(!vst_git::is_valid_base_sha("ABCDEF1"));
}
