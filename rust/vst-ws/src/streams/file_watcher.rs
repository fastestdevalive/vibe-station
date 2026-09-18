//! `FileWatcher` — wraps `notify` to watch files/trees with gitignore
//! filtering and debouncing.
//!
//! Ports `daemon/src/ws/streams/fileWatcher.ts`. Emits `file:changed` and
//! `file:deleted` after a 200ms debounce.
//!
//! Two modes:
//! - [`FileWatcher::spawn`]: watch of a directory tree (tree:watch).
//! - [`FileWatcher::watch_file`]: watch a single file by watching its PARENT
//!   directory (depth-0) and filtering to the exact path. A direct single-file
//!   watch loses the inode on an atomic rename-replace save; the parent-dir
//!   watch survives it.
//!
//! ## Why the tree watch is walked by hand instead of `RecursiveMode::Recursive`
//!
//! `notify`'s recursive mode `add_watch`es EVERY directory under the root, with
//! no way to prune — and the ignore matcher only ever filtered *emitted
//! events*. On a real checkout (`target/`, `node_modules/`, …) that is tens of
//! thousands of inotify watches registered in one synchronous burst: seconds of
//! stall on the caller's task plus a standing risk of hitting
//! `max_user_watches`. [`FileWatcher::spawn`] therefore walks the tree itself,
//! adding a NON-recursive watch per directory and skipping any subtree the
//! existing ignore matcher already excludes (`.git`/`node_modules` always, plus
//! whatever the worktree's nested `.gitignore`s exclude — e.g. `target`,
//! `dist`). The walk uses the SAME matcher instance that then filters events,
//! which also fixes rebuilding it (and re-reading every `.gitignore`) once per
//! filesystem event.
//!
//! The one thing recursive mode gave us for free was picking up directories
//! created *after* registration; the event loop reproduces that by walking (and
//! watching) any newly-created, non-ignored directory it sees.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{RecursiveMode, Watcher as NotifyWatcher};

use crate::services::ignore_filter::{build_ignore_matcher, IgnoreMatcher};

/// How a watcher reports events to its owner.
#[derive(Clone)]
pub struct WatcherCallbacks {
    pub on_changed: Arc<dyn Fn(String) + Send + Sync>,
    pub on_deleted: Arc<dyn Fn(String) + Send + Sync>,
    pub on_error: Arc<dyn Fn(String) + Send + Sync>,
}

impl Default for WatcherCallbacks {
    fn default() -> Self {
        let noop = |_: String| {};
        WatcherCallbacks {
            on_changed: Arc::new(noop),
            on_deleted: Arc::new(noop),
            on_error: Arc::new(noop),
        }
    }
}

impl std::fmt::Debug for WatcherCallbacks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WatcherCallbacks")
    }
}

/// A watcher handle that can be closed.
pub trait WatcherHandle: Send + Sync {
    fn close(&self);
}

/// Add a NON-recursive watch for `root` and every non-ignored directory beneath
/// it, skipping ignored subtrees entirely (never descending into them).
///
/// `root_is_fatal` controls the root's own failure: `true` for the initial
/// registration (the caller must learn the watch could not be established, as
/// `RecursiveMode::Recursive` used to report), `false` when picking up a
/// directory that appeared later (best-effort; it may already be gone again).
/// Failures on individual sub-directories are always best-effort — a vanished
/// directory mid-walk, or a per-subtree `add_watch` failure, must not abandon
/// the rest of the tree.
///
/// Symlinked directories are not followed (`file_type()` is not followed
/// either), which matches `notify`'s own recursive walk and avoids cycles.
fn watch_tree_pruned(
    watcher: &mut notify::RecommendedWatcher,
    root: &Path,
    matcher: &mut IgnoreMatcher,
    root_is_fatal: bool,
) -> Result<(), notify::Error> {
    match watcher.watch(root, RecursiveMode::NonRecursive) {
        Ok(()) => {}
        Err(e) if root_is_fatal => return Err(e),
        Err(_) => return Ok(()),
    }

    let mut stack: Vec<std::path::PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue; // unreadable or removed mid-walk — skip, keep going
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let path = entry.path();
            if matcher.ignores(&path.to_string_lossy(), true) {
                continue; // whole subtree pruned — no watch, no descent
            }
            if watcher.watch(&path, RecursiveMode::NonRecursive).is_ok() {
                stack.push(path);
            }
        }
    }
    Ok(())
}

struct Inner {
    callbacks: WatcherCallbacks,
    worktree_root: std::path::PathBuf,
    debounce_ms: AtomicU64,
    closed: AtomicBool,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    pending: Mutex<HashMap<String, tokio::task::AbortHandle>>,
}

/// A file/tree watcher backed by `notify`.
pub struct FileWatcher {
    inner: Arc<Inner>,
}

/// Schedule (or reschedule) a debounced callback for the given path.
///
/// The insert into `pending` happens synchronously on the CALLING task, so it
/// can never race the timer task's own removal — this closes the leak window
/// that a naive "insert via a second `tokio::spawn`" would have.
fn schedule_debounced(inner: &Arc<Inner>, abs: String, deleted: bool) {
    let inner2 = Arc::clone(inner);
    let key = abs.clone();
    let cb_path = abs.clone();
    let debounce_ms = inner.debounce_ms.load(Ordering::SeqCst);
    let handle = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(debounce_ms)).await;
        inner2.pending.lock().unwrap().remove(&key);
        if deleted {
            (inner2.callbacks.on_deleted)(cb_path);
        } else {
            (inner2.callbacks.on_changed)(cb_path);
        }
    });
    // Synchronous insert on the CALLING task — this must happen before
    // returning, so it can never race the timer task's own removal above.
    if let Some(old) = inner.pending.lock().unwrap().insert(abs, handle.abort_handle()) {
        old.abort(); // a still-pending timer for this same path — superseded, not fired
    }
}

impl FileWatcher {
    /// Create a watcher with the given callbacks.
    pub fn new(callbacks: WatcherCallbacks, worktree_root: std::path::PathBuf) -> Self {
        FileWatcher {
            inner: Arc::new(Inner {
                callbacks,
                worktree_root,
                debounce_ms: AtomicU64::new(200),
                closed: AtomicBool::new(false),
                watcher: Mutex::new(None),
                pending: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Override the debounce interval (milliseconds). Test-only — avoids
    /// sleeping the full 200ms in unit tests.
    pub fn set_debounce_ms_for_test(&self, ms: u64) {
        self.inner.debounce_ms.store(ms, Ordering::SeqCst);
    }

    /// Start a watch of a directory tree (tree:watch mode).
    ///
    /// Registration is synchronous and does real filesystem work (a pruned walk
    /// + one inotify watch per directory), so callers on an async task MUST run
    /// it under `tokio::task::spawn_blocking` (see `handlers::tree_watch`).
    pub fn spawn(&self, abs_path: &str) -> Result<(), notify::Error> {
        let me = Arc::clone(&self.inner);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(std::path::PathBuf, bool)>();
        let mut watcher =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                if let Ok(ev) = res {
                    let deleted = matches!(ev.kind, notify::EventKind::Remove(_));
                    for p in ev.paths {
                        let _ = tx.send((p, deleted));
                    }
                }
            })?;
        // Built ONCE here and then moved into the event loop below: it is both
        // the walk's pruning rule and the event filter, and rebuilding it
        // per-event re-read every `.gitignore` on the path.
        let mut matcher = build_ignore_matcher(me.worktree_root.clone());
        watch_tree_pruned(&mut watcher, Path::new(abs_path), &mut matcher, true)?;
        *self.inner.watcher.lock().unwrap() = Some(watcher);

        tokio::spawn(async move {
            while let Some((path, deleted)) = rx.recv().await {
                let abs = path.to_string_lossy().into_owned();
                let is_dir = path.is_dir();
                if matcher.ignores(&abs, is_dir) {
                    continue;
                }
                // A directory that just appeared has no watch of its own (we
                // are not in `RecursiveMode::Recursive`) — register it and its
                // contents so changes underneath it are still reported.
                if !deleted && is_dir {
                    if let Some(w) = me.watcher.lock().unwrap().as_mut() {
                        let _ = watch_tree_pruned(w, &path, &mut matcher, false);
                    }
                }
                schedule_debounced(&me, abs, deleted);
            }
        });
        Ok(())
    }

    /// Watch a single file by watching its parent directory (depth-0) and
    /// filtering to the exact path. Survives atomic rename-replace saves.
    pub fn watch_file(&self, abs_path: &str) -> Result<(), notify::Error> {
        let target = Path::new(abs_path);
        let parent = target
            .parent()
            .ok_or_else(|| notify::Error::generic("no parent dir"))?;
        let target_str = abs_path.to_string();
        let me = Arc::clone(&self.inner);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(std::path::PathBuf, bool)>();
        let mut watcher =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                if let Ok(ev) = res {
                    let deleted = matches!(ev.kind, notify::EventKind::Remove(_));
                    for p in ev.paths {
                        let _ = tx.send((p, deleted));
                    }
                }
            })?;
        watcher.watch(parent, RecursiveMode::NonRecursive)?;
        *self.inner.watcher.lock().unwrap() = Some(watcher);

        tokio::spawn(async move {
            while let Some((path, deleted)) = rx.recv().await {
                if path.to_string_lossy() != target_str {
                    continue; // only the exact watched file
                }
                let abs = path.to_string_lossy().into_owned();
                schedule_debounced(&me, abs, deleted);
            }
        });
        Ok(())
    }
}

impl WatcherHandle for FileWatcher {
    fn close(&self) {
        self.inner.closed.store(true, Ordering::SeqCst);
        // Abort every pending debounce timer so no callback fires after close.
        for (_, h) in self.inner.pending.lock().unwrap().drain() {
            h.abort();
        }
        // Drop the notify watcher (releases inotify handles).
        *self.inner.watcher.lock().unwrap() = None;
    }
}

impl std::fmt::Debug for FileWatcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileWatcher")
            .field("worktree_root", &self.inner.worktree_root)
            .field(
                "debounce_ms",
                &self.inner.debounce_ms.load(Ordering::SeqCst),
            )
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    /// 1.T1 — Send 5 rapid events for the same path within the debounce
    /// window; assert `on_changed` fires exactly once.
    #[tokio::test]
    async fn coalesces_rapid_events_for_same_path() {
        let changed_count = Arc::new(AtomicUsize::new(0));
        let cc = Arc::clone(&changed_count);

        let callbacks = WatcherCallbacks {
            on_changed: Arc::new(move |_path: String| {
                cc.fetch_add(1, Ordering::SeqCst);
            }),
            on_deleted: Arc::new(|_: String| {}),
            on_error: Arc::new(|_: String| {}),
        };
        let watcher = FileWatcher::new(callbacks, std::path::PathBuf::from("/tmp/fake"));
        watcher.set_debounce_ms_for_test(20);

        // Simulate 5 rapid events for the same path.
        for _ in 0..5 {
            schedule_debounced(&watcher.inner, "/tmp/fake/file.txt".to_string(), false);
        }

        // Wait long enough for the debounce to fire (20ms + margin).
        tokio::time::sleep(Duration::from_millis(80)).await;

        assert_eq!(
            changed_count.load(Ordering::SeqCst),
            1,
            "on_changed should fire exactly once for 5 rapid events on the same path"
        );
    }

    /// 1.T2 — Two different paths debounce independently: an event on path A
    /// does not delay or cancel path B's timer.
    #[tokio::test]
    async fn independent_debounce_per_path() {
        let changed_paths = Arc::new(Mutex::new(Vec::<String>::new()));
        let cp = Arc::clone(&changed_paths);

        let callbacks = WatcherCallbacks {
            on_changed: Arc::new(move |path: String| {
                cp.lock().unwrap().push(path);
            }),
            on_deleted: Arc::new(|_: String| {}),
            on_error: Arc::new(|_: String| {}),
        };
        let watcher = FileWatcher::new(callbacks, std::path::PathBuf::from("/tmp/fake"));
        watcher.set_debounce_ms_for_test(20);

        // Fire events for two different paths.
        schedule_debounced(&watcher.inner, "/tmp/fake/a.txt".to_string(), false);
        schedule_debounced(&watcher.inner, "/tmp/fake/b.txt".to_string(), false);

        // Wait for both debounce timers to fire.
        tokio::time::sleep(Duration::from_millis(80)).await;

        let mut paths = changed_paths.lock().unwrap().clone();
        paths.sort();
        assert_eq!(
            paths,
            vec!["/tmp/fake/a.txt", "/tmp/fake/b.txt"],
            "both paths should fire independently"
        );
    }

    /// 1.T3 — A single event fires exactly one `on_changed` callback after
    /// ~debounce_ms, with the correct absolute path.
    #[tokio::test]
    async fn single_event_fires_once_with_correct_path() {
        let received_path = Arc::new(Mutex::new(None::<String>));
        let rp = Arc::clone(&received_path);
        let call_count = Arc::new(AtomicUsize::new(0));
        let cc = Arc::clone(&call_count);

        let callbacks = WatcherCallbacks {
            on_changed: Arc::new(move |path: String| {
                cc.fetch_add(1, Ordering::SeqCst);
                *rp.lock().unwrap() = Some(path);
            }),
            on_deleted: Arc::new(|_: String| {}),
            on_error: Arc::new(|_: String| {}),
        };
        let watcher = FileWatcher::new(callbacks, std::path::PathBuf::from("/tmp/fake"));
        watcher.set_debounce_ms_for_test(20);

        let expected = "/tmp/fake/single.txt".to_string();
        schedule_debounced(&watcher.inner, expected.clone(), false);

        // Wait for the debounce to fire.
        tokio::time::sleep(Duration::from_millis(80)).await;

        assert_eq!(call_count.load(Ordering::SeqCst), 1, "should fire exactly once");
        assert_eq!(
            received_path.lock().unwrap().as_deref(),
            Some("/tmp/fake/single.txt"),
            "callback should receive the correct absolute path"
        );
    }
}
