//! `GET /fs/complete` prefix matching for the add-folder chooser (multi-account
//! plan A1a.8, Research R1): a typed prefix without a trailing slash, case-
//! insensitive matches, dot-folders sorted last, and the 50-entry cap applied
//! after sorting.

use tempfile::{tempdir, TempDir};
use vst_routes::fs::FsRoutes;

/// `<root>/code/{fastestdevalive,Fast,other,.hidden}`.
fn code_tree() -> TempDir {
    let root = tempdir().unwrap();
    for name in ["fastestdevalive", "Fast", "other", ".hidden"] {
        std::fs::create_dir_all(root.path().join("code").join(name)).unwrap();
    }
    root
}

/// `<root>/many/` with 60 plain folders and 5 dot-folders.
fn many_tree() -> TempDir {
    let root = tempdir().unwrap();
    let many = root.path().join("many");
    for i in 0..60 {
        std::fs::create_dir_all(many.join(format!("d{i:02}"))).unwrap();
    }
    for i in 0..5 {
        std::fs::create_dir_all(many.join(format!(".x{i}"))).unwrap();
    }
    root
}

/// The completed entry names and the `truncated` flag for `path`.
async fn complete(path: &str) -> (Vec<String>, bool) {
    let out = FsRoutes::new().complete(path).await.unwrap();
    let names = out.entries.into_iter().map(|e| e.name).collect();
    (names, out.truncated)
}

#[tokio::test]
async fn prefix_without_slash_lists_matches() {
    let root = code_tree();
    let (names, truncated) = complete(&format!("{}/code/faste", root.path().display())).await;
    assert_eq!(names, ["fastestdevalive"]);
    assert!(!truncated);
}

#[tokio::test]
async fn prefix_is_case_insensitive() {
    let root = code_tree();
    let (names, _) = complete(&format!("{}/code/FAS", root.path().display())).await;
    assert_eq!(names, ["Fast", "fastestdevalive"]);
}

#[tokio::test]
async fn trailing_slash_lists_children() {
    let root = code_tree();
    let (names, _) = complete(&format!("{}/code/", root.path().display())).await;
    // Plain folders first (case-insensitive), the dot-folder last.
    assert_eq!(names, ["Fast", "fastestdevalive", "other", ".hidden"]);
}

#[tokio::test]
async fn missing_dir_returns_empty_not_error() {
    let root = code_tree();
    let (names, truncated) = complete(&format!("{}/nope/x", root.path().display())).await;
    assert!(names.is_empty());
    assert!(!truncated);
}

#[tokio::test]
async fn cap_50_after_sort_sets_truncated() {
    let root = many_tree();
    let (names, truncated) = complete(&format!("{}/many/", root.path().display())).await;
    assert!(truncated, "60 plain folders exceed the cap");
    assert_eq!(names.len(), 50);
    let expected: Vec<String> = (0..50).map(|i| format!("d{i:02}")).collect();
    assert_eq!(names, expected, "the first 50 plain folders in name order");
}

#[tokio::test]
async fn dot_folders_sort_last_unless_dot_typed() {
    let root = many_tree();
    // No dot typed: the 5 dot-folders never take a place in the first 50.
    let (names, _) = complete(&format!("{}/many/", root.path().display())).await;
    assert!(names.iter().all(|n| !n.starts_with('.')), "{names:?}");
    // A dot typed: the dot-folders are the matches.
    let (dots, _) = complete(&format!("{}/many/.x", root.path().display())).await;
    assert_eq!(dots, [".x0", ".x1", ".x2", ".x3", ".x4"]);
}

#[tokio::test]
async fn single_dot_segment_lists_dot_folders() {
    let root = many_tree();
    // `<dir>/.` must list the dot-folders of `<dir>`, not the siblings of `<dir>`.
    let (names, _) = complete(&format!("{}/many/.", root.path().display())).await;
    assert_eq!(names, [".x0", ".x1", ".x2", ".x3", ".x4"]);
}
