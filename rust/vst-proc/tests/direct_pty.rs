//! Behavior contract for `directPty.ts` (part 02-process-pty) behind the
//! `PtyHandle`/`spawn_child` abstraction. Ported from
//! `daemon/src/__tests__/directPty.test.ts` (cases 2.T1-2.T6) plus the
//! Gotcha #6 regression scenarios (detach-then-reattach not leaving a lingering
//! writer, resize-after-detach not panicking) required by the phase brief.
//!
//! These spawn real child processes through `portable-pty` and are therefore
//! integration tests requiring a POSIX pty (available in this sandbox).

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use tokio::sync::broadcast;
use vst_proc::{spawn_child, PtyHandle, SpawnChildOptions};

const SESSION_ID: &str = "test-sess";
const PROJECT_ID: &str = "test-proj";
const WORKTREE_ID: &str = "test-wt";

fn spawn_bash(script: &str) -> PtyHandle {
    let mut env = HashMap::new();
    env.insert("TERM".to_string(), "xterm-256color".to_string());
    env.insert(
        "HOME".to_string(),
        std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string()),
    );
    spawn_child(SpawnChildOptions {
        command: "bash".to_string(),
        args: vec!["-c".to_string(), script.to_string()],
        cwd: PathBuf::from("/tmp"),
        env,
        cols: 80,
        rows: 24,
        session_id: SESSION_ID.to_string(),
        project_id: PROJECT_ID.to_string(),
        worktree_id: Some(WORKTREE_ID.to_string()),
    })
    .expect("spawn bash child")
}

/// Wait for a `close` broadcast, bounded by a timeout so a hang is a failure
/// (rust-coding §9), not an indefinite test. If the child already exited before
/// the caller subscribed (`is_exited`), the broadcast close was missed (a
/// `broadcast` channel does not replay past events) — but "already exited" is
/// the same observable outcome, so return immediately instead of timing out.
async fn wait_close(handle: &PtyHandle, rx: &mut broadcast::Receiver<()>) {
    if handle.is_exited() {
        return;
    }
    tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .expect("timeout waiting for PTY close")
        .expect("close sender dropped before close fired");
}

/// Drain every chunk a receiver yields until the PTY closes, returning all
/// output concatenated. When close fires, any chunks still buffered alongside
/// it are drained first (`try_recv`) so output that arrived with/just-before
/// close is not lost to a `select!` that happens to pick the close branch.
async fn collect_chunks_until_close(
    rx: &mut broadcast::Receiver<String>,
    close: &mut broadcast::Receiver<()>,
) -> String {
    let mut out = String::new();
    loop {
        tokio::select! {
            chunk = rx.recv() => {
                match chunk {
                    Ok(c) => out.push_str(&c),
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            _ = close.recv() => {
                while let Ok(c) = rx.try_recv() {
                    out.push_str(&c);
                }
                break;
            }
        }
    }
    out
}

#[tokio::test]
async fn t1_spawn_receives_chunk_then_close() {
    let handle = spawn_bash("echo hello; sleep 0.1; exit 0");
    let mut chunk_rx = handle.on_chunk();
    let mut close_rx = handle.on_close();

    handle.attach(80, 24, "sub-1").await.expect("attach");

    let out = collect_chunks_until_close(&mut chunk_rx, &mut close_rx).await;
    assert!(out.contains("hello"), "output was: {out:?}");
    handle.kill();
}

#[tokio::test]
async fn t2_two_subscribers_both_receive_live_data() {
    let handle = spawn_bash("sleep 0.05; echo shared; sleep 0.2; exit 0");
    let mut chunk_a = handle.on_chunk();
    let mut chunk_b = handle.on_chunk();
    let mut close_a = handle.on_close();
    let mut close_b = handle.on_close();

    handle.attach(80, 24, "sub-A").await.expect("attach A");
    handle.attach(80, 24, "sub-B").await.expect("attach B");

    // Collect both subscribers concurrently: both must see the same live chunk
    // stream. (Collecting them sequentially races the already-fired close
    // against the buffered chunk, which is a harness bug, not an impl bug.)
    let (out_a, out_b) = tokio::join!(
        collect_chunks_until_close(&mut chunk_a, &mut close_a),
        collect_chunks_until_close(&mut chunk_b, &mut close_b),
    );
    assert!(out_a.contains("shared"), "A output was: {out_a:?}");
    assert!(out_b.contains("shared"), "B output was: {out_b:?}");
    handle.kill();
}

#[tokio::test]
async fn t3_ring_buffer_caps_at_64kb() {
    let script = "python3 -c \"import sys; sys.stdout.write('X' * 66000); sys.stdout.flush()\" 2>/dev/null || printf '%0.s.' {1..66000}; exit 0";
    let handle = spawn_bash(script);
    let mut close_rx = handle.on_close();
    wait_close(&handle, &mut close_rx).await;

    let recent = handle.get_recent_output(64 * 1024);
    assert!(
        recent.len() <= 64 * 1024,
        "ring exceeded 64KB: {}",
        recent.len()
    );
    handle.kill();
}

#[tokio::test]
async fn t4a_wait_for_output_true_when_needle_present() {
    let handle = spawn_bash("sleep 0.1; echo READY; sleep 0.5; exit 0");
    let found = handle
        .wait_for_output("READY", Duration::from_secs(3))
        .await;
    assert!(found);
    handle.kill();
}

#[tokio::test]
async fn t4b_wait_for_output_false_after_timeout() {
    let handle = spawn_bash("sleep 5; exit 0");
    let start = std::time::Instant::now();
    let found = handle
        .wait_for_output("NEVER_APPEARS", Duration::from_millis(300))
        .await;
    let elapsed = start.elapsed();
    assert!(!found);
    assert!(elapsed >= Duration::from_millis(290));
    handle.kill();
}

#[tokio::test]
async fn t5_attach_after_exit_replays_then_closes() {
    let handle = spawn_bash("echo POST_EXIT_DATA; exit 0");

    // Wait for the PTY to finish naturally.
    let mut first_close = handle.on_close();
    wait_close(&handle, &mut first_close).await;

    // Now attach after exit: replay chunk then close.
    let mut chunk_rx = handle.on_chunk();
    let mut close_rx = handle.on_close();
    handle
        .attach(80, 24, "late-sub")
        .await
        .expect("late attach");

    let out = collect_chunks_until_close(&mut chunk_rx, &mut close_rx).await;
    assert!(out.contains("POST_EXIT_DATA"), "replay was: {out:?}");
    handle.kill();
}

#[tokio::test]
async fn t6_detach_removes_only_subscriber_pty_stays_alive() {
    let handle = spawn_bash("sleep 0.3; echo AFTER_DETACH; sleep 0.5; exit 0");
    let mut chunk_b = handle.on_chunk();
    let mut close_b = handle.on_close();

    handle.attach(80, 24, "sub-A").await.expect("attach A");
    handle.attach(80, 24, "sub-B").await.expect("attach B");

    handle.detach("sub-A").await.expect("detach A");

    let out_b = collect_chunks_until_close(&mut chunk_b, &mut close_b).await;
    assert!(out_b.contains("AFTER_DETACH"), "B output was: {out_b:?}");
    handle.kill();
}

// --- Gotcha #6 regression scenarios (AGENTS.md § Terminal / § WebSocket) ---

#[tokio::test]
async fn detach_then_reattach_does_not_leave_a_lingering_writer() {
    let handle = spawn_bash("sleep 0.2; echo SECOND; sleep 0.2; exit 0");
    let mut chunk_rx = handle.on_chunk();
    let mut close_rx = handle.on_close();

    // A subscriber that detaches and reattaches must not spawn a duplicate PTY
    // writer: writes after a full detach→attach cycle still reach the one child.
    handle.attach(80, 24, "wanderer").await.expect("attach");
    handle.detach("wanderer").await.expect("detach");
    handle.attach(80, 24, "wanderer").await.expect("reattach");

    // The single child still streams to the single writer; no panic, no dupes.
    handle.write("ignored-input\r");
    let out = collect_chunks_until_close(&mut chunk_rx, &mut close_rx).await;
    assert!(out.contains("SECOND"), "output was: {out:?}");
    handle.kill();
}

#[tokio::test]
async fn resize_after_detach_does_not_panic() {
    let handle = spawn_bash("sleep 0.3; echo ALIVE; sleep 0.2; exit 0");
    let mut chunk_rx = handle.on_chunk();
    let mut close_rx = handle.on_close();

    handle.attach(80, 24, "sub").await.expect("attach");
    handle.resize(120, 40, Some("sub"));
    handle.detach("sub").await.expect("detach");

    // Resize with no active subscriber (passive observer path) is a silent no-op.
    handle.resize(100, 30, Some("sub"));
    handle.resize(100, 30, None);

    let out = collect_chunks_until_close(&mut chunk_rx, &mut close_rx).await;
    assert!(out.contains("ALIVE"), "output was: {out:?}");
    handle.kill();
}

#[tokio::test]
async fn attach_detach_are_idempotent_and_cheap_to_call_defensively() {
    let handle = spawn_bash("sleep 0.2; echo IDEMPOTENT; sleep 0.2; exit 0");
    let mut chunk_rx = handle.on_chunk();
    let mut close_rx = handle.on_close();

    // Double-attach and double-detach of the same subscriber are safe; the
    // caller (vst-ws, part 06) must be able to call these defensively while
    // enforcing "at most one live handle per (connection, session) key".
    handle.attach(80, 24, "s").await.expect("attach");
    handle.attach(80, 24, "s").await.expect("re-attach");
    handle.detach("s").await.expect("detach");
    handle.detach("s").await.expect("re-detach");

    let out = collect_chunks_until_close(&mut chunk_rx, &mut close_rx).await;
    assert!(out.contains("IDEMPOTENT"), "output was: {out:?}");
    handle.kill();
}

#[tokio::test]
async fn write_after_child_exit_is_silently_tolerated() {
    let handle = spawn_bash("exit 0");
    let mut close_rx = handle.on_close();
    wait_close(&handle, &mut close_rx).await;

    // Writing into a dead PTY must not panic or throw — the child_stdio guard
    // classifies EPIPE/ECONNRESET as benign and swallows them.
    handle.write("should be inert\r");
    handle.kill();
}
