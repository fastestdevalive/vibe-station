//! Integration tests for the listener supervisor: the daemon's accept loop must
//! swap `127.0.0.1` ↔ `0.0.0.0` on a `NetworkControl::set` without a restart,
//! roll back on a failed bind so it never ends up unreachable, and drain cleanly
//! when the shutdown watch fires.
//!
//! These tests bind real TCP listeners and speak plain HTTP over them.

use std::net::IpAddr;
use std::time::Duration;

use axum::routing::get;
use axum::Router;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use vst_daemon::network::{spawn_listener_supervisor, NetworkControl};

/// A trivial router with no auth/middleware — every connection is served.
fn trivial_router() -> Router {
    Router::new().route("/", get(|| async { "ok" }))
}

/// The non-loopback IP the wildcard listener should accept connections on.
/// Found via the UDP default-route trick (no packets are actually sent).
fn local_non_loopback_ip() -> Option<IpAddr> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    let ip = s.local_addr().ok()?.ip();
    if ip.is_loopback() {
        None
    } else {
        Some(ip)
    }
}

/// Reserve an ephemeral port (then release it) for the supervisor to take.
async fn free_port() -> u16 {
    let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = probe.local_addr().unwrap().port();
    drop(probe);
    port
}

/// Connect to `addr`, retrying briefly — the supervisor's initial bind is
/// asynchronous, so the very first connection may race it.
async fn connect_with_retry(addr: &str) -> TcpStream {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        match TcpStream::connect(addr).await {
            Ok(s) => return s,
            Err(_) if tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(e) => panic!("connect {addr} failed: {e}"),
        }
    }
}

/// Send a minimal HTTP GET and assert the server answers 200.
async fn assert_serves(addr: &str) {
    let mut stream = connect_with_retry(addr).await;
    stream
        .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.unwrap();
    let resp = String::from_utf8(buf).unwrap();
    assert!(
        resp.contains("200 OK"),
        "expected 200 from {addr}, got: {resp}"
    );
}

/// Assert a connect to `addr` is refused (the listener is not bound there).
async fn assert_refused(addr: &str) {
    // A refused connect surfaces immediately (no listener); give it a moment in
    // case the swap is mid-flight, but it must NOT become reachable.
    let res = tokio::time::timeout(Duration::from_secs(1), TcpStream::connect(addr)).await;
    match res {
        Err(_) => {} // timed out without connecting — treat as refused
        Ok(Ok(_)) => panic!("expected {addr} to be refused, but it connected"),
        Ok(Err(_)) => {} // refused
    }
}

#[tokio::test]
async fn swap_enable_disable_switches_loopback_and_wildcard() {
    let port = free_port().await;
    let (swap_tx, swap_rx) = tokio::sync::mpsc::channel(4);
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let tmp = tempfile::tempdir().unwrap();
    let ctrl = NetworkControl::new(false, swap_tx, tmp.path().join("config.json"));
    let _supervisor = spawn_listener_supervisor(
        trivial_router(),
        port,
        false, // initial: loopback only
        shutdown_rx,
        swap_rx,
    );

    let loopback = format!("127.0.0.1:{port}");
    // Initial state: loopback serves, wildcard would not.
    assert_serves(&loopback).await;

    // Enable → wildcard; a non-loopback IP should now be served (if one exists).
    ctrl.set(true).await.unwrap();
    if let Some(non_loopback) = local_non_loopback_ip() {
        assert_serves(&format!("{non_loopback}:{port}")).await;
    }
    // Loopback is included in 0.0.0.0, so it still serves.
    assert_serves(&loopback).await;

    // Disable → loopback only again; a non-loopback IP is refused.
    ctrl.set(false).await.unwrap();
    if let Some(non_loopback) = local_non_loopback_ip() {
        assert_refused(&format!("{non_loopback}:{port}")).await;
    }
    assert_serves(&loopback).await;

    let _ = shutdown_tx.send(true);
}

#[tokio::test]
async fn connection_opened_before_swap_still_answers_after() {
    let port = free_port().await;
    let (swap_tx, swap_rx) = tokio::sync::mpsc::channel(4);
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let tmp = tempfile::tempdir().unwrap();
    let ctrl = NetworkControl::new(false, swap_tx, tmp.path().join("config.json"));
    let _supervisor =
        spawn_listener_supervisor(trivial_router(), port, false, shutdown_rx, swap_rx);

    let loopback = format!("127.0.0.1:{port}");
    // Open a connection while loopback-only, then enable (which aborts the
    // accept task and rebinds wildcard). The already-accepted connection's
    // handler must keep running.
    let mut stream = connect_with_retry(&loopback).await;
    ctrl.set(true).await.unwrap();

    stream
        .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.unwrap();
    let resp = String::from_utf8(buf).unwrap();
    assert!(resp.contains("200 OK"), "pre-swap connection died: {resp}");

    let _ = shutdown_tx.send(true);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn bind_failure_rolls_back_to_loopback_and_keeps_flag_false() {
    let port = free_port().await;
    // Hold a blocker on a specific loopback address (127.0.0.2) so the
    // wildcard bind (0.0.0.0, which includes it) fails with EADDRINUSE — while
    // 127.0.0.1 stays free for the rollback.
    let blocker = TcpListener::bind(format!("127.0.0.2:{port}"))
        .await
        .unwrap();

    let (swap_tx, swap_rx) = tokio::sync::mpsc::channel(4);
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let tmp = tempfile::tempdir().unwrap();
    let ctrl = NetworkControl::new(false, swap_tx, tmp.path().join("config.json"));
    let _supervisor =
        spawn_listener_supervisor(trivial_router(), port, false, shutdown_rx, swap_rx);

    let loopback = format!("127.0.0.1:{port}");
    assert_serves(&loopback).await;

    // Enabling must fail (wildcard conflicts with the blocker) and the flag
    // must stay false.
    let err = ctrl.set(true).await.unwrap_err();
    assert!(err.contains("bind"), "expected a bind error, got: {err}");
    assert!(!ctrl.is_enabled());

    // The rollback rebound 127.0.0.1 — it must still serve.
    assert_serves(&loopback).await;

    drop(blocker);
    let _ = shutdown_tx.send(true);
}

#[tokio::test]
async fn shutdown_watch_stops_supervisor_even_after_swap() {
    let port = free_port().await;
    let (swap_tx, swap_rx) = tokio::sync::mpsc::channel(4);
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let tmp = tempfile::tempdir().unwrap();
    let ctrl = NetworkControl::new(false, swap_tx, tmp.path().join("config.json"));
    let supervisor = spawn_listener_supervisor(trivial_router(), port, false, shutdown_rx, swap_rx);

    assert_serves(&format!("127.0.0.1:{port}")).await;
    // Swap once so the current accept task is a rebound one, then shut down.
    ctrl.set(true).await.unwrap();
    assert_serves(&format!("127.0.0.1:{port}")).await;

    let _ = shutdown_tx.send(true);
    let done = tokio::time::timeout(Duration::from_secs(5), supervisor).await;
    assert!(
        done.is_ok(),
        "supervisor should finish within 5s after shutdown"
    );
}

#[tokio::test]
async fn enable_rolls_back_when_persist_fails() {
    let port = free_port().await;
    let (swap_tx, swap_rx) = tokio::sync::mpsc::channel(4);
    let (_shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let bad_config = std::path::PathBuf::from("/nonexistent-vst-dir/config.json");
    let ctrl = NetworkControl::new(false, swap_tx, bad_config);
    let _supervisor =
        spawn_listener_supervisor(trivial_router(), port, false, shutdown_rx, swap_rx);
    assert_serves(&format!("127.0.0.1:{port}")).await;

    let err = ctrl.set(true).await.unwrap_err();

    assert!(err.contains("persist"), "got: {err}");
    assert!(!ctrl.is_enabled(), "flag must not flip when persist fails");
    assert_serves(&format!("127.0.0.1:{port}")).await;
}

#[tokio::test]
async fn disable_fails_closed_even_when_persist_fails() {
    let port = free_port().await;
    let (swap_tx, swap_rx) = tokio::sync::mpsc::channel(4);
    let (_shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let bad_config = std::path::PathBuf::from("/nonexistent-vst-dir/config.json");
    let ctrl = NetworkControl::new(true, swap_tx, bad_config);
    let mut rx = ctrl.subscribe();
    let _supervisor = spawn_listener_supervisor(trivial_router(), port, true, shutdown_rx, swap_rx);
    assert_serves(&format!("127.0.0.1:{port}")).await;

    let _ = ctrl.set(false).await;

    assert!(!ctrl.is_enabled(), "gate must be closed after a disable");
    assert!(
        ctrl.set(false).await.is_err(),
        "a retry after a failed disable must re-run the swap/persist, not no-op"
    );
    assert!(!*rx.borrow_and_update(), "watch must report disabled");
}
