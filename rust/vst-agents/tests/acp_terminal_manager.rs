//! Behavior contract for the ACP `terminal/*` manager — ports
//! `daemon/src/__tests__/acpTerminalManager.test.ts` (1.T2).
//!
//! `AcpTerminalManager` is the "host-managed terminal" half of the daemon's
//! ACP client surface: the wrapped CLI backgrounds a shell command and the
//! daemon holds the real child handle so the work survives past any single
//! turn. Spawns via `vst-proc`'s `spawn_child`/`PtyHandle` (the shared
//! subprocess-spawn abstraction the arch predicted), NOT a hand-rolled
//! `tokio::process::Command`.
//!
//! NOTE: `PtyHandle` exposes child exit only as a boolean (`is_exited`), not
//! the exit code / signal — so `TerminalExitStatus.exited` is the ported
//! observable, and the TS assertions on `exitCode === 0` are adapted to
//! `exited == true` here.

use vst_agents::acp_terminal_manager::{TerminalCreateParams, TerminalManager};

fn spawn_sleep(mgr: &TerminalManager) -> String {
    mgr.create(
        TerminalCreateParams {
            command: "sleep".into(),
            args: vec!["5".into()],
            cwd: None,
            env: Default::default(),
            output_byte_limit: None,
        },
        "sess-t",
        "proj-t",
        None,
    )
}

#[tokio::test]
async fn has_live_terminals_is_true_while_running_false_after_release() {
    let mgr = TerminalManager::default();
    let id = spawn_sleep(&mgr);
    assert!(mgr.has_live_terminals());
    mgr.release(&id);
    assert!(!mgr.has_live_terminals());
}

#[tokio::test]
async fn has_live_terminals_is_false_once_child_exits_on_its_own() {
    let mgr = TerminalManager::default();
    let id = mgr.create(
        TerminalCreateParams {
            command: "node".into(),
            args: vec!["-e".into(), "process.exit(0)".into()],
            cwd: None,
            env: Default::default(),
            output_byte_limit: None,
        },
        "sess-t",
        "proj-t",
        None,
    );
    let status = tokio::time::timeout(std::time::Duration::from_secs(15), mgr.wait_for_exit(&id))
        .await
        .expect("wait_for_exit should not hang")
        .expect("wait_for_exit should not error");
    assert!(status.exited);
    assert!(!mgr.has_live_terminals());
}

#[tokio::test]
async fn output_returns_buffered_stdout_and_not_truncated_under_limit() {
    let mgr = TerminalManager::default();
    let id = mgr.create(
        TerminalCreateParams {
            command: "node".into(),
            args: vec!["-e".into(), "process.stdout.write('hello')".into()],
            cwd: None,
            env: Default::default(),
            output_byte_limit: None,
        },
        "sess-t",
        "proj-t",
        None,
    );
    let _ = tokio::time::timeout(std::time::Duration::from_secs(15), mgr.wait_for_exit(&id))
        .await
        .expect("wait_for_exit should not hang")
        .expect("wait_for_exit should not error");
    let out = mgr.output(&id).expect("output for a known terminal");
    assert!(out.output.contains("hello"));
    assert!(!out.truncated);
}

#[tokio::test]
async fn kill_force_stops_a_live_child() {
    let mgr = TerminalManager::default();
    let id = mgr.create(
        TerminalCreateParams {
            command: "sleep".into(),
            args: vec!["30".into()],
            cwd: None,
            env: Default::default(),
            output_byte_limit: None,
        },
        "sess-t",
        "proj-t",
        None,
    );
    mgr.kill(&id);
    let status = tokio::time::timeout(std::time::Duration::from_secs(15), mgr.wait_for_exit(&id))
        .await
        .expect("wait_for_exit should not hang")
        .expect("wait_for_exit should not error");
    assert!(status.exited);
}

#[tokio::test]
async fn output_on_unknown_terminal_errors() {
    let mgr = TerminalManager::default();
    assert!(mgr.output("nope").is_err());
}
