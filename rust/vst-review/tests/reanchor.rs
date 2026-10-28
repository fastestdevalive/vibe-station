//! Re-anchoring at the public handle of the review owner: delete / restore,
//! batched events, in-repo renames, artifact moves, lost events, the watch
//! limit, purge, and the watch-driven loop end to end.

mod common;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use common::{body, Env};
use tokio::sync::broadcast;
use vst_artifacts::ArtifactChange;
use vst_fswatch::path_watcher::{DirBackend, PathWatcher, WatchEvent};
use vst_review::ReviewHandle;
use vst_types::artifacts::ScopeKey;
use vst_types::review::{
    AnchorReason, AnchorState, CommentSurface, DiffScope, DiffSide, LineSpan, PathKind,
    ReviewComment,
};
use vst_types::{Broadcaster, ServerEvent};

struct Null;
impl DirBackend for Null {
    fn watch_dir(&self, _: &Path) -> Result<(), String> {
        Ok(())
    }
    fn unwatch_dir(&self, _: &Path) {}
}

fn null_watcher(limit: usize) -> PathWatcher {
    PathWatcher::with_backend(|_| Arc::new(Null) as Arc<dyn DirBackend>, limit)
}

fn changed(path: &Path, scope: &ScopeKey) -> WatchEvent {
    WatchEvent::PathChanged {
        scope: scope.clone(),
        path: path.to_path_buf(),
    }
}

const FILE: &str = "alpha\nbeta quote here\ngamma\ndelta unique\n";

/// A file comment quoting `quote` at `line`.
fn file_comment(
    id: &str,
    path: &str,
    quote: &str,
    line: u32,
) -> vst_types::rest::review::CreateCommentBody {
    let mut b = body(id, path, line);
    b.quote = quote.into();
    b.prefix = String::new();
    b.suffix = String::new();
    b
}

async fn row(review: &ReviewHandle, scope: &ScopeKey, id: &str) -> ReviewComment {
    review
        .list(scope, None, false)
        .await
        .unwrap()
        .comments
        .into_iter()
        .find(|c| c.id == id)
        .expect("comment")
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn git_init(dir: &Path) {
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.email", "t@example.com"]);
    git(dir, &["config", "user.name", "T"]);
}

async fn next_changed(rx: &mut broadcast::Receiver<ServerEvent>) -> (Vec<ReviewComment>, usize) {
    loop {
        let ev = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .expect("a comments:changed within 10s")
            .expect("bus open");
        if let ServerEvent::CommentsChanged {
            upserted, deleted, ..
        } = ev
        {
            return (upserted, deleted.len());
        }
    }
}

#[tokio::test]
async fn delete_then_restore_flips_file_missing_and_anchored_with_one_batched_event() {
    let mut env = Env::new().await;
    let review = env.review_with(null_watcher(200), vec![env.wt.clone()]);
    let file = env.root().join("a.rs");
    std::fs::write(&file, FILE).unwrap();
    review
        .create(&env.wt, file_comment("c1", "a.rs", "beta quote here", 2))
        .await
        .unwrap();
    review
        .create(&env.wt, file_comment("c2", "a.rs", "delta unique", 4))
        .await
        .unwrap();
    review.flush_events();
    env.events();

    std::fs::remove_file(&file).unwrap();
    review.on_watch_event(changed(&file, &env.wt));
    review.on_watch_event(changed(&file, &env.wt));
    assert_eq!(review.flush_reanchor().await, 2);
    review.flush_events();
    let evs = env.events();
    assert_eq!(evs.len(), 1, "one batched event per scope per window");
    assert_eq!(evs[0].0.len(), 2);
    assert!(evs[0]
        .0
        .iter()
        .all(|c| c.anchor == AnchorState::FileMissing));
    assert_eq!(
        row(&review, &env.wt, "c1").await.version,
        1,
        "anchor writes never bump version"
    );

    std::fs::write(&file, FILE).unwrap();
    review.on_watch_event(changed(&file, &env.wt));
    assert_eq!(review.flush_reanchor().await, 2);
    review.flush_events();
    let evs = env.events();
    assert_eq!(evs.len(), 1);
    assert!(evs[0].0.iter().all(|c| c.anchor == AnchorState::Anchored));

    // Nothing changed: a re-check is silent.
    review.on_watch_event(changed(&file, &env.wt));
    assert_eq!(review.flush_reanchor().await, 0);
    review.flush_events();
    assert!(env.events().is_empty());
}

#[tokio::test]
async fn edits_move_the_span_and_a_removed_quote_goes_outdated() {
    let mut env = Env::new().await;
    let review = env.review_with(null_watcher(200), vec![env.wt.clone()]);
    let file = env.root().join("a.rs");
    std::fs::write(&file, FILE).unwrap();
    review
        .create(&env.wt, file_comment("c1", "a.rs", "beta quote here", 2))
        .await
        .unwrap();
    review.flush_events();
    env.events();

    std::fs::write(&file, format!("new\nnew\n{FILE}")).unwrap();
    review.on_watch_event(changed(&file, &env.wt));
    review.flush_reanchor().await;
    let c = row(&review, &env.wt, "c1").await;
    assert_eq!(c.anchor, AnchorState::Anchored);
    assert_eq!(c.current, Some(LineSpan { start: 4, end: 4 }));
    assert_eq!(c.quote, "beta quote here");

    std::fs::write(&file, "alpha\nsomething else\n").unwrap();
    review.on_watch_event(changed(&file, &env.wt));
    review.flush_reanchor().await;
    let c = row(&review, &env.wt, "c1").await;
    assert_eq!(c.anchor, AnchorState::Outdated);
    assert_eq!(c.quote, "beta quote here", "the original quote is kept");

    std::fs::write(&file, FILE).unwrap();
    review.on_watch_event(changed(&file, &env.wt));
    review.flush_reanchor().await;
    let c = row(&review, &env.wt, "c1").await;
    assert_eq!((c.anchor, c.current), (AnchorState::Anchored, None));
}

#[tokio::test]
async fn a_file_over_2_mb_is_cant_check_and_recovers() {
    let env = Env::new().await;
    let review = env.review_with(null_watcher(200), vec![env.wt.clone()]);
    let file = env.root().join("big.txt");
    std::fs::write(&file, FILE).unwrap();
    review
        .create(&env.wt, file_comment("c1", "big.txt", "delta unique", 4))
        .await
        .unwrap();
    std::fs::write(&file, "x".repeat(2 * 1024 * 1024 + 1)).unwrap();
    review.on_watch_event(changed(&file, &env.wt));
    review.flush_reanchor().await;
    let c = row(&review, &env.wt, "c1").await;
    assert_eq!(c.anchor, AnchorState::CantCheck);
    assert_eq!(c.anchor_reason, Some(AnchorReason::FileTooLarge));
    std::fs::write(&file, FILE).unwrap();
    review.on_watch_event(changed(&file, &env.wt));
    review.flush_reanchor().await;
    let c = row(&review, &env.wt, "c1").await;
    assert_eq!((c.anchor, c.anchor_reason), (AnchorState::Anchored, None));
}

#[tokio::test]
async fn markdown_comments_anchor_on_rendered_text() {
    let env = Env::new().await;
    let review = env.review_with(null_watcher(200), vec![env.wt.clone()]);
    let file = env.root().join("doc.md");
    std::fs::write(&file, "# T\n\nSome **bold** words.\n").unwrap();
    let mut b = file_comment("c1", "doc.md", "Some bold words.", 3);
    b.surface = CommentSurface::Markdown;
    review.create(&env.wt, b).await.unwrap();
    std::fs::write(&file, "# T\n\nintro\n\nSome **bold** words.\n").unwrap();
    review.on_watch_event(changed(&file, &env.wt));
    review.flush_reanchor().await;
    let c = row(&review, &env.wt, "c1").await;
    assert_eq!(
        (c.anchor, c.current),
        (AnchorState::Anchored, Some(LineSpan { start: 5, end: 5 }))
    );
}

#[tokio::test]
async fn in_repo_rename_follows_the_file_for_local_and_committed_moves() {
    let env = Env::new().await;
    let root = env.root();
    git_init(&root);
    std::fs::create_dir_all(root.join("src")).unwrap();
    let content: String = (1..=30)
        .map(|i| format!("unique line number {i}\n"))
        .collect();
    std::fs::write(root.join("src/old.rs"), &content).unwrap();
    std::fs::write(
        root.join("src/other.rs"),
        content.replace("unique", "other"),
    )
    .unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-qm", "base"]);
    let base = String::from_utf8(
        Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_string();

    let review = env.review_with(null_watcher(200), vec![env.wt.clone()]);
    review
        .create(
            &env.wt,
            file_comment("c1", "src/old.rs", "unique line number 12", 12),
        )
        .await
        .unwrap();
    let mut diff = file_comment("c2", "src/other.rs", "other line number 7", 7);
    diff.surface = CommentSurface::Diff;
    diff.diff_scope = Some(DiffScope::Branch);
    diff.base_sha = Some(base);
    diff.side = Some(DiffSide::New);
    diff.new_start = Some(7);
    diff.new_end = Some(7);
    diff.line_start = None;
    diff.line_end = None;
    review.create(&env.wt, diff).await.unwrap();

    // Local: a staged `git mv` is a rename against HEAD.
    git(&root, &["mv", "src/old.rs", "src/new.rs"]);
    review.on_watch_event(changed(&root.join("src/old.rs"), &env.wt));
    review.flush_reanchor().await;
    let c = row(&review, &env.wt, "c1").await;
    assert_eq!(
        (c.path.as_str(), c.moved_from.as_deref()),
        ("src/new.rs", Some("src/old.rs"))
    );
    assert_eq!(c.anchor, AnchorState::Anchored);

    // Committed: only the branch base still sees the rename.
    git(&root, &["mv", "src/other.rs", "src/moved.rs"]);
    git(&root, &["commit", "-qam", "moves"]);
    review.on_watch_event(changed(&root.join("src/other.rs"), &env.wt));
    review.flush_reanchor().await;
    let c = row(&review, &env.wt, "c2").await;
    assert_eq!(
        (c.path.as_str(), c.moved_from.as_deref()),
        ("src/moved.rs", Some("src/other.rs"))
    );
    assert_eq!(c.anchor, AnchorState::Anchored);

    // A file that is simply gone is missing.
    std::fs::remove_file(root.join("src/new.rs")).unwrap();
    review.on_watch_event(changed(&root.join("src/new.rs"), &env.wt));
    review.flush_reanchor().await;
    assert_eq!(
        row(&review, &env.wt, "c1").await.anchor,
        AnchorState::FileMissing
    );
}

#[tokio::test]
async fn moving_a_file_back_follows_it_back() {
    let env = Env::new().await;
    let root = env.root();
    git_init(&root);
    std::fs::create_dir_all(root.join("src")).unwrap();
    let content: String = (1..=30)
        .map(|i| format!("unique line number {i}\n"))
        .collect();
    std::fs::write(root.join("src/old.rs"), &content).unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-qm", "base"]);

    let review = env.review_with(null_watcher(200), vec![env.wt.clone()]);
    review
        .create(
            &env.wt,
            file_comment("c1", "src/old.rs", "unique line number 12", 12),
        )
        .await
        .unwrap();

    git(&root, &["mv", "src/old.rs", "src/new.rs"]);
    review.on_watch_event(changed(&root.join("src/old.rs"), &env.wt));
    review.flush_reanchor().await;
    let c = row(&review, &env.wt, "c1").await;
    assert_eq!(
        (c.path.as_str(), c.moved_from.as_deref()),
        ("src/new.rs", Some("src/old.rs"))
    );

    // Back to the original path: no rename exists against any base now.
    git(&root, &["mv", "src/new.rs", "src/old.rs"]);
    review.on_watch_event(changed(&root.join("src/new.rs"), &env.wt));
    review.flush_reanchor().await;
    let c = row(&review, &env.wt, "c1").await;
    assert_eq!(
        (c.path.as_str(), c.moved_from.as_deref()),
        ("src/old.rs", Some("src/new.rs"))
    );
    assert_eq!(c.anchor, AnchorState::Anchored);
}

#[tokio::test]
async fn old_side_comments_anchor_against_the_diff_and_go_outdated_when_it_is_gone() {
    let env = Env::new().await;
    let root = env.root();
    git_init(&root);
    let base: String = (1..=20).map(|i| format!("row {i}\n")).collect();
    std::fs::write(root.join("f.txt"), &base).unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-qm", "base"]);
    std::fs::write(root.join("f.txt"), base.replace("row 10\n", "ten\n")).unwrap();

    let review = env.review_with(null_watcher(200), vec![env.wt.clone()]);
    let mut b = file_comment("c1", "f.txt", "row 10", 10);
    b.surface = CommentSurface::Diff;
    b.diff_scope = Some(DiffScope::Local);
    b.side = Some(DiffSide::Old);
    b.old_start = Some(10);
    b.old_end = Some(10);
    b.line_start = None;
    b.line_end = None;
    review.create(&env.wt, b).await.unwrap();
    review.on_watch_event(WatchEvent::GitStateChanged {
        worktree_id: "wt-1".into(),
    });
    review.flush_reanchor().await;
    let c = row(&review, &env.wt, "c1").await;
    assert_eq!((c.anchor, c.current), (AnchorState::Anchored, None));

    // Revert the working tree: the removed row is no longer in the diff.
    std::fs::write(root.join("f.txt"), &base).unwrap();
    review.on_watch_event(WatchEvent::GitStateChanged {
        worktree_id: "wt-1".into(),
    });
    review.flush_reanchor().await;
    assert_eq!(
        row(&review, &env.wt, "c1").await.anchor,
        AnchorState::Outdated
    );
}

#[tokio::test]
async fn a_git_state_change_leaves_non_diff_comments_alone() {
    let env = Env::new().await;
    let review = env.review_with(null_watcher(200), vec![env.wt.clone()]);
    let file = env.root().join("a.rs");
    std::fs::write(&file, FILE).unwrap();
    review
        .create(&env.wt, file_comment("c1", "a.rs", "beta quote here", 2))
        .await
        .unwrap();
    std::fs::write(&file, "gone\n").unwrap(); // not announced
    review.on_watch_event(WatchEvent::GitStateChanged {
        worktree_id: "wt-1".into(),
    });
    assert_eq!(review.flush_reanchor().await, 0);
    assert_eq!(
        row(&review, &env.wt, "c1").await.anchor,
        AnchorState::Anchored
    );
}

#[tokio::test]
async fn artifact_moved_and_missing_follow_the_file() {
    let env = Env::new().await;
    let review = env.review_with(null_watcher(200), vec![env.wt.clone()]);
    // Not under the data home: artifacts there are denied.
    let from = env.base.join("arts/plan.md");
    let to = env.base.join("arts/plans/plan.md");
    std::fs::create_dir_all(from.parent().unwrap()).unwrap();
    std::fs::create_dir_all(to.parent().unwrap()).unwrap();
    std::fs::write(&from, "# Plan\n\nship it today\n").unwrap();
    env.register_artifact(&env.wt, &from).await;
    let mut b = file_comment("c1", from.to_str().unwrap(), "ship it today", 3);
    b.path_kind = PathKind::Artifact;
    b.surface = CommentSurface::Markdown;
    review.create(&env.wt, b).await.unwrap();

    // 03 moved the row (hash-move) and says so.
    std::fs::rename(&from, &to).unwrap();
    env.register_artifact(&env.wt, &to).await;
    review.on_artifact_change(ArtifactChange::Moved {
        scope: env.wt.clone(),
        id: "art".into(),
        from: from.clone(),
        to: to.clone(),
    });
    assert_eq!(review.flush_reanchor().await, 1);
    let c = row(&review, &env.wt, "c1").await;
    assert_eq!(PathBuf::from(&c.path), to);
    assert_eq!(c.moved_from.as_deref(), from.to_str());
    assert_eq!(c.anchor, AnchorState::Anchored);

    std::fs::remove_file(&to).unwrap();
    review.on_artifact_change(ArtifactChange::Missing {
        scope: env.wt.clone(),
        id: "art".into(),
        path: to.clone(),
    });
    review.flush_reanchor().await;
    assert_eq!(
        row(&review, &env.wt, "c1").await.anchor,
        AnchorState::FileMissing
    );
}

#[tokio::test]
async fn a_commented_artifact_vanishing_revalidates_it_in_the_artifacts_list() {
    let env = Env::new().await;
    let review = env.review_with(null_watcher(200), vec![env.wt.clone()]);
    let file = env.base.join("arts/notes.md");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, "# n\n\nkeep this\n").unwrap();
    env.register_artifact(&env.wt, &file).await;
    let mut b = file_comment("c1", file.to_str().unwrap(), "keep this", 3);
    b.path_kind = PathKind::Artifact;
    review.create(&env.wt, b).await.unwrap();
    let missing = |env: &Env| {
        let (store, wt) = (env.store.clone(), env.wt.clone());
        async move {
            store
                .list_artifacts(&wt)
                .await
                .unwrap()
                .iter()
                .any(|r| r.missing)
        }
    };
    assert!(!missing(&env).await);

    // The commented-path watcher (not 03's stream) saw it go.
    std::fs::remove_file(&file).unwrap();
    review.on_watch_event(changed(&file, &env.wt));
    review.flush_reanchor().await;
    assert_eq!(
        row(&review, &env.wt, "c1").await.anchor,
        AnchorState::FileMissing
    );
    assert!(
        missing(&env).await,
        "revalidate_paths ran: 03's list agrees (R114)"
    );
}

#[tokio::test]
async fn a_lagged_artifact_stream_resyncs_through_list() {
    let env = Env::new().await;
    let review = env.review_with(null_watcher(200), vec![env.wt.clone()]);
    let file = env.base.join("arts/lag.md");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, "# l\n\nlagged quote\n").unwrap();
    env.register_artifact(&env.wt, &file).await;
    let mut b = file_comment("c1", file.to_str().unwrap(), "lagged quote", 3);
    b.path_kind = PathKind::Artifact;
    review.create(&env.wt, b).await.unwrap();

    std::fs::remove_file(&file).unwrap(); // no event reached us
    assert!(!env
        .store
        .list_artifacts(&env.wt)
        .await
        .unwrap()
        .iter()
        .any(|r| r.missing));
    review.on_artifact_lagged().await;
    assert!(
        env.store
            .list_artifacts(&env.wt)
            .await
            .unwrap()
            .iter()
            .any(|r| r.missing),
        "list(scope) re-validated the rows"
    );
    review.flush_reanchor().await;
    assert_eq!(
        row(&review, &env.wt, "c1").await.anchor,
        AnchorState::FileMissing
    );
}

#[tokio::test]
async fn a_lagged_watcher_rechecks_every_scope() {
    let env = Env::new().await;
    let review = env.review_with(null_watcher(200), vec![env.wt.clone(), env.proj.clone()]);
    let file = env.root().join("a.rs");
    std::fs::write(&file, FILE).unwrap();
    review
        .create(&env.wt, file_comment("c1", "a.rs", "beta quote here", 2))
        .await
        .unwrap();
    review
        .create(&env.proj, file_comment("c2", "a.rs", "delta unique", 4))
        .await
        .unwrap();
    std::fs::write(&file, "nothing\nhere\n").unwrap(); // events lost
    review.on_watch_lagged().await;
    assert_eq!(review.flush_reanchor().await, 2);
    assert_eq!(
        row(&review, &env.wt, "c1").await.anchor,
        AnchorState::Outdated
    );
    assert_eq!(
        row(&review, &env.proj, "c2").await.anchor,
        AnchorState::Outdated
    );
}

#[tokio::test]
async fn watch_limit_marks_cant_check_and_a_free_slot_restores_it() {
    let env = Env::new().await;
    let watcher = null_watcher(1);
    let review = env.review_with(watcher.clone(), vec![env.wt.clone()]);
    let mut rx = watcher.subscribe();
    let root = env.root();
    std::fs::create_dir_all(root.join("d1")).unwrap();
    std::fs::create_dir_all(root.join("d2")).unwrap();
    std::fs::write(root.join("d1/a.rs"), FILE).unwrap();
    std::fs::write(root.join("d2/b.rs"), FILE).unwrap();
    review
        .create(
            &env.wt,
            file_comment("old", "d1/a.rs", "beta quote here", 2),
        )
        .await
        .unwrap();
    env.advance(60);
    review
        .create(
            &env.wt,
            file_comment("new", "d2/b.rs", "beta quote here", 2),
        )
        .await
        .unwrap();
    review.sync_watches(&env.wt).await;

    let ev = rx.recv().await.unwrap();
    assert!(
        matches!(&ev, WatchEvent::Evicted { paths } if paths[0].1 == root.join("d1/a.rs")),
        "{ev:?}"
    );
    review.on_watch_event(ev);
    review.flush_reanchor().await;
    let c = row(&review, &env.wt, "old").await;
    assert_eq!(
        (c.anchor, c.anchor_reason),
        (AnchorState::CantCheck, Some(AnchorReason::WatchLimit))
    );
    assert_eq!(
        row(&review, &env.wt, "new").await.anchor,
        AnchorState::Anchored
    );

    // The newer comment goes away: the slot returns, the old one is checked again.
    review.delete("new").await.unwrap();
    review.sync_watches(&env.wt).await;
    let ev = rx.recv().await.unwrap();
    assert!(matches!(ev, WatchEvent::Restored { .. }), "{ev:?}");
    review.on_watch_event(ev);
    review.flush_reanchor().await;
    let c = row(&review, &env.wt, "old").await;
    assert_eq!((c.anchor, c.anchor_reason), (AnchorState::Anchored, None));
}

#[tokio::test]
async fn watch_registrations_follow_the_comments() {
    let env = Env::new().await;
    let watcher = null_watcher(200);
    let review = env.review_with(watcher.clone(), vec![env.wt.clone()]);
    let file = env.root().join("a.rs");
    std::fs::write(&file, FILE).unwrap();
    review
        .create(&env.wt, file_comment("c1", "a.rs", "beta quote here", 2))
        .await
        .unwrap();
    review.sync_watches(&env.wt).await;
    assert_eq!(watcher.registered(&env.wt).len(), 1);
    assert_eq!(watcher.watched_dir_count(), 1);
    assert!(
        !watcher.watches_git_state("wt-1"),
        "no diff comment, no git watch"
    );
    review.delete("c1").await.unwrap();
    review.sync_watches(&env.wt).await;
    assert!(watcher.registered(&env.wt).is_empty());
    assert_eq!(watcher.watched_dir_count(), 0);
}

#[tokio::test]
async fn purge_drops_a_scope_and_missing_scopes_only() {
    let env = Env::new().await;
    // The resolver knows the worktree but not the project.
    let review = env.review_with(null_watcher(200), vec![env.wt.clone()]);
    review
        .create(&env.wt, file_comment("w", "a.rs", "q", 1))
        .await
        .unwrap();
    review
        .create(&env.proj, file_comment("p", "a.rs", "q", 1))
        .await
        .unwrap();
    assert_eq!(review.purge_missing_scopes().await, 1);
    assert!(review
        .list(&env.proj, None, false)
        .await
        .unwrap()
        .comments
        .is_empty());
    assert_eq!(
        review
            .list(&env.wt, None, false)
            .await
            .unwrap()
            .comments
            .len(),
        1
    );
    review.purge_scope(&env.wt).await;
    assert!(review
        .list(&env.wt, None, false)
        .await
        .unwrap()
        .comments
        .is_empty());
    assert_eq!(
        env.store.next_comment_pin(&env.wt).await.unwrap(),
        1,
        "pins restart with the scope"
    );
}

#[tokio::test]
async fn the_loop_purges_on_worktree_deleted_and_boot_rechecks_existing_comments() {
    let mut env = Env::new().await;
    let file = env.root().join("a.rs");
    std::fs::write(&file, FILE).unwrap();
    // Comments made by an earlier daemon run, the file edited while it was down.
    let before = env.review_with(null_watcher(200), vec![env.wt.clone()]);
    before
        .create(&env.wt, file_comment("c1", "a.rs", "beta quote here", 2))
        .await
        .unwrap();
    before.flush_events();
    env.events();
    std::fs::write(&file, "x\ny\nz\nbeta quote here\n").unwrap();

    let review = env.review_with(null_watcher(200), vec![env.wt.clone()]);
    let task = Arc::new(review.clone()).start();
    let (upserted, _) = next_changed(&mut env.rx).await;
    assert_eq!(
        upserted[0].current,
        Some(LineSpan { start: 4, end: 4 }),
        "boot pass re-anchored it"
    );

    env.broadcaster.send(ServerEvent::WorktreeDeleted {
        worktree_id: "wt-1".into(),
    });
    for _ in 0..50 {
        if review
            .list(&env.wt, None, false)
            .await
            .unwrap()
            .comments
            .is_empty()
        {
            task.abort();
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    task.abort();
    panic!("worktree:deleted did not purge the scope's comments");
}

#[tokio::test]
async fn the_loop_purges_a_project_scope_on_project_deleted() {
    let env = Env::new().await;
    let proj = ScopeKey::project("p1");
    let review = env.review_with(null_watcher(200), vec![env.wt.clone(), proj.clone()]);
    review
        .create(&proj, body("pc1", "notes.md", 1))
        .await
        .unwrap();
    review
        .create(&env.wt, body("wc1", "a.rs", 1))
        .await
        .unwrap();
    let task = Arc::new(review.clone()).start();
    for _ in 0..50 {
        // The loop subscribes inside its task, so re-send until it has (idempotent).
        env.broadcaster.send(ServerEvent::ProjectDeleted {
            project_id: "p1".into(),
        });
        if review
            .list(&proj, None, false)
            .await
            .unwrap()
            .comments
            .is_empty()
        {
            task.abort();
            assert_eq!(
                review
                    .list(&env.wt, None, false)
                    .await
                    .unwrap()
                    .comments
                    .len(),
                1,
                "only the deleted project's scope is purged"
            );
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    task.abort();
    panic!("project:deleted did not purge the scope's comments");
}

#[tokio::test]
async fn real_file_watch_drives_a_debounced_batched_reanchor() {
    let mut env = Env::new().await;
    let watcher = PathWatcher::native().expect("native watcher");
    let review = env.review_with(watcher, vec![env.wt.clone()]);
    let task = Arc::new(review.clone()).start();
    let file = env.root().join("live.rs");
    std::fs::write(&file, FILE).unwrap();
    review
        .create(&env.wt, file_comment("c1", "live.rs", "beta quote here", 2))
        .await
        .unwrap();
    review
        .create(&env.wt, file_comment("c2", "live.rs", "delta unique", 4))
        .await
        .unwrap();
    // The create events (250 ms coalescer) also register the watch.
    let (first, _) = next_changed(&mut env.rx).await;
    assert_eq!(first.len(), 2);
    for _ in 0..40 {
        if review.watch_registered(&env.wt) == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(review.watch_registered(&env.wt), 1);
    // Two quick edits. No fixed settle sleep: events that predate the writes (the
    // registration pass) or that FSEvents splits across a debounce window are
    // skipped until the final state arrives, bounded by a deadline.
    std::fs::write(&file, format!("a\n{FILE}")).unwrap();
    std::fs::write(&file, format!("a\nb\n{FILE}")).unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let upserted = loop {
        let left = deadline
            .checked_duration_since(tokio::time::Instant::now())
            .expect("c1 reached line 4 within the 20s deadline");
        let ev = tokio::time::timeout(left, env.rx.recv())
            .await
            .expect("c1 reached line 4 within the 20s deadline")
            .expect("bus open");
        let ServerEvent::CommentsChanged { upserted, .. } = ev else {
            continue;
        };
        if upserted
            .iter()
            .any(|c| c.id == "c1" && c.current == Some(LineSpan { start: 4, end: 4 }))
        {
            break upserted;
        }
    };
    // Both comments of the scope ride the same event (one batched re-check).
    assert!(
        upserted
            .iter()
            .any(|c| c.id == "c2" && c.current == Some(LineSpan { start: 6, end: 6 })),
        "{upserted:?}"
    );
    task.abort();
}

#[allow(dead_code)]
fn _types(_: Broadcaster) {}
