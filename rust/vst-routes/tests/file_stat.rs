//! `file_stat::stat_in_root`: in-root metadata, confined and never reading
//! past the root (A4.T1).

use std::path::PathBuf;

use vst_routes::file_stat::{stat_in_root, StatError};
use vst_types::rest::worktrees::FileStatKind;

fn canonical_root() -> (tempfile::TempDir, PathBuf) {
    let d = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(d.path()).unwrap();
    (d, root)
}

#[tokio::test]
async fn in_root_file_reports_kind_size_canonical_path_and_lines() {
    let (_d, root) = canonical_root();
    std::fs::write(root.join("a.txt"), "a\nb\n").unwrap();
    let stat = stat_in_root(&root, "a.txt", Some(root.join("a.txt")))
        .await
        .expect("stat");
    assert_eq!(stat.kind, FileStatKind::File);
    assert_eq!(stat.size, Some(4));
    assert_eq!(
        stat.absolute_path.as_deref(),
        Some(root.join("a.txt").to_string_lossy().as_ref())
    );
    assert_eq!(stat.line_count, Some(2));
    assert!(stat.modified_ms.is_some_and(|ms| ms > 0));
    assert!(stat.in_root);
    assert_eq!(stat.path, "a.txt");
}

#[tokio::test]
async fn final_line_without_newline_still_counts() {
    let (_d, root) = canonical_root();
    std::fs::write(root.join("b.txt"), "a\nb").unwrap();
    let stat = stat_in_root(&root, "b.txt", Some(root.join("b.txt")))
        .await
        .expect("stat");
    assert_eq!(stat.line_count, Some(2));
}

#[tokio::test]
async fn in_root_directory_has_no_size_or_lines() {
    let (_d, root) = canonical_root();
    std::fs::create_dir(root.join("sub")).unwrap();
    let stat = stat_in_root(&root, "sub", Some(root.join("sub")))
        .await
        .expect("stat");
    assert_eq!(stat.kind, FileStatKind::Dir);
    assert_eq!(stat.size, None);
    assert_eq!(stat.line_count, None);
}

#[tokio::test]
async fn missing_in_root_path_is_not_found() {
    let (_d, root) = canonical_root();
    let err = stat_in_root(&root, "nope.txt", Some(root.join("nope.txt")))
        .await
        .unwrap_err();
    assert!(matches!(err, StatError::NotFound(_)), "{err:?}");
}

#[tokio::test]
async fn symlink_inside_root_pointing_outside_is_denied() {
    let (_d, root) = canonical_root();
    let outside = tempfile::tempdir().unwrap();
    let target = std::fs::canonicalize(outside.path())
        .unwrap()
        .join("secret.txt");
    std::fs::write(&target, "x").unwrap();
    std::os::unix::fs::symlink(&target, root.join("link.txt")).unwrap();
    let err = stat_in_root(&root, "link.txt", Some(root.join("link.txt")))
        .await
        .unwrap_err();
    assert!(matches!(err, StatError::Denied(_)), "{err:?}");
}

#[tokio::test]
async fn absolute_path_without_a_lexical_inside_form_is_denied() {
    let (_d, root) = canonical_root();
    let err = stat_in_root(&root, "/etc/hosts", None).await.unwrap_err();
    assert!(matches!(err, StatError::Denied(_)), "{err:?}");
}

#[tokio::test]
async fn nul_byte_in_the_probe_means_no_line_count() {
    let (_d, root) = canonical_root();
    std::fs::write(root.join("bin.dat"), [b'a', 0u8, b'b', b'\n']).unwrap();
    let stat = stat_in_root(&root, "bin.dat", Some(root.join("bin.dat")))
        .await
        .expect("stat");
    assert_eq!(stat.kind, FileStatKind::File);
    assert_eq!(stat.line_count, None);
}
