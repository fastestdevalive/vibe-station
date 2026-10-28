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
    // Tests run on parallel threads of one process and macOS clocks have
    // microsecond resolution, so pid + nanos alone can collide: add a counter.
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let n = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("vst-test-{n}-{nanos}-{seq}")
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

// --- Hardened paste (stdin buffer, exact targets, copy-mode flags) ---

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use vst_proc::tmux::parse_pane_flags;
use vst_proc::PaneFlags;

/// Isolated tmux server that is killed on drop, so a failing assertion never
/// leaks a server.
struct Server {
    socket: String,
    tmux: Tmux,
    dir: tempfile::TempDir,
}

impl Server {
    fn new() -> Option<Self> {
        if !tmux_on_path() {
            eprintln!("skipping: no tmux binary on PATH");
            return None;
        }
        let socket = unique_socket();
        Some(Self {
            tmux: Tmux::with_socket(&socket),
            socket,
            dir: tempfile::tempdir().expect("tempdir"),
        })
    }

    fn session(&self, name: &str, argv: &[&str]) {
        self.tmux
            .new_session(&NewSessionOptions {
                name: name.to_string(),
                command: Some(argv.iter().map(ToString::to_string).collect()),
                ..Default::default()
            })
            .expect("create session");
    }

    fn file(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    /// A session whose pane runs `<setup>; touch <name>.ready; cat <redirect>
    /// <name>.out`, and blocks until the ready marker exists (so the tty mode is
    /// set before any paste). Returns the output file path.
    fn cat_pane(&self, name: &str, setup: &str, cat: &str) -> PathBuf {
        let out = self.file(&format!("{name}.out"));
        let ready = self.file(&format!("{name}.ready"));
        let script = format!(
            "{setup}; touch '{}'; {cat} > '{}'",
            ready.display(),
            out.display()
        );
        self.session(name, &["sh", "-c", &script]);
        wait_for("pane ready marker", || ready.exists());
        out
    }

    /// Raw tty (no CR/LF translation, no canonical line limit, no echo).
    fn raw_cat(&self, name: &str) -> PathBuf {
        self.cat_pane(name, "stty raw -echo", "cat")
    }

    fn tmux_cmd(&self, args: &[&str]) -> String {
        let out = std::process::Command::new("tmux")
            .arg("-L")
            .arg(&self.socket)
            .args(args)
            .output()
            .expect("tmux");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.tmux.kill_server();
    }
}

fn wait_for(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if cond() {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("timed out waiting for {what}");
}

fn read(path: &Path) -> Vec<u8> {
    std::fs::read(path).unwrap_or_default()
}

fn vr_buf_files() -> Vec<String> {
    std::fs::read_dir(std::env::temp_dir())
        .map(|rd| {
            rd.filter_map(Result::ok)
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.starts_with("vr-buf"))
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn paste_multiline_is_byte_exact_with_no_tmp_file_and_no_leftover_buffer() {
    let Some(srv) = Server::new() else { return };
    // Cooked tty on purpose: the default paste converts LF to CR and the line
    // discipline's ICRNL turns it back, so the bytes round-trip exactly.
    let out = srv.cat_pane("p", "true", "cat");
    let text = "first line\nsecond: \u{1F600} \u{4F60}\u{597D}\n\tthird\n";

    let stop = Arc::new(AtomicBool::new(false));
    let seen = Arc::new(AtomicBool::new(false));
    let watcher = {
        let (stop, seen) = (stop.clone(), seen.clone());
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                if !vr_buf_files().is_empty() {
                    seen.store(true, Ordering::Relaxed);
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        })
    };
    srv.tmux.paste_buffer("=p:", "buf", text).expect("paste");
    wait_for("pasted bytes", || read(&out) == text.as_bytes());
    stop.store(true, Ordering::Relaxed);
    watcher.join().expect("watcher");

    assert!(!seen.load(Ordering::Relaxed), "a /tmp/vr-buf file appeared");
    assert!(vr_buf_files().is_empty(), "leftover /tmp/vr-buf file");
    assert_eq!(srv.tmux_cmd(&["list-buffers"]), "", "buffer list not empty");
}

#[test]
fn paste_128_kb_completes_without_deadlock() {
    let Some(srv) = Server::new() else { return };
    let out = srv.raw_cat("big");
    let line = "0123456789abcdef".repeat(8); // 128 bytes
    let text: String = (0..1024).map(|_| format!("{line}\n")).collect::<String>();
    assert_eq!(text.len(), 1024 * 129);
    let raw = text.len();

    let start = Instant::now();
    srv.tmux
        .paste_buffer_with("=big:", "buf", &text, true)
        .expect("paste 128KB");
    assert!(
        start.elapsed() < Duration::from_secs(5),
        "paste call too slow: {:?}",
        start.elapsed()
    );
    wait_for("128 KB to arrive", || read(&out).len() >= raw);
    assert_eq!(read(&out), text.as_bytes());
    assert!(start.elapsed() < Duration::from_secs(5));
}

#[test]
fn concurrent_pastes_with_the_same_buffer_id_do_not_cross() {
    let Some(srv) = Server::new() else { return };
    let out_a = srv.raw_cat("pa");
    let out_b = srv.raw_cat("pb");
    let rounds = 20;
    for _ in 0..rounds {
        let (ta, tb) = (srv.tmux.clone(), srv.tmux.clone());
        let a = std::thread::spawn(move || ta.paste_buffer_with("=pa:", "same", "AAAAAAAA", true));
        let b = std::thread::spawn(move || tb.paste_buffer_with("=pb:", "same", "BBBBBBBB", true));
        a.join().expect("a").expect("paste a");
        b.join().expect("b").expect("paste b");
    }
    let want_a = "AAAAAAAA".repeat(rounds);
    let want_b = "BBBBBBBB".repeat(rounds);
    wait_for("both panes filled", || {
        read(&out_a).len() >= want_a.len() && read(&out_b).len() >= want_b.len()
    });
    assert_eq!(read(&out_a), want_a.as_bytes());
    assert_eq!(read(&out_b), want_b.as_bytes());
}

#[test]
fn raw_lf_preserves_lf_and_default_converts_to_cr() {
    let Some(srv) = Server::new() else { return };
    // No ICRNL and no echo: CR shows as `^M`, LF as a bare `$` in `cat -vet`.
    let raw = srv.cat_pane("raw", "stty -icrnl -echo -icanon", "head -c 3 | cat -vet");
    let dflt = srv.cat_pane("dflt", "stty -icrnl -echo -icanon", "head -c 3 | cat -vet");

    srv.tmux
        .paste_buffer_with("=raw:", "b", "a\nb", true)
        .expect("raw paste");
    srv.tmux.paste_buffer("=dflt:", "b", "a\nb").expect("paste");

    // `head -c 3` ends the pipeline after the 3 pasted bytes so `cat -vet` flushes.
    wait_for("raw output", || read(&raw).ends_with(b"b"));
    wait_for("default output", || read(&dflt).ends_with(b"b"));
    assert_eq!(String::from_utf8_lossy(&read(&raw)), "a$\nb");
    // A tmux upgrade that changes this default must surface here.
    assert_eq!(String::from_utf8_lossy(&read(&dflt)), "a^Mb");
}

#[test]
fn exact_target_does_not_prefix_match() {
    let Some(srv) = Server::new() else { return };
    let out_agent = srv.raw_cat("agent");
    let out_agent2 = srv.raw_cat("agent2");

    srv.tmux
        .paste_buffer_with("=agent:", "b", "to-agent", true)
        .expect("paste");
    wait_for("agent paste", || read(&out_agent) == b"to-agent");
    std::thread::sleep(Duration::from_millis(200));
    assert!(read(&out_agent2).is_empty(), "agent2 must not receive it");

    // With only `agent2` alive, the bare name prefix-matches but `=agent:` does not.
    srv.tmux.kill_session("=agent:");
    assert!(
        srv.tmux.pane_flags("agent").is_some(),
        "bare name prefix-matches"
    );
    assert_eq!(srv.tmux.pane_flags("=agent:"), None);
    assert!(srv.tmux.pane_flags("=agent2:").is_some());
}

#[test]
fn pane_flags_and_cancel_mode() {
    let Some(srv) = Server::new() else { return };
    srv.session("anchor", &["sleep", "60"]);
    srv.session("live", &["sleep", "60"]);

    assert_eq!(
        srv.tmux.pane_flags("=live:"),
        Some(PaneFlags {
            in_mode: false,
            dead: false
        })
    );
    assert_eq!(srv.tmux.pane_flags("=missing:"), None);

    srv.tmux_cmd(&["copy-mode", "-t", "=live:"]);
    assert_eq!(srv.tmux.pane_flags("=live:").map(|f| f.in_mode), Some(true));
    srv.tmux.cancel_mode("=live:").expect("cancel copy-mode");
    assert_eq!(
        srv.tmux.pane_flags("=live:").map(|f| f.in_mode),
        Some(false)
    );
    // Not in a mode any more: tmux refuses, and we surface it.
    assert!(srv.tmux.cancel_mode("=live:").is_err());

    // remain-on-exit keeps the exited pane listed as dead.
    srv.tmux_cmd(&["set-option", "-g", "remain-on-exit", "on"]);
    srv.session("dead", &["sh", "-c", "exit 0"]);
    wait_for("pane to be dead", || {
        srv.tmux.pane_flags("=dead:").is_some_and(|f| f.dead)
    });
    assert!(srv
        .tmux
        .list_session_names()
        .is_some_and(|s| s.contains("dead")));
}

#[test]
fn parse_pane_flags_is_strict() {
    assert_eq!(
        parse_pane_flags("1 0"),
        Some(PaneFlags {
            in_mode: true,
            dead: false
        })
    );
    for bad in ["", "1", "1 0 0", "x y", "2 0", "0 \n"] {
        assert_eq!(parse_pane_flags(bad), None, "{bad:?}");
    }
}
