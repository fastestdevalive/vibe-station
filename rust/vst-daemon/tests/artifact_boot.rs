//! 1.T5b: the boot orphan purge is gated on this boot's manifest migration.

use std::io::Write;
use std::sync::{Arc, Mutex};

use vst_daemon::artifact_boot::purge_orphan_artifacts_after_migration;
use vst_store::artifacts::ArtifactWrite;
use vst_store::StoreHandle;
use vst_types::artifacts::{AddedVia, ScopeKey};

#[derive(Clone, Default)]
struct LogBuf(Arc<Mutex<Vec<u8>>>);

impl Write for LogBuf {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBuf {
    type Writer = LogBuf;
    fn make_writer(&'a self) -> LogBuf {
        self.clone()
    }
}

fn orphan_row() -> ArtifactWrite {
    ArtifactWrite {
        id: "orphan".into(),
        scope: ScopeKey::worktree("no-such-worktree"),
        path: "/tmp/a.md".into(),
        path_key: "/tmp/a.md".into(),
        in_repo: false,
        hash: Some("h".into()),
        size: Some(1),
        mtime_ms: Some(1),
        writer: Some("s".into()),
        added_via: AddedVia::Capture,
        now: "2026-01-01T00:00:00.000Z".into(),
    }
}

/// A manifest whose migration outcome cannot be recorded: the trigger aborts
/// the `manifest_migrations` insert, so `migrate_manifests` returns `Err`.
async fn failing_migration(store: &StoreHandle, dir: &std::path::Path) -> Result<(), String> {
    store
        .raw_conn()
        .execute_batch(
            "CREATE TRIGGER force_fail BEFORE INSERT ON manifest_migrations
             BEGIN SELECT RAISE(ABORT, 'forced migration failure'); END;",
        )
        .unwrap();
    let projects = dir.join("projects");
    std::fs::create_dir_all(projects.join("p1")).unwrap();
    std::fs::write(projects.join("p1/manifest.json"), "{ not json").unwrap();
    store
        .migrate_manifests(&projects)
        .await
        .map_err(|e| e.to_string())
}

#[tokio::test]
async fn failed_migration_skips_the_purge_keeps_rows_and_warns() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store.upsert_artifact(orphan_row()).await.unwrap();
    // A non-empty projects table, so only the migration gate can stop the purge.
    store
        .raw_conn()
        .execute(
            "INSERT INTO projects (id, absolutePath, prefix, isGit, createdAt) VALUES ('p-other', '/x', 'x', 0, 't')",
            [],
        )
        .unwrap();

    let logs = LogBuf::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(logs.clone())
        .with_ansi(false)
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    let migration = failing_migration(&store, dir.path()).await;
    assert!(migration.is_err(), "the forced migration must fail");

    let purged = purge_orphan_artifacts_after_migration(&store, &migration).await;
    assert_eq!(purged, None, "purge must not run after a failed migration");
    assert!(
        store.get_artifact("orphan").await.unwrap().is_some(),
        "rows survive"
    );
    let text = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    assert!(
        text.contains("WARN") && text.contains("artifact orphan purge skipped"),
        "expected the skip warn, got: {text}"
    );
}

#[tokio::test]
async fn successful_migration_purges_orphans() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store.upsert_artifact(orphan_row()).await.unwrap();
    store
        .raw_conn()
        .execute(
            "INSERT INTO projects (id, absolutePath, prefix, isGit, createdAt) VALUES ('p-other', '/x', 'x', 0, 't')",
            [],
        )
        .unwrap();

    let migration = store
        .migrate_manifests(dir.path().join("projects"))
        .await
        .map_err(|e| e.to_string());
    assert!(migration.is_ok());
    assert_eq!(
        purge_orphan_artifacts_after_migration(&store, &migration).await,
        Some(1)
    );
    assert!(store.get_artifact("orphan").await.unwrap().is_none());
}
