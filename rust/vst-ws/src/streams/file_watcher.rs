//! `FileWatcher` — wraps `notify` to watch files/trees with gitignore
//! filtering and debouncing.
//!
//! Ports `daemon/src/ws/streams/fileWatcher.ts`. Emits `file:changed` and
//! `file:deleted` after a 200ms debounce.
//!
//! Two modes:
//! - [`FileWatcher::spawn`]: recursive watch of a directory tree (tree:watch).
//! - [`FileWatcher::watch_file`]: watch a single file by watching its PARENT
//!   directory (depth-0) and filtering to the exact path. A direct single-file
//!   watch loses the inode on an atomic rename-replace save; the parent-dir
//!   watch survives it.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{RecursiveMode, Watcher as NotifyWatcher};

use crate::services::ignore_filter::build_ignore_matcher;

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

    /// Start a recursive watch of a directory tree (tree:watch mode).
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
        watcher.watch(Path::new(abs_path), RecursiveMode::Recursive)?;
        *self.inner.watcher.lock().unwrap() = Some(watcher);

        tokio::spawn(async move {
            while let Some((path, deleted)) = rx.recv().await {
                let abs = path.to_string_lossy().into_owned();
                let mut matcher = build_ignore_matcher(me.worktree_root.clone());
                if matcher.ignores(&abs, path.is_dir()) {
                    continue;
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
