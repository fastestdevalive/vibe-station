//! Integration tests: rollback watcher.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Arc;

use axum::extract::State;
use axum::response::Json;
use axum::routing::get;
use axum::Router;
use vst_daemon::update::state::StateStore;
use vst_daemon::update::watch::{run_watch, WatchArgs};
use vst_types::rest::health::Health;
use vst_types::rest::update::{UpdateErrorKind, UpdateReason};

fn script(path: &Path, content: &str) {
    fs::write(path, content).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

#[tokio::test]
async fn test_watcher_restores_on_boot_failure_e26() {
    let tmp = tempfile::tempdir().unwrap();
    let vst_home = tmp.path().join(".vibe-station");
    let bin_dir = tmp.path().join("bin");
    fs::create_dir_all(&vst_home).unwrap();
    fs::create_dir_all(&bin_dir).unwrap();

    // Setup .prev files and new "bad" binary. The restored binary records the
    // env it is respawned with (same env as the daemon, plus the nonce).
    let env_dump = tmp.path().join("respawn.env");
    script(
        &bin_dir.join(".vst.prev"),
        &format!(
            "#!/bin/sh\n# 1.0.0\nif [ \"$1\" = daemon ]; then env > {}; fi\n",
            env_dump.display()
        ),
    );
    std::env::set_var("VST_ROLLBACK_TEST_MARKER", "kept");
    script(
        &bin_dir.join(".claude-acp.prev"),
        "#!/bin/sh\necho adapter\n",
    );
    // New binary fails/exits
    script(&bin_dir.join("vst"), "#!/bin/sh\nexit 1\n");
    // Another tool's `.foo.prev` in a shared bin dir must never be restored.
    fs::write(bin_dir.join("foo"), "foo-live").unwrap();
    fs::write(bin_dir.join(".foo.prev"), "foo-old").unwrap();

    // Setup db and db-snapshot
    let db_path = vst_home.join("vibe-station.db");
    let db_snapshot = vst_home.join(".prev").join("vibe-station.db");
    fs::create_dir_all(db_snapshot.parent().unwrap()).unwrap();
    fs::write(&db_path, "corrupted or newer db").unwrap();
    fs::write(&db_snapshot, "good old db content").unwrap();

    // Create -wal and -shm files to verify they get cleaned up
    fs::write(vst_home.join("vibe-station.db-wal"), "wal").unwrap();
    fs::write(vst_home.join("vibe-station.db-shm"), "shm").unwrap();

    // Seed state file
    let state_file_path = vst_home.join("update-state.json");
    let (store, mut state) = StateStore::load_or_default(state_file_path.clone());
    state.pending_restart = Some(vst_daemon::update::state::PendingRestart {
        version: "2.0.0".into(),
        exe_path: bin_dir.join("vst").to_string_lossy().into(),
        kind: vst_daemon::update::state::RestartKind::Daemon,
    });
    store.save(&state).unwrap();

    // Pick an unused port where nothing is listening
    let port = 64921;
    // Set short watch window for test
    std::env::set_var("VST_RESTART_WATCH_WINDOW_MS", "1000");

    let args = WatchArgs {
        expect_version: "2.0.0".into(),
        port,
        pid: 9999999, // dummy pid
        bin_dir: bin_dir.clone(),
        vst_home: vst_home.clone(),
        db_snapshot: db_snapshot.clone(),
        old_boot_id: "old-boot".into(),
        nonce: Some("test-nonce".into()),
    };

    let code = run_watch(args).await;
    assert_eq!(code, 1);

    // Verify .prev files were restored to target names
    assert!(bin_dir.join("vst").exists());
    let vst_content = fs::read_to_string(bin_dir.join("vst")).unwrap();
    assert!(vst_content.contains("1.0.0"));
    assert!(bin_dir.join("claude-acp").exists());
    assert_eq!(fs::read_to_string(bin_dir.join("foo")).unwrap(), "foo-live");
    assert!(bin_dir.join(".foo.prev").exists());

    // Verify db restored and wal/shm deleted
    let restored_db = fs::read_to_string(&db_path).unwrap();
    assert_eq!(restored_db, "good old db content");
    assert!(!vst_home.join("vibe-station.db-wal").exists());
    assert!(!vst_home.join("vibe-station.db-shm").exists());

    // Verify state file
    let (_, loaded_state) = StateStore::load_or_default(state_file_path);
    assert!(loaded_state.pending_restart.is_none());
    assert_eq!(
        loaded_state
            .rolled_back
            .as_ref()
            .map(|r| r.failed_version.as_str()),
        Some("2.0.0")
    );
    let err = loaded_state.last_error.unwrap();
    assert_eq!(err.kind, UpdateErrorKind::Restart);
    assert_eq!(err.reason, UpdateReason::BootFailed);

    // The respawned (detached) daemon inherits the watcher's env, not just
    // PATH/HOME: user env (API keys, VST_* config) must survive a rollback.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let dumped = loop {
        if let Ok(s) = fs::read_to_string(&env_dump) {
            if s.contains("VST_RESTART_PORT=") {
                break s;
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "restored daemon never ran"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    };
    assert!(dumped.contains("VST_ROLLBACK_TEST_MARKER=kept"), "{dumped}");
    assert!(dumped.contains("VST_RESTART_NONCE=test-nonce"), "{dumped}");
}

#[tokio::test]
async fn test_watcher_exits_cleanly_on_healthy_boot_e22() {
    let tmp = tempfile::tempdir().unwrap();
    let vst_home = tmp.path().join(".vibe-station");
    let bin_dir = tmp.path().join("bin");
    fs::create_dir_all(&vst_home).unwrap();
    fs::create_dir_all(&bin_dir).unwrap();

    script(&bin_dir.join(".vst.prev"), "#!/bin/sh\necho 1.0.0\n");
    script(&bin_dir.join("vst"), "#!/bin/sh\necho 2.0.0\n");

    let db_path = vst_home.join("vibe-station.db");
    let db_snapshot = vst_home.join(".prev").join("vibe-station.db");
    fs::create_dir_all(db_snapshot.parent().unwrap()).unwrap();
    fs::write(&db_path, "live db").unwrap();
    fs::write(&db_snapshot, "snapshot").unwrap();

    // Start a mock axum server on a free port returning new bootId
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let boot_id = Arc::new("new-boot-id".to_string());
    let app = Router::new()
        .route(
            "/health",
            get(|State(b): State<Arc<String>>| async move {
                Json(Health {
                    ok: true,
                    version: "2.0.0".into(),
                    port: 0,
                    uptime: 1,
                    boot_id: (*b).clone(),
                })
            }),
        )
        .with_state(boot_id);

    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    std::env::set_var("VST_RESTART_WATCH_WINDOW_MS", "2000");

    let args = WatchArgs {
        expect_version: "2.0.0".into(),
        port,
        pid: 9999999,
        bin_dir: bin_dir.clone(),
        vst_home: vst_home.clone(),
        db_snapshot,
        old_boot_id: "old-boot-id".into(),
        nonce: None,
    };

    let code = run_watch(args).await;
    assert_eq!(code, 0);

    // Verify .vst.prev and vst are untouched
    assert!(bin_dir.join(".vst.prev").exists());
    let vst_content = fs::read_to_string(bin_dir.join("vst")).unwrap();
    assert!(vst_content.contains("2.0.0"));
    assert_eq!(fs::read_to_string(&db_path).unwrap(), "live db");
}

#[tokio::test]
async fn test_watcher_handles_unbootable_old_binary_e25() {
    let tmp = tempfile::tempdir().unwrap();
    let vst_home = tmp.path().join(".vibe-station");
    let bin_dir = tmp.path().join("bin");
    fs::create_dir_all(&vst_home).unwrap();
    fs::create_dir_all(&bin_dir).unwrap();

    // Both old and new are bad
    script(&bin_dir.join(".vst.prev"), "#!/bin/sh\nexit 1\n");
    script(&bin_dir.join("vst"), "#!/bin/sh\nexit 1\n");

    let db_snapshot = vst_home.join(".prev").join("vibe-station.db");
    fs::create_dir_all(db_snapshot.parent().unwrap()).unwrap();
    fs::write(&db_snapshot, "snapshot").unwrap();

    let port = 64923;
    std::env::set_var("VST_RESTART_WATCH_WINDOW_MS", "800");

    let args = WatchArgs {
        expect_version: "2.0.0".into(),
        port,
        pid: 9999999,
        bin_dir: bin_dir.clone(),
        vst_home: vst_home.clone(),
        db_snapshot,
        old_boot_id: "old-boot".into(),
        nonce: None,
    };

    // run_watch should restore files, attempt spawn, log error, and not panic
    let code = run_watch(args).await;
    assert_eq!(code, 1);

    // Verify restored file left in place
    assert!(bin_dir.join("vst").exists());
    let log_path = vst_home.join("logs").join("update-watch.log");
    assert!(log_path.exists());
    let log_content = fs::read_to_string(log_path).unwrap();
    assert!(log_content.contains("Initiating rollback!"));
}

fn prev_fixture(tmp: &Path) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
    let vst_home = tmp.join(".vibe-station");
    let bin_dir = tmp.join("bin");
    fs::create_dir_all(&vst_home).unwrap();
    fs::create_dir_all(&bin_dir).unwrap();
    script(&bin_dir.join(".vst.prev"), "#!/bin/sh\n# 1.0.0\nexit 0\n");
    script(&bin_dir.join("vst"), "#!/bin/sh\nexit 1\n");
    let snapshot = vst_home.join(".prev").join("vibe-station.db");
    fs::create_dir_all(snapshot.parent().unwrap()).unwrap();
    (vst_home, bin_dir, snapshot)
}

fn watch_args(port: u16, bin_dir: &Path, snapshot: &Path, old: &str) -> WatchArgs {
    WatchArgs {
        expect_version: "2.0.0".into(),
        port,
        pid: 9999999,
        bin_dir: bin_dir.to_path_buf(),
        vst_home: snapshot.parent().unwrap().parent().unwrap().to_path_buf(),
        db_snapshot: snapshot.to_path_buf(),
        old_boot_id: old.into(),
        nonce: None,
    }
}

/// No snapshot -> the live `-wal`/`-shm` (committed data) survive.
#[tokio::test]
async fn test_rollback_without_snapshot_keeps_wal_and_shm_d04() {
    let tmp = tempfile::tempdir().unwrap();
    let (vst_home, bin_dir, snapshot) = prev_fixture(tmp.path());
    fs::write(vst_home.join("vibe-station.db"), "live db").unwrap();
    fs::write(vst_home.join("vibe-station.db-wal"), "wal").unwrap();
    fs::write(vst_home.join("vibe-station.db-shm"), "shm").unwrap();
    assert!(!snapshot.exists());

    std::env::set_var("VST_RESTART_WATCH_WINDOW_MS", "600");
    let code = run_watch(watch_args(64931, &bin_dir, &snapshot, "old")).await;
    assert_eq!(code, 1);

    // binaries rolled back, DB files untouched
    assert!(fs::read_to_string(bin_dir.join("vst"))
        .unwrap()
        .contains("1.0.0"));
    assert_eq!(
        fs::read_to_string(vst_home.join("vibe-station.db")).unwrap(),
        "live db"
    );
    assert_eq!(
        fs::read_to_string(vst_home.join("vibe-station.db-wal")).unwrap(),
        "wal"
    );
    assert_eq!(
        fs::read_to_string(vst_home.join("vibe-station.db-shm")).unwrap(),
        "shm"
    );
    assert!(!vst_home.join("vibe-station.db.restore").exists());
}

/// Another process holds `.daemon.lock` -> no rollback, no writes.
#[tokio::test]
async fn test_rollback_aborts_when_daemon_lock_is_held_d04() {
    let tmp = tempfile::tempdir().unwrap();
    let (vst_home, bin_dir, snapshot) = prev_fixture(tmp.path());
    fs::write(vst_home.join("vibe-station.db"), "live db").unwrap();
    fs::write(vst_home.join("vibe-station.db-wal"), "wal").unwrap();
    fs::write(&snapshot, "old snapshot").unwrap();

    let held = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(vst_home.join(".daemon.lock"))
        .unwrap();
    assert!(vst_proc::try_lock_exclusive(&held).unwrap());

    std::env::set_var("VST_RESTART_WATCH_WINDOW_MS", "600");
    let code = run_watch(watch_args(64932, &bin_dir, &snapshot, "old")).await;
    assert_eq!(code, 0);

    assert!(
        bin_dir.join(".vst.prev").exists(),
        ".vst.prev must not be renamed"
    );
    assert!(fs::read_to_string(bin_dir.join("vst"))
        .unwrap()
        .contains("exit 1"));
    assert_eq!(
        fs::read_to_string(vst_home.join("vibe-station.db")).unwrap(),
        "live db"
    );
    assert!(vst_home.join("vibe-station.db-wal").exists());
    assert!(!vst_home.join("update-state.json").exists());
    drop(held);
}

/// The old daemon keeps answering with its old bootId (hung drain): the
/// watcher must not roll back a version that never ran.
#[tokio::test]
async fn test_hung_old_daemon_is_not_rolled_back_d12() {
    let tmp = tempfile::tempdir().unwrap();
    let (vst_home, bin_dir, snapshot) = prev_fixture(tmp.path());
    fs::write(vst_home.join("vibe-station.db"), "live db").unwrap();
    fs::write(&snapshot, "old snapshot").unwrap();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = Router::new().route(
        "/health",
        get(|| async {
            Json(Health {
                ok: true,
                version: "1.0.0".into(),
                port: 0,
                uptime: 1,
                boot_id: "old-boot-id".into(),
            })
        }),
    );
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    std::env::set_var("VST_RESTART_WATCH_WINDOW_MS", "1200");
    let code = run_watch(watch_args(port, &bin_dir, &snapshot, "old-boot-id")).await;
    assert_eq!(code, 0);

    assert!(bin_dir.join(".vst.prev").exists());
    assert!(fs::read_to_string(bin_dir.join("vst"))
        .unwrap()
        .contains("exit 1"));
    assert_eq!(
        fs::read_to_string(vst_home.join("vibe-station.db")).unwrap(),
        "live db"
    );
    let (_, st) = StateStore::load_or_default(vst_home.join("update-state.json"));
    assert!(st.rolled_back.is_none());
}
