//! Integration test for restart exec and handoff.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;
use std::time::{Duration, Instant};

use tempfile::TempDir;
use vst_testkit::proc_guard::{native_daemon_tests_enabled, ChildGuard, DaemonHomeGuard};
use vst_types::domain::TokenScope;

/// Field order is drop order: the daemon's process group is killed first, then
/// any detached successor/restored daemon recorded under the temp HOME, and
/// only then is the HOME removed.
struct DaemonProcess {
    child: ChildGuard,
    _home_guard: DaemonHomeGuard,
    _home: TempDir,
    _vst_home: std::path::PathBuf,
    _port: u16,
}

async fn wait_for_health(port: u16, timeout: Duration) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{port}/health");
    let start = Instant::now();

    while start.elapsed() < timeout {
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                if let Ok(json) = resp.json::<serde_json::Value>().await {
                    return Ok(json);
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(format!("Timed out waiting for {url}"))
}

fn pick_unused_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

static RESTART_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn test_cold_boot_with_stale_handoff_deletes_it_and_rejects_old_cookie() {
    if !native_daemon_tests_enabled(
        "test_cold_boot_with_stale_handoff_deletes_it_and_rejects_old_cookie",
    ) {
        return;
    }
    let _g = RESTART_TEST_LOCK.lock().await;
    let home = TempDir::new().unwrap();
    let vst_home = home.path().join(".vibe-station");
    fs::create_dir_all(&vst_home).unwrap();

    let port = pick_unused_port();

    // Create a fake handoff file with an old daemon token
    let old_auth = vst_routes::auth::HandoffAuth {
        daemon_token: "old-secret-token".to_string(),
        browser_epoch: 10,
        revoked_token_ids: vec![],
        sessions: vec![],
    };
    let _ = vst_daemon::update::handoff::write(&vst_home, &old_auth, port, "old-boot").unwrap();
    assert!(vst_daemon::update::handoff::handoff_path(&vst_home).exists());

    // Mint a browser token using the old_auth state
    let old_state = vst_routes::auth::AuthState::from_handoff(old_auth);
    let old_token = vst_routes::auth::mint_token(TokenScope::Browser, &old_state, None);

    // Copy binary
    let bin_dir = home.path().join("bin");
    fs::create_dir_all(&bin_dir).unwrap();
    let vst_bin = bin_dir.join("vst");
    fs::copy(env!("CARGO_BIN_EXE_vst"), &vst_bin).unwrap();
    fs::set_permissions(&vst_bin, fs::Permissions::from_mode(0o755)).unwrap();

    // Launch daemon WITHOUT VST_RESTART_NONCE (cold boot)
    let home_guard = DaemonHomeGuard::new(home.path());
    let child = ChildGuard::spawn(
        Command::new(&vst_bin)
            .arg("daemon")
            .arg("run")
            .env("HOME", home.path())
            .env("VST_PORT", port.to_string())
            .env("VST_UPDATE_CHECK", "0")
            .env_remove("VST_RESTART_NONCE")
            .env_remove("VST_RESTART_PORT"),
    )
    .expect("failed to spawn vst daemon");

    let _daemon = DaemonProcess {
        child,
        _home_guard: home_guard,
        _home: home,
        _vst_home: vst_home.clone(),
        _port: port,
    };

    // Wait for health
    let health = wait_for_health(port, Duration::from_secs(10))
        .await
        .expect("daemon should respond to /health");
    assert_eq!(health["ok"], true);

    // Handoff file should have been deleted on cold boot
    assert!(
        !vst_daemon::update::handoff::handoff_path(&vst_home).exists(),
        "stale handoff file should be deleted on cold boot"
    );

    // Old token should be rejected (401) on /api/auth/check
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("http://127.0.0.1:{port}/api/auth/check"))
        .header("Authorization", format!("Bearer {old_token}"))
        .send()
        .await
        .expect("request to /api/auth/check should succeed");
    assert_eq!(resp.status(), reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn test_daemon_restart_exec_flow() {
    if !native_daemon_tests_enabled("test_daemon_restart_exec_flow") {
        return;
    }
    let _g = RESTART_TEST_LOCK.lock().await;
    let home = TempDir::new().unwrap();
    let vst_home = home.path().join(".vibe-station");
    fs::create_dir_all(&vst_home).unwrap();

    let port = pick_unused_port();

    let bin_dir = home.path().join("bin");
    fs::create_dir_all(&bin_dir).unwrap();
    let vst_bin = bin_dir.join("vst");
    fs::copy(env!("CARGO_BIN_EXE_vst"), &vst_bin).unwrap();
    fs::set_permissions(&vst_bin, fs::Permissions::from_mode(0o755)).unwrap();

    let home_guard = DaemonHomeGuard::new(home.path());
    let child = ChildGuard::spawn(
        Command::new(&vst_bin)
            .arg("daemon")
            .arg("run")
            .env("HOME", home.path())
            .env("VST_PORT", port.to_string())
            .env("VST_UPDATE_CHECK", "0"),
    )
    .expect("failed to spawn vst daemon");

    let pid = child.id();

    let mut daemon = DaemonProcess {
        child,
        _home_guard: home_guard,
        _home: home,
        _vst_home: vst_home.clone(),
        _port: port,
    };

    let health1 = wait_for_health(port, Duration::from_secs(10))
        .await
        .expect("daemon should respond to /health");
    let boot_id1 = health1["bootId"].as_str().unwrap().to_string();

    // Read cli token from config.json
    let config_path = vst_home.join("config.json");
    let config_val: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
    let cli_token = config_val["cliToken"].as_str().unwrap().to_string();

    let client = reqwest::Client::new();
    // Verify auth check with cli_token
    let auth_check = client
        .get(format!("http://127.0.0.1:{port}/api/auth/check"))
        .header("Authorization", format!("Bearer {cli_token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(auth_check.status(), reqwest::StatusCode::OK);

    // Call POST /api/daemon/restart with confirm: true
    let restart_resp = client
        .post(format!("http://127.0.0.1:{port}/api/daemon/restart"))
        .header("Authorization", format!("Bearer {cli_token}"))
        .json(&serde_json::json!({ "confirm": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(restart_resp.status(), reqwest::StatusCode::ACCEPTED);

    // Wait for the new daemon to become healthy
    let start = Instant::now();
    let mut boot_id2 = String::new();
    while start.elapsed() < Duration::from_secs(10) {
        if let Ok(health2) = wait_for_health(port, Duration::from_millis(500)).await {
            let b2 = health2["bootId"].as_str().unwrap().to_string();
            if b2 != boot_id1 {
                boot_id2 = b2;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        !boot_id2.is_empty(),
        "daemon should have restarted with a new bootId"
    );
    assert_ne!(boot_id1, boot_id2);

    // PID should be the same (because exec replaces the process image)
    assert_eq!(daemon.child.id(), pid);

    // Same CLI token should STILL work on /api/auth/check because AuthState was handed off
    let auth_check2 = client
        .get(format!("http://127.0.0.1:{port}/api/auth/check"))
        .header("Authorization", format!("Bearer {cli_token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(auth_check2.status(), reqwest::StatusCode::OK);

    // On Linux the successor's /proc/<pid>/fd count <= fresh boot + 2
    #[cfg(target_os = "linux")]
    {
        let fd_count = fs::read_dir(format!("/proc/{pid}/fd"))
            .map(|entries| entries.count())
            .unwrap_or(0);
        assert!(
            fd_count <= 64,
            "fd count after exec should not leak fds (got {fd_count})"
        );
    }

    // Handoff file should have been deleted after successful bind/boot
    assert!(
        !vst_daemon::update::handoff::handoff_path(&vst_home).exists(),
        "handoff file must be deleted after restart"
    );

    // Cleanup
    let _ = daemon.child.kill();
}

#[tokio::test]
async fn test_rollback_watcher_restores_on_broken_successor() {
    if !native_daemon_tests_enabled("test_rollback_watcher_restores_on_broken_successor") {
        return;
    }
    let _g = RESTART_TEST_LOCK.lock().await;
    let home = TempDir::new().unwrap();
    let vst_home = home.path().join(".vibe-station");
    fs::create_dir_all(&vst_home).unwrap();

    let port = pick_unused_port();
    let bin_dir = home.path().join("bin");
    fs::create_dir_all(&bin_dir).unwrap();

    let vst_bin = bin_dir.join("vst");
    fs::copy(env!("CARGO_BIN_EXE_vst"), &vst_bin).unwrap();
    fs::set_permissions(&vst_bin, fs::Permissions::from_mode(0o755)).unwrap();

    // Create .vst.prev as copy of current working vst binary
    let prev_vst = bin_dir.join(".vst.prev");
    fs::copy(&vst_bin, &prev_vst).unwrap();
    fs::set_permissions(&prev_vst, fs::Permissions::from_mode(0o755)).unwrap();

    // Seed state file with pendingRestart
    let state_file_path = vst_home.join("update-state.json");
    let (store, mut state) =
        vst_daemon::update::state::StateStore::load_or_default(state_file_path.clone());
    state.pending_restart = Some(vst_daemon::update::state::PendingRestart {
        version: "9.9.9".into(),
        exe_path: vst_bin.to_string_lossy().into(),
        kind: vst_daemon::update::state::RestartKind::Daemon,
    });
    store.save(&state).unwrap();

    // Launch daemon
    let home_guard = DaemonHomeGuard::new(home.path());
    let child = ChildGuard::spawn(
        Command::new(&vst_bin)
            .arg("daemon")
            .arg("run")
            .env("HOME", home.path())
            .env("VST_PORT", port.to_string())
            .env("VST_UPDATE_CHECK", "0")
            .env("VST_RESTART_WATCH_WINDOW_MS", "3000"),
    )
    .expect("failed to spawn vst daemon");

    let mut daemon = DaemonProcess {
        child,
        _home_guard: home_guard,
        _home: home,
        _vst_home: vst_home.clone(),
        _port: port,
    };

    let health1 = wait_for_health(port, Duration::from_secs(10))
        .await
        .expect("daemon should respond to /health");
    let old_boot_id = health1["bootId"].as_str().unwrap().to_string();
    let old_version = health1["version"].as_str().unwrap().to_string();

    let config_path = vst_home.join("config.json");
    let config_val: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(config_path).unwrap()).unwrap();
    let cli_token = config_val["cliToken"].as_str().unwrap().to_string();

    // Now replace `vst_bin` with a broken script that fails
    // Remove the file first to avoid ETXTBSY (the running daemon process still has vst_bin open as its executable)
    let _ = fs::remove_file(&vst_bin);
    fs::write(&vst_bin, "#!/bin/sh\nexit 1\n").unwrap();
    fs::set_permissions(&vst_bin, fs::Permissions::from_mode(0o755)).unwrap();

    // Request restart
    let client = reqwest::Client::new();
    let restart_resp = client
        .post(format!("http://127.0.0.1:{port}/api/daemon/restart"))
        .header("Authorization", format!("Bearer {cli_token}"))
        .json(&serde_json::json!({ "confirm": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(restart_resp.status(), reqwest::StatusCode::ACCEPTED);

    // Wait up to 20 s: watcher should detect failure, restore .vst.prev -> vst, and spawn restored daemon
    let start = Instant::now();
    let mut restored_healthy = false;
    while start.elapsed() < Duration::from_secs(20) {
        if let Ok(health2) = wait_for_health(port, Duration::from_millis(500)).await {
            let b2 = health2["bootId"].as_str().unwrap().to_string();
            if b2 != old_boot_id {
                assert_eq!(health2["version"].as_str().unwrap(), old_version);
                restored_healthy = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    assert!(
        restored_healthy,
        "watcher should restore and boot the old daemon within 20s"
    );

    // Verify state file shows rolledBack
    let (_, loaded_state) = vst_daemon::update::state::StateStore::load_or_default(state_file_path);
    assert!(loaded_state.rolled_back.is_some());
    assert_eq!(
        loaded_state.rolled_back.as_ref().unwrap().failed_version,
        "9.9.9"
    );

    // The restored daemon consumed the handoff, so logins survive the
    // rollback (the pre-restart token still authenticates).
    let auth_after = client
        .get(format!("http://127.0.0.1:{port}/api/auth/check"))
        .header("Authorization", format!("Bearer {cli_token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(auth_after.status(), reqwest::StatusCode::OK);

    // The restored daemon is a detached process (not `daemon.child`): stop it
    // so it does not outlive the test's temp HOME.
    let _ = client
        .post(format!("http://127.0.0.1:{port}/api/daemon/stop"))
        .header("Authorization", format!("Bearer {cli_token}"))
        .send()
        .await;
    let _ = daemon.child.kill();
}

#[tokio::test]
async fn test_healthy_successor_with_pending_restart_does_not_rollback() {
    if !native_daemon_tests_enabled("test_healthy_successor_with_pending_restart_does_not_rollback")
    {
        return;
    }
    let _g = RESTART_TEST_LOCK.lock().await;
    let home = TempDir::new().unwrap();
    let vst_home = home.path().join(".vibe-station");
    fs::create_dir_all(&vst_home).unwrap();

    let port = pick_unused_port();
    let bin_dir = home.path().join("bin");
    fs::create_dir_all(&bin_dir).unwrap();

    let vst_bin = bin_dir.join("vst");
    fs::copy(env!("CARGO_BIN_EXE_vst"), &vst_bin).unwrap();
    fs::set_permissions(&vst_bin, fs::Permissions::from_mode(0o755)).unwrap();

    // Create .vst.prev
    let prev_vst = bin_dir.join(".vst.prev");
    fs::copy(&vst_bin, &prev_vst).unwrap();
    fs::set_permissions(&prev_vst, fs::Permissions::from_mode(0o755)).unwrap();

    // Seed state file with pendingRestart
    let state_file_path = vst_home.join("update-state.json");
    let (store, mut state) =
        vst_daemon::update::state::StateStore::load_or_default(state_file_path.clone());
    state.pending_restart = Some(vst_daemon::update::state::PendingRestart {
        version: "9.9.9".into(),
        exe_path: vst_bin.to_string_lossy().into(),
        kind: vst_daemon::update::state::RestartKind::Daemon,
    });
    store.save(&state).unwrap();

    // Launch daemon
    let home_guard = DaemonHomeGuard::new(home.path());
    let child = ChildGuard::spawn(
        Command::new(&vst_bin)
            .arg("daemon")
            .arg("run")
            .env("HOME", home.path())
            .env("VST_PORT", port.to_string())
            .env("VST_UPDATE_CHECK", "0")
            .env("VST_RESTART_WATCH_WINDOW_MS", "3000"),
    )
    .expect("failed to spawn vst daemon");

    let mut daemon = DaemonProcess {
        child,
        _home_guard: home_guard,
        _home: home,
        _vst_home: vst_home.clone(),
        _port: port,
    };

    let health1 = wait_for_health(port, Duration::from_secs(10))
        .await
        .expect("daemon should respond to /health");
    let old_boot_id = health1["bootId"].as_str().unwrap().to_string();

    let config_path = vst_home.join("config.json");
    let config_val: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(config_path).unwrap()).unwrap();
    let cli_token = config_val["cliToken"].as_str().unwrap().to_string();

    // Request restart without corrupting vst_bin (successor will be healthy)
    let client = reqwest::Client::new();
    let restart_resp = client
        .post(format!("http://127.0.0.1:{port}/api/daemon/restart"))
        .header("Authorization", format!("Bearer {cli_token}"))
        .json(&serde_json::json!({ "confirm": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(restart_resp.status(), reqwest::StatusCode::ACCEPTED);

    // Wait for successor to boot
    let start = Instant::now();
    let mut booted_new = false;
    while start.elapsed() < Duration::from_secs(10) {
        if let Ok(health2) = wait_for_health(port, Duration::from_millis(500)).await {
            let b2 = health2["bootId"].as_str().unwrap().to_string();
            if b2 != old_boot_id {
                booted_new = true;
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(booted_new);

    // Wait longer to let the watcher observe health and exit cleanly
    tokio::time::sleep(Duration::from_millis(1000)).await;

    // Verify rolledBack is absent
    let (_, loaded_state) = vst_daemon::update::state::StateStore::load_or_default(state_file_path);
    assert!(loaded_state.rolled_back.is_none());

    let _ = daemon.child.kill();
}
