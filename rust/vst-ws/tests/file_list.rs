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

// Phase 6 tests: parallel tree walk with ignore::WalkBuilder

#[tokio::test]
async fn phase6_t1_parallel_walk_respects_nested_gitignore_and_node_modules() {
    // 6.T1: Small fixture tree with .gitignore and node_modules
    let tmp = TempDir::new().unwrap();
    let fl = FileList::new();
    fl.set_ripgrep_available(Some(false));

    // Create fixture structure
    fs::write(tmp.path().join(".gitignore"), "*.ignored\n").unwrap();
    fs::write(tmp.path().join("keep.txt"), "keep").unwrap();
    fs::write(tmp.path().join("skip.ignored"), "skip").unwrap();

    // Create nested directory with .gitignore
    fs::create_dir_all(tmp.path().join("src")).unwrap();
    fs::write(tmp.path().join("src/.gitignore"), "local_skip\n").unwrap();
    fs::write(tmp.path().join("src/main.rs"), "main").unwrap();
    fs::write(tmp.path().join("src/local_skip"), "skip").unwrap();

    // Create node_modules (should be skipped)
    fs::create_dir_all(tmp.path().join("node_modules/pkg")).unwrap();
    fs::write(tmp.path().join("node_modules/pkg/index.js"), "skip").unwrap();

    let result = fl.list_files(tmp.path().to_path_buf()).await;

    assert_eq!(result.source, "node");
    assert!(!result.truncated);

    // Verify expected files are present
    assert!(result.files.contains(&".gitignore".to_string()));
    assert!(result.files.contains(&"keep.txt".to_string()));
    assert!(result.files.contains(&"src/.gitignore".to_string()));
    assert!(result.files.contains(&"src/main.rs".to_string()));

    // Verify unwanted files are excluded
    assert!(!result.files.contains(&"skip.ignored".to_string()));
    assert!(!result.files.contains(&"src/local_skip".to_string()));
    assert!(!result.files.iter().any(|f| f.starts_with("node_modules/")));

    // Verify output is sorted
    let mut sorted = result.files.clone();
    sorted.sort();
    assert_eq!(result.files, sorted, "Output must be sorted for determinism");
}

#[tokio::test]
async fn phase6_t2_parallel_walk_respects_max_entries_cap() {
    // 6.T2: Truncation test with custom max_entries
    let tmp = TempDir::new().unwrap();
    let fl = FileList::new();
    fl.set_ripgrep_available(Some(false));
    fl.set_max_entries_for_test(15);

    // Create more files than the cap
    for i in 0..25 {
        fs::write(tmp.path().join(format!("file_{:02}.txt", i)), "x").unwrap();
    }

    // Create some nested files
    fs::create_dir_all(tmp.path().join("subdir")).unwrap();
    for i in 0..10 {
        fs::write(tmp.path().join(format!("subdir/nested_{:02}.txt", i)), "x").unwrap();
    }

    let result = fl.list_files(tmp.path().to_path_buf()).await;

    assert_eq!(result.source, "node");
    assert!(result.truncated, "Should be truncated when exceeding cap");
    assert!(result.files.len() <= 15, "File count must not exceed cap");
    assert!(!result.files.is_empty(), "Should have collected some files before truncating");

    // Verify output is still sorted even when truncated
    let mut sorted = result.files.clone();
    sorted.sort();
    assert_eq!(result.files, sorted, "Output must remain sorted even when truncated");
}

#[tokio::test]
#[ignore]
async fn phase6_t3_parallel_walk_benchmark_large_tree() {
    // 6.T3: Benchmark with ~20k files
    let tmp = TempDir::new().unwrap();
    let fl = FileList::new();
    fl.set_ripgrep_available(Some(false));

    // Generate a synthetic tree with ~20k files nested in directories
    let num_files = 20_000;
    let files_per_dir = 100;
    let num_dirs = (num_files + files_per_dir - 1) / files_per_dir;

    for dir_idx in 0..num_dirs {
        let dir_path = tmp.path().join(format!("d{:03}", dir_idx));
        fs::create_dir_all(&dir_path).unwrap();

        for file_idx in 0..files_per_dir {
            let file_path = dir_path.join(format!("f{:03}.txt", file_idx));
            let _ = fs::write(file_path, "benchmark");
        }
    }

    let start = std::time::Instant::now();
    let result = fl.list_files(tmp.path().to_path_buf()).await;
    let elapsed = start.elapsed();

    println!("Phase 6 benchmark: parallel walk of ~{} files took {:?}", num_files, elapsed);

    assert_eq!(result.source, "node");
    assert!(!result.files.is_empty(), "Should have collected files");
    // Do not assert performance thresholds; this is informational only
}
