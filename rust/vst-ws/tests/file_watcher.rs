//! Behavior contract for `vst-ws::streams::file_watcher`'s tree mode.
//!
//! The tree watch registers a NON-recursive watch per directory and prunes
//! ignored subtrees (instead of `notify`'s unprunable `RecursiveMode::
//! Recursive`, which `add_watch`ed every directory under the root — tens of
//! thousands on a real checkout). These tests pin the two behaviours that
//! change could plausibly break: an existing nested directory is still
//! reported, and a directory created AFTER registration is picked up (which
//! recursive mode used to handle for us).

use std::fs;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tempfile::TempDir;

use vst_ws::streams::file_watcher::{FileWatcher, WatcherCallbacks};

/// Collects `on_changed` / `on_deleted` paths.
fn recording_callbacks() -> (WatcherCallbacks, Arc<Mutex<Vec<String>>>) {
    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let changed = {
        let seen = seen.clone();
        Arc::new(move |p: String| seen.lock().unwrap().push(p))
    };
    let deleted = {
        let seen = seen.clone();
        Arc::new(move |p: String| seen.lock().unwrap().push(p))
    };
    (
        WatcherCallbacks {
            on_changed: changed,
            on_deleted: deleted,
            on_error: Arc::new(|_| {}),
        },
        seen,
    )
}

/// Poll for up to ~4s for any recorded path containing `needle`.
async fn saw(seen: &Arc<Mutex<Vec<String>>>, needle: &str) -> bool {
    for _ in 0..40 {
        if seen.lock().unwrap().iter().any(|p| p.contains(needle)) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

#[tokio::test]
async fn reports_changes_in_a_nested_directory_and_skips_ignored_subtrees() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().to_path_buf();
    fs::write(root.join(".gitignore"), "ignored_dir/\n").unwrap();
    fs::create_dir_all(root.join("src/deep")).unwrap();
    fs::create_dir_all(root.join("ignored_dir")).unwrap();

    let (callbacks, seen) = recording_callbacks();
    let watcher = FileWatcher::new(callbacks, root.clone());
    watcher.spawn(root.to_str().unwrap()).expect("spawn watch");

    fs::write(root.join("src/deep/touched.txt"), "hi").unwrap();
    assert!(
        saw(&seen, "touched.txt").await,
        "a change in a pre-existing nested directory must still be reported"
    );

    seen.lock().unwrap().clear();
    fs::write(root.join("ignored_dir/hidden.txt"), "nope").unwrap();
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(
        !seen
            .lock()
            .unwrap()
            .iter()
            .any(|p| p.contains("hidden.txt")),
        "a gitignored subtree must not produce events: {:?}",
        seen.lock().unwrap()
    );
}

#[tokio::test]
async fn picks_up_directories_created_after_registration() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().to_path_buf();

    let (callbacks, seen) = recording_callbacks();
    // Registered exactly the way `handlers::tree_watch` does it: on a blocking
    // thread, awaited. (`spawn()` itself calls `tokio::spawn` for its event
    // loop, which has to keep working from inside `spawn_blocking`.)
    let watcher = Arc::new(FileWatcher::new(callbacks, root.clone()));
    {
        let watcher = watcher.clone();
        let path = root.to_string_lossy().into_owned();
        tokio::task::spawn_blocking(move || watcher.spawn(&path))
            .await
            .expect("join")
            .expect("spawn watch");
    }

    // Recursive mode watched new directories automatically; the hand-rolled
    // walk has to notice the create event and register the new directory.
    fs::create_dir_all(root.join("late/deeper")).unwrap();
    assert!(saw(&seen, "late").await, "the new directory itself");
    seen.lock().unwrap().clear();

    fs::write(root.join("late/deeper/after.txt"), "x").unwrap();
    assert!(
        saw(&seen, "after.txt").await,
        "a change inside a directory created after registration must be reported"
    );
}
