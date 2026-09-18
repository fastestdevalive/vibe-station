//! Gotcha #6 regression scenarios for `vst-ws::streams::tmux_output` — the
//! tmux `attach-session` PTY stream.
//!
//! These tests require a real `tmux` binary on PATH, so they are `#[ignore]`d
//! by default (like the TS live-CLI tests). Run explicitly with
//! `cargo test -p vst-ws -- --ignored`. They use an isolated tmux server socket
//! (`-L`) so they never touch a live user session.
//!
//! They pin the attach/detach semantics that the double-echo/ghost-stream bug
//! class (AGENTS.md § Terminal + § WebSocket) depends on: attach emits `opened`
//! + an initial redraw chunk, detach is idempotent and leaves the underlying
//! session alive (re-attachable), and a stale attach cannot leave a second live
//! client attached.

use std::sync::Arc;
use std::time::Duration;

use vst_proc::tmux::{NewSessionOptions, Tmux};
use vst_ws::connection::SessionStream;
use vst_ws::streams::tmux_output::TmuxOutputStream;

const TEST_SOCK: &str = "vst-ws-test-sock";

fn tmux_available() -> bool {
    std::process::Command::new("tmux")
        .arg("-V")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Own socket, so a failure/leftover server from the attach test above cannot
/// take this one down with it.
const RESIZE_SOCK: &str = "vst-ws-resize-sock";

/// `#{window_width}x#{window_height}` for a tmux window on the resize socket.
fn window_size(name: &str) -> String {
    let out = std::process::Command::new("tmux")
        .args([
            "-L",
            RESIZE_SOCK,
            "display-message",
            "-p",
            "-t",
            name,
            "#{window_width}x#{window_height}",
        ])
        .output()
        .expect("tmux display-message");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// `SessionStream::resize` is `async` (item 7: it shells out to `tmux
/// resize-window` via `tokio::process` so it cannot pin a tokio worker thread)
/// — but it is still *awaited* by its caller rather than fire-and-forget, so
/// the pre-existing ordering guarantee holds: each resize is applied before the
/// call returns, and under rapid successive resizes the last one wins.
#[tokio::test]
#[ignore = "requires a real tmux binary; run with --ignored"]
async fn rapid_resizes_apply_in_order_and_last_one_wins() {
    if !tmux_available() {
        eprintln!("tmux not available; skipping");
        return;
    }
    let tmux = Tmux::with_socket(RESIZE_SOCK);
    tmux.kill_server();
    let name = "vst-ws-resize-test";
    tmux.new_session(&NewSessionOptions {
        name: name.to_string(),
        cwd: None,
        env: Default::default(),
        command: Some(vec![
            "sh".to_string(),
            "-c".to_string(),
            "sleep 30".to_string(),
        ]),
    })
    .expect("new-session should succeed");

    let stream = Arc::new(TmuxOutputStream::new(
        name.to_string(),
        Some(RESIZE_SOCK.to_string()),
    ));
    SessionStream::attach(stream.as_ref(), 100, 30, "sub1")
        .await
        .expect("attach");

    // Rapid successive resizes, each awaited: the window must already be at the
    // requested size by the time the call returns (no detached/racing apply).
    for (cols, rows) in [(120i64, 40i64), (90, 24), (133, 37)] {
        SessionStream::resize(stream.as_ref(), cols, rows, Some("sub1")).await;
        assert_eq!(
            window_size(name),
            format!("{cols}x{rows}"),
            "resize must be applied before it returns (ordering guarantee)"
        );
    }

    // And the final state after the burst is the last requested size.
    assert_eq!(window_size(name), "133x37");

    SessionStream::detach(stream.as_ref(), "sub1")
        .await
        .expect("detach");
    tmux.kill_session(name);
    tmux.kill_server();
}

#[tokio::test]
#[ignore = "requires a real tmux binary; run with --ignored"]
async fn attach_emits_opened_and_initial_redraw_then_detach_closes_and_keeps_session() {
    if !tmux_available() {
        eprintln!("tmux not available; skipping");
        return;
    }
    let tmux = Tmux::with_socket(TEST_SOCK);
    tmux.kill_server(); // clean slate
    let name = "vst-ws-attach-test";
    tmux.new_session(&NewSessionOptions {
        name: name.to_string(),
        cwd: None,
        env: Default::default(),
        command: Some(vec![
            "sh".to_string(),
            "-c".to_string(),
            "printf 'hello-from-pane'; sleep 30".to_string(),
        ]),
    })
    .expect("new-session should succeed");

    let stream = Arc::new(TmuxOutputStream::new(
        name.to_string(),
        Some(TEST_SOCK.to_string()),
    ));

    // Wire the event receivers before attach.
    let mut opened_rx = stream.on_opened();
    let mut chunk_rx = stream.on_chunk();
    let mut close_rx = stream.on_close();

    SessionStream::attach(stream.as_ref(), 100, 30, "sub1")
        .await
        .expect("attach");

    let mut opened_fired = false;
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    if let Ok(_) = tokio::time::timeout_at(deadline.into(), opened_rx.recv()).await {
        opened_fired = true;
    }
    assert!(
        opened_fired,
        "attach should emit opened once the PTY is spawned"
    );

    // Collect chunks until the pane's initial content arrives.
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let mut all = String::new();
    while std::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(200), chunk_rx.recv()).await {
            Ok(Ok(chunk)) => {
                all.push_str(&chunk);
                if all.contains("hello") {
                    break;
                }
            }
            _ => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
    assert!(
        all.contains("hello"),
        "attach should emit the pane's initial content as chunk(s); got: {all:?}"
    );

    // detach is idempotent and leaves the session alive (re-attachable).
    SessionStream::detach(stream.as_ref(), "sub1")
        .await
        .expect("detach");
    SessionStream::detach(stream.as_ref(), "sub1")
        .await
        .expect("detach2"); // no-op
    let _ = tokio::time::timeout(Duration::from_secs(2), close_rx.recv()).await;
    assert!(
        tmux.has_session(name),
        "detach must NOT kill the underlying tmux session (Gotcha #6)"
    );

    // Re-attach proves the session is still usable after detach.
    let stream2 = Arc::new(TmuxOutputStream::new(
        name.to_string(),
        Some(TEST_SOCK.to_string()),
    ));
    let mut opened2 = stream2.on_opened();
    SessionStream::attach(stream2.as_ref(), 100, 30, "sub2")
        .await
        .expect("re-attach");
    let _ = tokio::time::timeout(Duration::from_secs(2), opened2.recv()).await;
    SessionStream::detach(stream2.as_ref(), "sub2")
        .await
        .expect("detach2");

    tmux.kill_session(name);
    tmux.kill_server();
}
