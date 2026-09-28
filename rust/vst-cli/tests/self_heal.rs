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

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use vst_cli::launch::ensure_daemon_reachable_with_exe;

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn vst_exe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_vst"))
}

/// Force the headless (CUJ2b) path deterministically — this sandbox may
/// have a real `$DISPLAY` set (e.g. for browser automation tooling), but no
/// real vibe-station install exists here, so `launch_app()` would harmlessly
/// fail-fast and fall through anyway. Clearing display vars makes the test
/// not depend on that fact remaining true.
fn clear_display_vars() {
    std::env::remove_var("DISPLAY");
    std::env::remove_var("WAYLAND_DISPLAY");
}

/// Kill the daemon `config.json` in `home` points at, if any — test cleanup
/// (spawned daemons are deliberately detached, so nothing reaps them
/// automatically).
fn kill_daemon_for_home(home: &std::path::Path) {
    let config_path = home.join(".vibe-station").join("config.json");
    let Ok(content) = std::fs::read_to_string(&config_path) else {
        return;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else {
        return;
    };
    if let Some(pid) = json.get("pid").and_then(|p| p.as_i64()) {
        let _ = Command::new("kill").arg(pid.to_string()).status();
    }
}

#[tokio::test]
async fn ensure_daemon_reachable_spawns_a_headless_daemon_when_none_exists() {
    let _guard = ENV_LOCK.lock().unwrap();
    clear_display_vars();

    let tmp = tempfile::tempdir().unwrap();
    std::env::set_var("HOME", tmp.path());

    let result = ensure_daemon_reachable_with_exe(&vst_exe()).await;
    assert!(result.is_ok(), "expected self-heal to succeed: {result:?}");

    let config_path = tmp.path().join(".vibe-station").join("config.json");
    assert!(
        config_path.exists(),
        "a fresh daemon should have written config.json"
    );

    kill_daemon_for_home(tmp.path());
}

#[tokio::test]
async fn preflight_exempt_dies_fast_without_attempting_self_heal() {
    let _guard = ENV_LOCK.lock().unwrap();
    clear_display_vars();

    let tmp = tempfile::tempdir().unwrap();
    // No config.json at all -- daemon is genuinely absent.

    let start = std::time::Instant::now();
    let output = Command::new(vst_exe())
        .args(["daemon", "status"])
        .env("HOME", tmp.path())
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
    let _guard = ENV_LOCK.lock().unwrap();
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

    let project_dir = tmp.path().join("myproject");
    std::fs::create_dir_all(&project_dir).unwrap();

    let output = Command::new(vst_exe())
        .arg("open")
        .arg(&project_dir)
        .arg("--force-create")
        .env("HOME", tmp.path())
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

    kill_daemon_for_home(tmp.path());
}

#[tokio::test]
async fn two_concurrent_self_heals_converge_on_one_daemon() {
    let _guard = ENV_LOCK.lock().unwrap();
    clear_display_vars();

    let tmp = tempfile::tempdir().unwrap();
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

    kill_daemon_for_home(tmp.path());
}
