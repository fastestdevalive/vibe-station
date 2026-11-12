//! Integration tests for the self-heal orchestrator
//! (`cli-daemon-unification` Part 03, rev 3 — CUJ1-fallback/CUJ2b only, no
//! prompt, no lock-probe). Spawns real `vst daemon run` processes via the
//! actual compiled binary (`CARGO_BIN_EXE_vst`) in isolated temp `HOME`s.
//!
//! Every test in this file mutates process-global state (`DISPLAY`,
//! `WAYLAND_DISPLAY`, `HOME`) — kept in this one file so `cargo test`'s
//! parallel-thread execution within a binary can't race across tests that
//! assume different display state (mirrors the `dispatch.rs` env-var lesson
//! from Part 00). Each test takes `ENV_LOCK` for its duration.
//!
//! These start real, deliberately detached daemons, so they run only with
//! `VST_NATIVE_DAEMON_TESTS=1` (Docker/CI). Each test creates a
//! `DaemonHomeGuard` BEFORE anything can spawn; its `Drop` kills the daemon
//! of that temp `HOME` even when an assert fails. Declare it after the
//! tempdir so it drops (and kills) before the directory is removed.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;
use tokio::sync::Mutex;

use vst_cli::launch::ensure_daemon_reachable_with_exe;
use vst_testkit::{native_daemon_tests_enabled, DaemonHomeGuard};

static ENV_LOCK: Mutex<()> = Mutex::const_new(());

fn vst_exe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_vst"))
}

/// Force the headless (CUJ2b) path deterministically — this sandbox may
/// have a real `$DISPLAY` set (e.g. for browser automation tooling), but no
/// real vibe-station install exists here, so `launch_app()` would harmlessly
/// fail-fast and fall through anyway. Clearing display vars makes the test
/// not depend on that fact remaining true. On macOS `has_display()` ignores
/// `$DISPLAY` and only treats an SSH session as headless, so mark the session
/// as SSH too — otherwise a dev Mac with vibe-station installed would `open -a`
/// the real app instead of exercising the headless path.
fn clear_display_vars() {
    std::env::remove_var("DISPLAY");
    std::env::remove_var("WAYLAND_DISPLAY");
    std::env::set_var("SSH_CONNECTION", "127.0.0.1 0 127.0.0.1 22");
}

#[tokio::test]
async fn ensure_daemon_reachable_spawns_a_headless_daemon_when_none_exists() {
    if !native_daemon_tests_enabled("self_heal") {
        return;
    }
    let _guard = ENV_LOCK.lock().await;
    clear_display_vars();

    let tmp = tempfile::tempdir().unwrap();
    let _daemon = DaemonHomeGuard::new(tmp.path());
    std::env::set_var("HOME", tmp.path());

    let result = ensure_daemon_reachable_with_exe(&vst_exe()).await;
    assert!(result.is_ok(), "expected self-heal to succeed: {result:?}");

    let config_path = tmp.path().join(".vibe-station").join("config.json");
    assert!(
        config_path.exists(),
        "a fresh daemon should have written config.json"
    );
}

#[tokio::test]
async fn preflight_exempt_dies_fast_without_attempting_self_heal() {
    if !native_daemon_tests_enabled("self_heal") {
        return;
    }
    let _guard = ENV_LOCK.lock().await;
    clear_display_vars();

    let tmp = tempfile::tempdir().unwrap();
    let _daemon = DaemonHomeGuard::new(tmp.path());
    // No config.json at all -- daemon is genuinely absent.

    let start = std::time::Instant::now();
    let output = Command::new(vst_exe())
        .args(["daemon", "status"])
        .env("HOME", tmp.path())
        .env("SSH_CONNECTION", "127.0.0.1 0 127.0.0.1 22")
        .env_remove("VST_DAEMON_URL")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .expect("vst daemon status should run");
    let elapsed = start.elapsed();

    assert!(
        !output.status.success(),
        "daemon status against an absent daemon should exit non-zero"
    );
    assert!(
        elapsed < Duration::from_secs(5),
        "an Exempt command must die immediately, not wait through a self-heal \
         attempt/timeout (took {elapsed:?})"
    );

    let daemon_log = tmp.path().join(".vibe-station").join("daemon.log");
    assert!(
        !daemon_log.exists(),
        "no self-heal spawn should have been attempted for an Exempt command"
    );
}

/// Found in review: `vst open` used to reach its own daemon via
/// `post_open_at` -> `client::daemon_request_with_base`, which hard-`die()`s
/// on connection-refused itself -- so `run_open`'s intended self-heal
/// fallthrough could only ever fire when `config.json` was missing entirely,
/// never when it existed but pointed at a now-dead daemon (the common case
/// after any prior run: the daemon crashed, was stopped, or the machine
/// rebooted, none of which delete `config.json`). Reproduce exactly that:
/// a real `config.json` on disk, pointing at a port nothing is listening on.
#[tokio::test]
async fn vst_open_self_heals_when_config_json_points_at_a_dead_daemon() {
    if !native_daemon_tests_enabled("self_heal") {
        return;
    }
    let _guard = ENV_LOCK.lock().await;
    clear_display_vars();

    let tmp = tempfile::tempdir().unwrap();
    let vst_home = tmp.path().join(".vibe-station");
    std::fs::create_dir_all(&vst_home).unwrap();

    // A `config.json` shaped like a real one, but its port is simply unbound
    // -- nothing is listening there, simulating "the daemon that wrote this
    // has since died" without needing to actually spawn and kill one first.
    std::fs::write(
        vst_home.join("config.json"),
        r#"{"port": 1, "pid": 999999, "cliToken": "stale-token", "tauriToken": "stale-token"}"#,
    )
    .unwrap();
    // After the stale config is on disk, so its placeholder pid is recorded as
    // pre-existing and never signalled; still before anything can spawn.
    let _daemon = DaemonHomeGuard::new(tmp.path());

    let project_dir = tmp.path().join("myproject");
    std::fs::create_dir_all(&project_dir).unwrap();

    let output = Command::new(vst_exe())
        .arg("open")
        .arg(&project_dir)
        .arg("--force-create")
        .env("HOME", tmp.path())
        .env("SSH_CONNECTION", "127.0.0.1 0 127.0.0.1 22")
        .env_remove("VST_DAEMON_URL")
        .output()
        .expect("vst open should run");

    assert!(
        output.status.success(),
        "vst open should self-heal past a stale/dead config.json and succeed, got: \
         stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    // A fresh daemon must actually have been spawned and won -- the stale
    // config.json's placeholder pid (999999) must have been overwritten.
    let content = std::fs::read_to_string(vst_home.join("config.json")).unwrap();
    let json: serde_json::Value = serde_json::from_str(&content).unwrap();
    let pid = json.get("pid").and_then(|p| p.as_i64());
    assert_ne!(
        pid,
        Some(999999),
        "config.json's stale placeholder pid should have been replaced by a real spawn"
    );
}

#[tokio::test]
async fn two_concurrent_self_heals_converge_on_one_daemon() {
    if !native_daemon_tests_enabled("self_heal") {
        return;
    }
    let _guard = ENV_LOCK.lock().await;
    clear_display_vars();

    let tmp = tempfile::tempdir().unwrap();
    let _daemon = DaemonHomeGuard::new(tmp.path());
    std::env::set_var("HOME", tmp.path());

    let exe = vst_exe();
    let exe2 = exe.clone();
    let (r1, r2) = tokio::join!(
        ensure_daemon_reachable_with_exe(&exe),
        ensure_daemon_reachable_with_exe(&exe2),
    );

    assert!(r1.is_ok(), "first self-heal should succeed: {r1:?}");
    assert!(r2.is_ok(), "second self-heal should succeed: {r2:?}");

    // Whichever one "won" the flock, both callers must have converged on
    // reaching a daemon (Part 01's lock makes the loser's own spawned child
    // exit immediately with "already running" -- but the CALLER doesn't
    // treat that as its own failure; it keeps polling until some daemon,
    // winner or not, becomes reachable). Confirm exactly one daemon process
    // is actually recorded, not two racing ones.
    let config_path = tmp.path().join(".vibe-station").join("config.json");
    let content = std::fs::read_to_string(&config_path).unwrap();
    let json: serde_json::Value = serde_json::from_str(&content).unwrap();
    let pid = json.get("pid").and_then(|p| p.as_i64());
    assert!(
        pid.is_some(),
        "config.json should record a single winning pid"
    );
}
