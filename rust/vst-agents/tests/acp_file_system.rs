//! Behavior contract for the ACP `fs/*` handlers — ports
//! `daemon/src/__tests__/acpFileSystem.test.ts` (1.T5).
//!
//! `resolve_scoped` is a courtesy check, not a security boundary (ACP's
//! `fs/*` mirrors the CLI's own filesystem reach) — port that faithfully,
//! don't tighten it into a sandbox.

use std::fs;

use tempfile::tempdir;
use vst_agents::acp_file_system::{read_text_file, write_text_file};

#[tokio::test]
async fn reads_a_file_inside_the_cwd_by_relative_path() {
    let dir = tempdir().unwrap();
    let cwd = dir.path();
    fs::write(cwd.join("hello.txt"), "hello world").unwrap();
    let content = read_text_file(cwd, "hello.txt", None, None).await.unwrap();
    assert_eq!(content, "hello world");
}

#[tokio::test]
async fn writes_a_file_inside_the_cwd() {
    let dir = tempdir().unwrap();
    let cwd = dir.path();
    write_text_file(cwd, "out.txt", "written").await.unwrap();
    let content = fs::read_to_string(cwd.join("out.txt")).unwrap();
    assert_eq!(content, "written");
}

#[tokio::test]
async fn returns_error_for_a_missing_path() {
    let dir = tempdir().unwrap();
    let cwd = dir.path();
    assert!(read_text_file(cwd, "does-not-exist.txt", None, None)
        .await
        .is_err());
}

#[tokio::test]
async fn respects_line_limit_slicing() {
    let dir = tempdir().unwrap();
    let cwd = dir.path();
    fs::write(cwd.join("multi.txt"), "l1\nl2\nl3\nl4\n").unwrap();
    let content = read_text_file(cwd, "multi.txt", Some(2), Some(2))
        .await
        .unwrap();
    assert_eq!(content.split('\n').collect::<Vec<_>>(), vec!["l2", "l3"]);
}

#[tokio::test]
async fn resolves_an_absolute_path() {
    let dir = tempdir().unwrap();
    let cwd = dir.path();
    fs::write(cwd.join("a.txt"), "abs").unwrap();
    let abs = cwd.join("a.txt").to_string_lossy().into_owned();
    let content = read_text_file(cwd, &abs, None, None).await.unwrap();
    assert_eq!(content, "abs");
}
