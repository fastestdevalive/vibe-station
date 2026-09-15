//! `file:watch` / `file:unwatch` handlers — refcounted file watchers
//! (Decision 8).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use vst_types::ws::{ClientMessage, ServerMessage};

use crate::connection::WsConnection;
use crate::streams::file_watcher::{FileWatcher, WatcherCallbacks, WatcherHandle};

/// Resolves a worktree id to its absolute root path.
pub type WorktreePathResolver = Arc<dyn Fn(&str) -> Option<PathBuf> + Send + Sync>;

/// Registry of live watchers keyed by watch key (owned by the server).
pub type WatcherRegistry = Arc<Mutex<HashMap<String, Arc<FileWatcher>>>>;

/// Handle `file:watch`: start watching a file for changes (refcounted).
pub fn handle_file_watch(
    conn: &WsConnection,
    registry: &WatcherRegistry,
    resolve_root: &WorktreePathResolver,
    msg: &ClientMessage,
) {
    let ClientMessage::FileWatch { worktree_id, path } = msg else {
        return;
    };
    let watch_key = format!("file:{worktree_id}:{path}");

    // If another consumer already watches this key, just add a reference.
    if conn.retain_file_watcher(&watch_key) {
        return;
    }

    let Some(root) = resolve_root(worktree_id) else {
        conn.send(ServerMessage::SystemError {
            message: format!("Worktree '{worktree_id}' not found"),
        });
        return;
    };
    let abs_path = root.join(path);

    let callbacks = {
        let c = conn.clone();
        let wt = worktree_id.clone();
        let p = path.clone();
        let on_changed = {
            let c = c.clone();
            let wt = wt.clone();
            let p = p.clone();
            Arc::new(move |_| {
                c.send(ServerMessage::FileChanged {
                    worktree_id: wt.clone(),
                    path: p.clone(),
                });
            })
        };
        let on_deleted = {
            let c = c.clone();
            let wt = wt.clone();
            let p = p.clone();
            Arc::new(move |_| {
                c.send(ServerMessage::FileDeleted {
                    worktree_id: wt.clone(),
                    path: p.clone(),
                });
            })
        };
        let on_error = {
            let c = c.clone();
            let p = p.clone();
            Arc::new(move |msg| {
                c.send(ServerMessage::SystemError {
                    message: format!("File watcher error for {p}: {msg}"),
                });
            })
        };
        WatcherCallbacks {
            on_changed,
            on_deleted,
            on_error,
        }
    };

    let watcher = Arc::new(FileWatcher::new(callbacks, root.clone()));
    // Register before starting so a follow-up consumer retains the entry.
    conn.register_file_watcher(&watch_key, watch_key.clone());
    registry
        .lock()
        .unwrap()
        .insert(watch_key.clone(), watcher.clone());

    if let Err(e) = watcher.watch_file(abs_path.to_str().unwrap_or("")) {
        conn.send(ServerMessage::SystemError {
            message: format!("Failed to watch file {path}: {e}"),
        });
        // Force-teardown: unregister the failed entry.
        conn.unregister_file_watcher(&watch_key);
        registry.lock().unwrap().remove(&watch_key);
    }
}

/// Handle `file:unwatch`: release one consumer's reference; close the watcher
/// only when the refcount hits 0.
pub async fn handle_file_unwatch(
    conn: &WsConnection,
    registry: &WatcherRegistry,
    msg: &ClientMessage,
) {
    let ClientMessage::FileUnwatch { worktree_id, path } = msg else {
        return;
    };
    let watch_key = format!("file:{worktree_id}:{path}");
    if let Some(_released) = conn.release_file_watcher(&watch_key) {
        if let Some(watcher) = registry.lock().unwrap().remove(&watch_key) {
            watcher.close();
        }
    }
}
