//! Hand-over tests: root confinement (incl. a symlink escape), the prefix/replace rule and
//! the hard-link fallback.

mod common;

use std::fs;
use std::os::unix::fs::symlink;
use std::path::Path;

use vst_accounts::handover::{apply, HandoverError};
use vst_types::{FileTransfer, TransferMode};

fn setup() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
    let root = tempfile::tempdir().expect("tempdir");
    let from = root.path().join("from");
    let to = root.path().join("to");
    fs::create_dir_all(&from).expect("mkdir from");
    fs::create_dir_all(&to).expect("mkdir to");
    (root, from, to)
}

fn transfer(from: &Path, to: &Path, mode: TransferMode) -> FileTransfer {
    FileTransfer {
        from: from.to_path_buf(),
        to: to.to_path_buf(),
        mode,
    }
}

#[test]
fn handover_refuses_outside_roots() {
    let (root, from, to) = setup();
    let outside = root.path().join("outside.jsonl");
    fs::write(&outside, "outside").expect("write outside");
    let err = apply(
        &[transfer(&outside, &to.join("a.jsonl"), TransferMode::Copy)],
        &from,
        &to,
    )
    .expect_err("a source outside the old account folder must be refused");
    assert!(
        matches!(err, HandoverError::SourceOutsideRoot(_)),
        "{err:?}"
    );

    // A symlink inside the old folder that points outside is refused too.
    let real = root.path().join("real.jsonl");
    fs::write(&real, "real").expect("write real");
    symlink(&real, from.join("link.jsonl")).expect("symlink");
    let err = apply(
        &[transfer(
            &from.join("link.jsonl"),
            &to.join("b.jsonl"),
            TransferMode::Copy,
        )],
        &from,
        &to,
    )
    .expect_err("a symlink escape must be refused");
    assert!(
        matches!(err, HandoverError::SourceOutsideRoot(_)),
        "{err:?}"
    );

    // A target outside the new folder is refused.
    let escape_dir = root.path().join("escape");
    fs::create_dir_all(&escape_dir).expect("mkdir escape");
    symlink(&escape_dir, to.join("sub")).expect("symlink dir");
    let source = from.join("session.jsonl");
    fs::write(&source, "data").expect("write source");
    let err = apply(
        &[transfer(
            &source,
            &to.join("sub").join("c.jsonl"),
            TransferMode::Copy,
        )],
        &from,
        &to,
    )
    .expect_err("a target symlink escape must be refused");
    assert!(
        matches!(err, HandoverError::TargetOutsideRoot(_)),
        "{err:?}"
    );
}

fn pair(
    src: &str,
    tgt: &str,
) -> (
    tempfile::TempDir,
    std::path::PathBuf,
    std::path::PathBuf,
    std::path::PathBuf,
    std::path::PathBuf,
) {
    let (root, from, to) = setup();
    let source = from.join("session.jsonl");
    fs::write(&source, src).expect("write source");
    let target = to.join("session.jsonl");
    fs::write(&target, tgt).expect("write target");
    (root, from, to, source, target)
}

#[test]
fn handover_no_clobber() {
    let (_root, from, to, source, target) = pair("abcde", "12345");
    let err = apply(
        &[transfer(&source, &target, TransferMode::Copy)],
        &from,
        &to,
    )
    .expect_err("same length, different bytes");
    assert!(matches!(err, HandoverError::WouldClobber(_)), "{err:?}");
    assert_eq!(fs::read_to_string(&target).expect("read"), "12345");

    fs::write(&target, "a different length").expect("write");
    let err = apply(
        &[transfer(&source, &target, TransferMode::Copy)],
        &from,
        &to,
    )
    .expect_err("unrelated file");
    assert!(matches!(err, HandoverError::WouldClobber(_)), "{err:?}");
    assert_eq!(
        fs::read_to_string(&target).expect("read"),
        "a different length"
    );
}

#[test]
fn handover_identical_target_is_skipped() {
    let (_root, from, to, source, target) = pair("same\n", "same\n");
    let r = apply(
        &[transfer(&source, &target, TransferMode::Copy)],
        &from,
        &to,
    )
    .expect("apply");
    assert_eq!((r.applied, r.skipped, r.replaced), (0, 1, 0));
}

#[test]
fn handover_replaces_an_earlier_copy() {
    let (_root, from, to, source, target) = pair("a\nb\nc\n", "a\nb\n");
    let r = apply(
        &[transfer(&source, &target, TransferMode::Copy)],
        &from,
        &to,
    )
    .expect("apply");
    assert_eq!((r.replaced, r.applied, r.skipped), (1, 0, 0));
    assert_eq!(fs::read_to_string(&target).expect("read"), "a\nb\nc\n");
    let leftovers: Vec<_> = fs::read_dir(&to)
        .expect("ls")
        .map(|e| e.expect("e").file_name())
        .collect();
    assert_eq!(leftovers.len(), 1, "no temp file left: {leftovers:?}");
}

#[test]
fn handover_keeps_a_target_that_already_holds_the_source() {
    let (_root, from, to, source, target) = pair("a\nb\n", "a\nb\nc\n");
    let r = apply(
        &[transfer(&source, &target, TransferMode::Copy)],
        &from,
        &to,
    )
    .expect("apply");
    assert_eq!((r.skipped, r.replaced), (1, 0));
    assert_eq!(fs::read_to_string(&target).expect("read"), "a\nb\nc\n");
}

#[test]
fn handover_refuses_diverged_content() {
    let (_root, from, to, source, target) = pair("a\nb\nc\n", "a\nX\n");
    let err = apply(
        &[transfer(&source, &target, TransferMode::Copy)],
        &from,
        &to,
    )
    .expect_err("diverged");
    assert!(matches!(err, HandoverError::WouldClobber(_)), "{err:?}");
    assert_eq!(fs::read_to_string(&target).expect("read"), "a\nX\n");
}

#[test]
fn handover_refuses_a_symlink_target() {
    let (root, from, to) = setup();
    let source = from.join("session.jsonl");
    fs::write(&source, "a\nb\n").expect("write");
    let outside = root.path().join("outside.jsonl");
    fs::write(&outside, "a\n").expect("write");
    let target = to.join("session.jsonl");
    symlink(&outside, &target).expect("symlink");
    let err = apply(
        &[transfer(&source, &target, TransferMode::Copy)],
        &from,
        &to,
    )
    .expect_err("symlink target");
    assert!(matches!(err, HandoverError::WouldClobber(_)), "{err:?}");
    assert_eq!(fs::read_to_string(&outside).expect("read"), "a\n");
}

#[test]
fn handover_round_trip() {
    let (_root, a_dir, b_dir) = setup();
    let a = a_dir.join("chat.jsonl");
    let b = b_dir.join("chat.jsonl");
    fs::write(&a, "1\n").expect("write");
    apply(&[transfer(&a, &b, TransferMode::Copy)], &a_dir, &b_dir).expect("a to b");
    fs::write(&b, "1\n2\n").expect("append b");
    let r = apply(&[transfer(&b, &a, TransferMode::Copy)], &b_dir, &a_dir).expect("b to a");
    assert_eq!(r.replaced, 1);
    fs::write(&a, "1\n2\n3\n").expect("append a");
    let r = apply(&[transfer(&a, &b, TransferMode::Copy)], &a_dir, &b_dir).expect("a to b");
    assert_eq!(r.replaced, 1);
    assert_eq!(fs::read(&a).expect("a"), fs::read(&b).expect("b"));
}

#[test]
fn handover_hardlink_replaces_an_earlier_copy() {
    let (_root, from, to, source, target) = pair("a\nb\nc\n", "a\n");
    let r = apply(
        &[transfer(&source, &target, TransferMode::HardLink)],
        &from,
        &to,
    )
    .expect("apply");
    assert_eq!(r.replaced, 1);
    assert_eq!(fs::read_to_string(&target).expect("read"), "a\nb\nc\n");
}

#[test]
fn handover_hardlink_falls_back_to_copy() {
    let (_root, from, to) = setup();
    let source = from.join("session.jsonl");
    fs::write(&source, "same filesystem").expect("write source");
    let target = to.join("session.jsonl");
    let report = apply(
        &[transfer(&source, &target, TransferMode::HardLink)],
        &from,
        &to,
    )
    .expect("hard link within one filesystem");
    assert_eq!(report.applied, 1);
    assert_eq!(
        fs::read_to_string(&target).expect("read"),
        "same filesystem",
        "content must be identical (copy fallback or link)"
    );
    let nlink = std::os::unix::fs::MetadataExt::nlink(&fs::metadata(&target).expect("metadata"));
    assert!(
        nlink == 2 || report.copied_after_link_failure == 1,
        "either a verified hard link (nlink == 2) or an explicit copy fallback"
    );
}

#[test]
fn handover_missing_source_is_skipped() {
    let (_root, from, to) = setup();
    let report = apply(
        &[transfer(
            &from.join("gone.jsonl"),
            &to.join("gone.jsonl"),
            TransferMode::Copy,
        )],
        &from,
        &to,
    )
    .expect("a missing source is nothing to hand over");
    assert_eq!(report.skipped, 1);
    assert_eq!(report.applied, 0);
}
