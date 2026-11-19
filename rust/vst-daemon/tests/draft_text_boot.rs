//! The boot orphan sweep for `draft_texts` is gated on this boot's manifest
//! migration, like the artifact and review-comment purges (plan 3.A.3).
//!
//! Plain store tests: no daemon is spawned, no TCP port is bound.

use tempfile::TempDir;

use vst_daemon::draft_text::boot::sweep_after_migration;
use vst_store::StoreHandle;
use vst_types::ProjectRecord;

const ISO: &str = "2026-01-01T00:00:00.000Z";
const CLIENT: &str = "client-a";

fn project() -> ProjectRecord {
    ProjectRecord {
        id: "p1".into(),
        absolute_path: "/tmp/p1".into(),
        prefix: "vs".into(),
        is_git: false,
        default_branch: None,
        created_at: ISO.into(),
        hidden: None,
        direct_sessions: vec![],
        direct_session_seq: Some(0),
        worktrees: vec![],
        next_worktree_num: Some(1),
        lsp_enabled: None,
        open_files: vec![],
    }
}

/// A store holding one orphan row (`no-such-session`) plus whatever the caller
/// adds, and a temp dir whose `projects/` folder is empty (so a real migration
/// succeeds without touching the seeded rows).
async fn seeded(with_project: bool) -> (StoreHandle, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    if with_project {
        store.add_project(project()).await.unwrap();
    }
    store
        .put_draft_text("no-such-session", "orphaned text", CLIENT, ISO)
        .await
        .unwrap();
    (store, dir)
}

async fn orphan_kept(store: &StoreHandle) -> bool {
    store
        .get_draft_text("no-such-session")
        .await
        .unwrap()
        .is_some()
}

#[tokio::test]
async fn orphan_removed_after_successful_migration() {
    let (store, dir) = seeded(true).await;
    // A live scope's empty tombstone must survive the same sweep.
    store
        .put_draft_text("global-new", "", CLIENT, ISO)
        .await
        .unwrap();
    let migration = store
        .migrate_manifests(dir.path().join("projects"))
        .await
        .map_err(|e| e.to_string());
    assert!(migration.is_ok(), "{migration:?}");

    assert_eq!(sweep_after_migration(&store, &migration).await, Some(1));
    assert!(!orphan_kept(&store).await, "the orphan row is gone");
    let tombstone = store.get_draft_text("global-new").await.unwrap();
    assert!(
        tombstone.is_some(),
        "an empty tombstone with a live scope is never purged (revision continuity)"
    );
}

#[tokio::test]
async fn orphan_kept_when_migration_failed() {
    let (store, _dir) = seeded(true).await;
    let migration: Result<(), String> = Err("forced".into());
    assert_eq!(sweep_after_migration(&store, &migration).await, None);
    assert!(
        orphan_kept(&store).await,
        "a partial migration proves nothing"
    );
}

#[tokio::test]
async fn orphan_kept_when_projects_empty() {
    let (store, _dir) = seeded(false).await;
    assert!(store.get_all_projects().await.is_empty());
    let migration: Result<(), String> = Ok(());
    assert_eq!(sweep_after_migration(&store, &migration).await, None);
    assert!(
        orphan_kept(&store).await,
        "no projects loaded looks like 'everything deleted' — skip"
    );
}
