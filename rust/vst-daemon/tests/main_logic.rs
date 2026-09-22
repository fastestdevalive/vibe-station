//! Tests for main.rs helper logic (port discovery, lock acquisition).
//!
//! All tests use `tempfile::tempdir()` for isolation — never `~/.vibe-station`
//! or port 7421.

use std::sync::Arc;
use std::time::Instant;

use tempfile::tempdir;

use vst_agents::json_agent_registry::JsonAgentRegistry;
use vst_agents::json_agent_session::JsonAgentSession;
use vst_git::paths::Paths;
use vst_proc::tmux::Tmux;
use vst_store::StoreHandle;
use vst_types::events::Broadcaster;

use vst_daemon::lock::{acquire_lock, release_lock};
use vst_daemon::port::{find_free_port, port_is_free, PORT_SEARCH_RANGE};
use vst_daemon::server::{build_state, BuildServerOptions};

// ─── Port discovery ───────────────────────────────────────────────────────────

#[test]
fn find_free_port_returns_port_in_range() {
    // Use a high, unlikely-to-be-occupied start port.
    let start = 29800u16;
    let port = find_free_port(start).expect("should find a free port");
    assert!(port >= start, "port {port} should be >= start {start}");
    assert!(
        port < start + PORT_SEARCH_RANGE,
        "port {port} should be < start+range ({})",
        start + PORT_SEARCH_RANGE
    );
    assert!(
        port_is_free(port),
        "returned port {port} should still be free"
    );
}

#[test]
fn find_free_port_skips_occupied_ports() {
    // Bind the first few ports in range to force find_free_port to skip them.
    let start = 29700u16;
    let listeners: Vec<_> = (start..start + 5)
        .filter_map(|p| std::net::TcpListener::bind(format!("0.0.0.0:{p}")).ok())
        .collect();

    if listeners.len() == 5 {
        // All 5 ports occupied — find_free_port must return a port > start+4.
        let port = find_free_port(start).expect("should find a free port beyond occupied ones");
        assert!(
            port >= start + 5,
            "expected port after occupied block, got {port}"
        );
        assert!(port < start + PORT_SEARCH_RANGE);
    }
    // If we couldn't bind all 5 (some already in use), skip the assertion — the
    // environment is already messy and the test would produce a false negative.
    drop(listeners);
}

#[test]
fn find_free_port_fails_when_range_exhausted() {
    // Bind 100 consecutive ports (the full search range) if possible.
    let start = 29500u16;
    let listeners: Vec<_> = (start..start + PORT_SEARCH_RANGE)
        .filter_map(|p| std::net::TcpListener::bind(format!("0.0.0.0:{p}")).ok())
        .collect();

    if listeners.len() as u16 == PORT_SEARCH_RANGE {
        // All 100 ports occupied — find_free_port must error.
        let err = find_free_port(start);
        assert!(err.is_err(), "expected error when all ports occupied");
        let msg = err.unwrap_err().to_string();
        assert!(
            msg.contains("No free port"),
            "error should mention 'No free port', got: {msg}"
        );
    }
    drop(listeners);
}

// ─── Lock file ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn acquire_lock_creates_file_with_current_pid() {
    let tmp = tempdir().unwrap();
    let lock_path = tmp.path().join(".daemon.lock");

    acquire_lock(&lock_path)
        .await
        .expect("should acquire fresh lock");

    let written = tokio::fs::read_to_string(&lock_path).await.unwrap();
    let written_pid: u32 = written
        .trim()
        .parse()
        .expect("lock file should contain a PID");
    assert_eq!(written_pid, std::process::id());

    release_lock(&lock_path).await;
    assert!(
        !lock_path.exists(),
        "lock file should be removed after release"
    );
}

#[tokio::test]
async fn acquire_lock_creates_parent_directory() {
    let tmp = tempdir().unwrap();
    // Nested path — parent does not yet exist.
    let lock_path = tmp.path().join("nested").join("dir").join(".daemon.lock");

    acquire_lock(&lock_path)
        .await
        .expect("should create parent dirs and acquire lock");
    assert!(lock_path.exists());

    release_lock(&lock_path).await;
}

#[tokio::test]
async fn acquire_lock_takes_over_stale_pid() {
    let tmp = tempdir().unwrap();
    let lock_path = tmp.path().join(".daemon.lock");

    // Write a lock file with a PID that is extremely unlikely to exist.
    let dead_pid = 999_999i32;
    tokio::fs::write(&lock_path, dead_pid.to_string())
        .await
        .unwrap();

    // Should succeed — stale lock taken over.
    acquire_lock(&lock_path)
        .await
        .expect("should take over stale lock");

    let written = tokio::fs::read_to_string(&lock_path).await.unwrap();
    let written_pid: u32 = written.trim().parse().unwrap();
    assert_eq!(
        written_pid,
        std::process::id(),
        "lock should now contain our PID"
    );

    release_lock(&lock_path).await;
}

#[tokio::test]
async fn acquire_lock_rejects_live_pid() {
    let tmp = tempdir().unwrap();
    let lock_path = tmp.path().join(".daemon.lock");

    // PID 1 (init/systemd) is always alive on Linux.
    tokio::fs::write(&lock_path, "1").await.unwrap();

    let err = acquire_lock(&lock_path).await;
    assert!(err.is_err(), "should fail when stored pid is alive");
    let msg = err.unwrap_err().to_string();
    assert!(
        msg.contains("already running"),
        "error should mention 'already running', got: {msg}"
    );
}

// ─── Shared-index wiring (Phase 3, 3.T5) ─────────────────────────────────────

/// Build `BuildServerOptions` the same way `auth_middleware.rs`'s `make_opts`
/// does — all state isolated in a temp dir, no real ports bound.
fn make_opts(tmp: &std::path::Path) -> BuildServerOptions {
    let store = StoreHandle::open(&tmp.join("test.db")).unwrap();
    let broadcaster = Broadcaster::new(16);
    let json_registry = Arc::new(JsonAgentRegistry::<JsonAgentSession>::new());
    BuildServerOptions {
        port: 0,
        auth_state: None,
        no_auth: true,
        dist_path: None,
        persist_epoch: None,
        store,
        broadcaster,
        json_registry,
        tmux: Tmux::new(),
        started_at: Instant::now(),
        version: "test".to_string(),
        paths: Paths::with_home(tmp.to_path_buf()),
    }
}

/// Phase 3, 3.T5: `build_state` must wire ONE shared `Arc<FileSearchIndex>`
/// across the WS `DispatchContext` and the HTTP `WorktreeRoutes` (Decision 4).
/// Two separate instances would mean WS-driven index updates never reach
/// HTTP-driven queries.
#[tokio::test]
async fn build_state_shares_one_file_search_index() {
    let tmp = tempdir().unwrap();
    let opts = make_opts(tmp.path());

    let state = build_state(opts);

    assert!(
        Arc::ptr_eq(
            &state.dispatch_ctx.file_search,
            &state.worktree_routes.file_search
        ),
        "DispatchContext and WorktreeRoutes must share the same Arc<FileSearchIndex>"
    );
}
