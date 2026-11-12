//! `vst-daemon agy-stream-acp`: stdout is the ACP channel and must carry
//! JSON-RPC lines only (no tracing noise).
//!
//! Starts the real daemon binary: `VST_NATIVE_DAEMON_TESTS=1` (Docker/CI)
//! only, held in a `ChildGuard`.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use vst_testkit::{native_daemon_tests_enabled, ChildGuard};

#[test]
fn initialize_round_trip_stdout_is_pure_jsonrpc() {
    if !native_daemon_tests_enabled("agy_stream_acp_cmd") {
        return;
    }
    let home = tempfile::tempdir().unwrap();
    let mut child = ChildGuard::spawn(
        Command::new(env!("CARGO_BIN_EXE_vst-daemon"))
            .arg("agy-stream-acp")
            .env("AGY_BIN", "/nonexistent")
            .env("HOME", home.path())
            .env("RUST_LOG", "trace")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null()),
    )
    .expect("spawn vst-daemon agy-stream-acp");

    let mut stdin = child.stdin.take().unwrap();
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":1}}}}"#
    )
    .unwrap();
    stdin.flush().unwrap();

    let mut reader = BufReader::new(child.stdout.take().unwrap());
    let mut first = String::new();
    reader.read_line(&mut first).unwrap();
    let v: serde_json::Value = serde_json::from_str(first.trim()).expect("first line is JSON");
    assert!(v["result"]["protocolVersion"].is_number(), "got {v}");

    // Close stdin: the agent exits 0 and everything it printed was JSON.
    drop(stdin);
    for line in reader.lines() {
        let line = line.unwrap();
        assert!(
            serde_json::from_str::<serde_json::Value>(line.trim()).is_ok(),
            "non-JSON stdout line: {line}"
        );
    }

    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        assert!(
            Instant::now() < deadline,
            "agent did not exit after stdin EOF"
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(status.success(), "exit status {status:?}");
}
