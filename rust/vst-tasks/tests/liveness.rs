//! Real-process test of the default output-file writer probe (unix only).
#![cfg(unix)]

use std::process::{Command, Stdio};
use std::time::Duration;

use vst_tasks::{Liveness, LivenessProbe, OsWriterProbe};

#[tokio::test]
async fn probe_sees_a_writer_then_none_after_it_exits() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("out.output");
    std::fs::write(&file, b"").unwrap();
    let file = file.canonicalize().unwrap();
    let out = std::fs::OpenOptions::new()
        .append(true)
        .open(&file)
        .unwrap();
    let mut child = Command::new("sh")
        .args(["-c", "sleep 2"])
        .stdout(Stdio::from(out))
        .spawn()
        .unwrap();
    // The daemon-side handle above was moved into the child's stdout; only the
    // child (and its `sleep`) hold the file now.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let probe = OsWriterProbe;
    assert_eq!(probe.probe(&file).await, Liveness::Alive);
    child.wait().unwrap();
    // Environment-dependent by design: the probe answers `Unknown` (never a
    // guess) when it cannot read some same-user process's fd table, as on
    // locked-down CI runners. `NoWriter` itself is pinned deterministically by
    // the fake-/proc unit tests in `src/liveness.rs`; what must hold on every
    // host is that an exited writer is never reported `Alive`.
    let after = probe.probe(&file).await;
    assert!(
        matches!(after, Liveness::NoWriter | Liveness::Unknown),
        "exited writer must not look alive, got {after:?}"
    );
}

#[tokio::test]
async fn nonexistent_path_is_never_alive() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("nope.output");
    assert_ne!(OsWriterProbe.probe(&missing).await, Liveness::Alive);
}
