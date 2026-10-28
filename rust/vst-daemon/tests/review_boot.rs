//! The boot orphan purge of review comments is gated on this boot's manifest
//! migration, like the artifact one.

use vst_daemon::review_boot::purge_orphan_comments_after_migration;
use vst_store::comments::CreateOutcome;
use vst_store::StoreHandle;
use vst_types::artifacts::ScopeKey;
use vst_types::review::{AnchorState, CommentSurface, PathKind, ReviewComment};

fn orphan() -> ReviewComment {
    ReviewComment {
        id: "orphan".into(),
        scope_kind: vst_types::artifacts::ScopeKind::Worktree,
        scope_id: "no-such-worktree".into(),
        pin: 0,
        path: "a.rs".into(),
        path_kind: PathKind::Repo,
        surface: CommentSurface::File,
        diff_scope: None,
        base_sha: None,
        side: None,
        line_start: Some(1),
        line_end: Some(1),
        old_start: None,
        old_end: None,
        new_start: None,
        new_end: None,
        quote: "q".into(),
        prefix: String::new(),
        suffix: String::new(),
        occurrence: 0,
        text: "t".into(),
        anchor: AnchorState::Anchored,
        anchor_reason: None,
        current: None,
        moved_from: None,
        attached_to: None,
        restored_reason: None,
        block_bytes: 10,
        version: 1,
        created_at: String::new(),
        updated_at: String::new(),
    }
}

async fn seeded() -> (StoreHandle, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let out = store
        .create_comment(orphan(), None, "2026-01-01T00:00:00.000Z")
        .await
        .unwrap();
    assert!(matches!(out, CreateOutcome::Created(_)));
    // A non-empty projects table, so only the migration gate can stop the purge.
    store
        .raw_conn()
        .execute(
            "INSERT INTO projects (id, absolutePath, prefix, isGit, createdAt) VALUES ('p-other', '/x', 'x', 0, 't')",
            [],
        )
        .unwrap();
    (store, dir)
}

#[tokio::test]
async fn a_failed_migration_skips_the_purge_and_keeps_the_comments() {
    let (store, _dir) = seeded().await;
    let migration: Result<(), String> = Err("forced".into());
    assert_eq!(
        purge_orphan_comments_after_migration(&store, &migration).await,
        None
    );
    let scope = ScopeKey::worktree("no-such-worktree");
    assert_eq!(
        store
            .list_comments(&scope, None, false)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn a_successful_migration_purges_comments_of_missing_scopes() {
    let (store, dir) = seeded().await;
    let migration = store
        .migrate_manifests(dir.path().join("projects"))
        .await
        .map_err(|e| e.to_string());
    assert!(migration.is_ok());
    assert_eq!(
        purge_orphan_comments_after_migration(&store, &migration).await,
        Some(1)
    );
    let scope = ScopeKey::worktree("no-such-worktree");
    assert!(store
        .list_comments(&scope, None, false)
        .await
        .unwrap()
        .is_empty());
}
