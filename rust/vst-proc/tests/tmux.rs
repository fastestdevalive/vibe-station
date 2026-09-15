//! Behavior contract for `tmux.ts` (part 02-process-pty), focused on
//! `listSessionNames`/`listSessions` failure semantics.
//!
//! The lifecycle poller uses this one snapshot per tick to decide which sessions
//! are still alive, so the difference between "tmux says nothing is running" and
//! "the tmux call failed" is load-bearing: collapsing the latter to an empty set
//! would mark EVERY session exited in a single tick — hundreds of
//! `session:exited` broadcasts and DB writes — from one transient hiccup.
//!
//! The pure parse/classify helpers are the exact port of the mocked-execFile
//! vitest cases; a real-tmux integration test (isolated socket) exercises the
//! happy path end to end.

use std::collections::HashSet;

use vst_proc::tmux::{classify_list_sessions_error, parse_list_sessions_output, ListErrorClass};
use vst_proc::{NewSessionOptions, Tmux};

#[test]
fn parses_live_session_names_into_a_set() {
    assert_eq!(
        parse_list_sessions_output("alpha\nbeta\n"),
        HashSet::from(["alpha".to_string(), "beta".to_string()])
    );
}

#[test]
fn no_server_running_is_classified_as_authoritative_empty() {
    // Empty set, NOT null: nothing is running, so every session really is gone
    // and the poller should act on it.
    let class = classify_list_sessions_error("no server running on /tmp/tmux-1000/default");
    assert!(matches!(class, ListErrorClass::NoServer));
}

#[test]
fn uninterpretable_failure_is_classified_separately() {
    let class = classify_list_sessions_error("tmux: unexpected catastrophe");
    assert!(matches!(class, ListErrorClass::Uninterpretable));
}

#[test]
fn error_connecting_variants_are_also_no_server() {
    for msg in [
        "error connecting to /tmp/tmux-1000/default",
        "No such file or directory",
    ] {
        assert!(
            matches!(classify_list_sessions_error(msg), ListErrorClass::NoServer),
            "expected {msg:?} to classify as NoServer"
        );
    }
}

// --- Real tmux integration (isolated socket, safe against a live user server) ---

fn tmux_on_path() -> bool {
    std::process::Command::new("tmux")
        .arg("-V")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn unique_socket() -> String {
    let n = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("vst-test-{n}-{nanos}")
}

#[test]
fn real_tmux_list_sessions_round_trip() {
    if !tmux_on_path() {
        eprintln!("skipping: no tmux binary on PATH");
        return;
    }
    let sock = unique_socket();
    let tmux = Tmux::with_socket(&sock);

    // Fresh socket: nothing running yet -> authoritative empty set (not null).
    assert_eq!(tmux.list_session_names(), Some(HashSet::new()));

    tmux.new_session(&NewSessionOptions {
        name: "alpha".to_string(),
        command: Some(vec!["sleep".to_string(), "30".to_string()]),
        ..Default::default()
    })
    .expect("create alpha");
    tmux.new_session(&NewSessionOptions {
        name: "beta".to_string(),
        command: Some(vec!["sleep".to_string(), "30".to_string()]),
        ..Default::default()
    })
    .expect("create beta");

    assert_eq!(
        tmux.list_session_names(),
        Some(HashSet::from(["alpha".to_string(), "beta".to_string()]))
    );
    assert_eq!(tmux.has_session("alpha"), true);
    assert_eq!(tmux.has_session("missing"), false);

    // listSessions keeps its array contract on top of the set.
    let mut sessions = tmux.list_sessions();
    sessions.sort();
    assert_eq!(sessions, vec!["alpha".to_string(), "beta".to_string()]);

    // Best-effort kill is idempotent / safe on missing sessions.
    tmux.kill_session("alpha");
    tmux.kill_session("does-not-exist");

    // Cleanup the whole isolated server.
    tmux.kill_server();
}
