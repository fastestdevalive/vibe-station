//! A FIFO inside a repo must never hang the plain file reader or the read gate.

use std::time::Duration;

use vst_routes::artifact_gate::{gate_read, GateError};
use vst_routes::file_serving::{read_file_response, FileResponse, FileServingError};
use vst_types::artifacts::ScopeKey;

fn mkfifo(path: &std::path::Path) {
    // The crate forbids `unsafe`, so shell out rather than call libc::mkfifo.
    let st = std::process::Command::new("mkfifo")
        .arg(path)
        .status()
        .unwrap();
    assert!(st.success());
}

#[tokio::test]
async fn gate_denies_a_fifo_and_the_reader_refuses_it_without_blocking() {
    let d = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(d.path()).unwrap();
    std::fs::write(root.join("ok.md"), "hi").unwrap();
    mkfifo(&root.join("plan.md"));
    let scope = ScopeKey::worktree("w1");

    let gated = tokio::time::timeout(
        Duration::from_secs(5),
        gate_read(None, &scope, &root, "plan.md", Some(root.join("plan.md"))),
    )
    .await
    .expect("gate must not block on a FIFO");
    assert!(matches!(gated, Err(GateError::Denied(_))), "{gated:?}");

    let read = tokio::time::timeout(
        Duration::from_secs(5),
        read_file_response(&root.join("plan.md")),
    )
    .await
    .expect("reader must not block on a FIFO");
    assert!(
        matches!(read, Err(FileServingError::Unprocessable(_))),
        "{read:?}"
    );

    // Regular files are unaffected.
    let ok = gate_read(None, &scope, &root, "ok.md", Some(root.join("ok.md"))).await;
    assert!(ok.is_ok(), "{ok:?}");
    assert!(matches!(
        read_file_response(&root.join("ok.md")).await,
        Ok(FileResponse::Text { .. })
    ));
}
