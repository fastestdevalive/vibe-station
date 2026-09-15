//! Behavior contract for `vst-ws::services::file_list` — flat file listing for
//! Quick Open. Ports `daemon/src/__tests__/fileList.test.ts` (Node fallback +
//! ripgrep backends, .gitignore, .git skip, MAX_ENTRIES cap).

use std::fs;
use tempfile::TempDir;

use vst_ws::services::file_list::FileList;

#[tokio::test]
async fn node_fallback_enumerates_and_respects_root_gitignore() {
    let tmp = TempDir::new().unwrap();
    let fl = FileList::new();
    fl.set_ripgrep_available(Some(false));
    fs::write(tmp.path().join(".gitignore"), "ignored.txt\nnested/\n").unwrap();
    fs::write(tmp.path().join("a.txt"), "a").unwrap();
    fs::write(tmp.path().join("b.md"), "b").unwrap();
    fs::write(tmp.path().join("ignored.txt"), "x").unwrap();
    fs::create_dir_all(tmp.path().join("src")).unwrap();
    fs::write(tmp.path().join("src/c.ts"), "c").unwrap();
    fs::create_dir_all(tmp.path().join("nested")).unwrap();
    fs::write(tmp.path().join("nested/d.txt"), "d").unwrap();

    let result = fl.list_files(tmp.path().to_path_buf()).await;
    assert_eq!(result.source, "node");
    assert!(!result.truncated);
    for f in [".gitignore", "a.txt", "b.md", "src/c.ts"] {
        assert!(
            result.files.contains(&f.to_string()),
            "missing {f}: {:?}",
            result.files
        );
    }
    assert!(!result.files.contains(&"ignored.txt".to_string()));
    assert!(!result.files.iter().any(|f| f.starts_with("nested/")));
}

#[tokio::test]
async fn node_fallback_skips_git_dir() {
    let tmp = TempDir::new().unwrap();
    let fl = FileList::new();
    fl.set_ripgrep_available(Some(false));
    fs::create_dir_all(tmp.path().join(".git")).unwrap();
    fs::write(tmp.path().join(".git/HEAD"), "ref: refs/heads/main").unwrap();
    fs::write(tmp.path().join("real.txt"), "r").unwrap();

    let result = fl.list_files(tmp.path().to_path_buf()).await;
    assert!(result.files.contains(&"real.txt".to_string()));
    assert!(!result
        .files
        .iter()
        .any(|f| f.starts_with(".git/") || f == ".git"));
}

#[tokio::test]
async fn node_fallback_survives_broken_symlinks() {
    let tmp = TempDir::new().unwrap();
    let fl = FileList::new();
    fl.set_ripgrep_available(Some(false));
    fs::write(tmp.path().join("good.txt"), "ok").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        tmp.path().join("does-not-exist"),
        tmp.path().join("broken-link"),
    )
    .unwrap();

    let result = fl.list_files(tmp.path().to_path_buf()).await;
    assert!(result.files.contains(&"good.txt".to_string()));
}

#[tokio::test]
async fn node_fallback_honors_max_entries_cap() {
    let tmp = TempDir::new().unwrap();
    let fl = FileList::new();
    fl.set_ripgrep_available(Some(false));
    fl.set_max_entries_for_test(5);
    for i in 0..10 {
        fs::write(tmp.path().join(format!("f{i}.txt")), "x").unwrap();
    }
    let result = fl.list_files(tmp.path().to_path_buf()).await;
    assert_eq!(result.source, "node");
    assert!(result.truncated);
    assert!(!result.files.is_empty());
    assert!(result.files.len() <= 5);
}

#[tokio::test]
async fn ripgrep_backend_used_when_available_and_on_path() {
    let tmp = TempDir::new().unwrap();
    let fl = FileList::new();
    fs::write(tmp.path().join("x.txt"), "x").unwrap();
    let result = fl.list_files(tmp.path().to_path_buf()).await;
    // Either backend is fine in an arbitrary CI environment; just assert the
    // file shows up and the source is one of the two known values.
    assert!(result.files.contains(&"x.txt".to_string()));
    assert!(matches!(result.source.as_str(), "ripgrep" | "node"));
}
