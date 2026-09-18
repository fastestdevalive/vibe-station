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

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
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
    debounce_ms: u64,
    closed: AtomicBool,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

/// A file/tree watcher backed by `notify`.
pub struct FileWatcher {
    inner: Arc<Inner>,
}

impl FileWatcher {
    /// Create a watcher with the given callbacks.
    pub fn new(callbacks: WatcherCallbacks, worktree_root: std::path::PathBuf) -> Self {
        FileWatcher {
            inner: Arc::new(Inner {
                callbacks,
                worktree_root,
                debounce_ms: 200,
                closed: AtomicBool::new(false),
                watcher: Mutex::new(None),
            }),
        }
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
                let m = me.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(m.debounce_ms)).await;
                    if deleted {
                        (m.callbacks.on_deleted)(abs.clone());
                    } else {
                        (m.callbacks.on_changed)(abs);
                    }
                });
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
                let m = me.clone();
                let abs = path.to_string_lossy().into_owned();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(m.debounce_ms)).await;
                    if deleted {
                        (m.callbacks.on_deleted)(abs.clone());
                    } else {
                        (m.callbacks.on_changed)(abs);
                    }
                });
            }
        });
        Ok(())
    }
}

impl WatcherHandle for FileWatcher {
    fn close(&self) {
        self.inner.closed.store(true, Ordering::SeqCst);
        // Drop the notify watcher (releases inotify handles).
        *self.inner.watcher.lock().unwrap() = None;
    }
}

impl std::fmt::Debug for FileWatcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileWatcher")
            .field("worktree_root", &self.inner.worktree_root)
            .field("debounce_ms", &self.inner.debounce_ms)
            .finish()
    }
}
