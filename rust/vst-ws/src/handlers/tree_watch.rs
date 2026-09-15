//! `tree:watch` / `tree:unwatch` handlers — refcounted tree watchers
//! (Decision 8).

use std::path::PathBuf;
use std::sync::Arc;

use vst_types::ws::{ClientMessage, ServerMessage, TreeChangeKind};

use crate::connection::WsConnection;
use crate::streams::file_watcher::{FileWatcher, WatcherCallbacks, WatcherHandle};

use super::file_watch::{WatcherRegistry, WorktreePathResolver};

/// Handle `tree:watch`: start watching a directory tree for changes.
pub fn handle_tree_watch(
    conn: &WsConnection,
    registry: &WatcherRegistry,
    resolve_root: &WorktreePathResolver,
    msg: &ClientMessage,
) {
    let ClientMessage::TreeWatch { worktree_id, path } = msg else {
        return;
    };
    let tree_path = path.clone().unwrap_or_default();
    let watch_key = format!("tree:{worktree_id}:{tree_path}");

    if conn.retain_tree_watcher(&watch_key) {
        return;
    }

    let Some(root) = resolve_root(worktree_id) else {
        conn.send(ServerMessage::SystemError {
            message: format!("Worktree '{worktree_id}' not found"),
        });
        return;
    };
    let abs_path: PathBuf = if tree_path.is_empty() {
        root.clone()
    } else {
        root.join(&tree_path)
    };

    let callbacks = {
        let on_changed = {
            let c = conn.clone();
            let wt = worktree_id.clone();
            let tp = tree_path.clone();
            Arc::new(move |_| {
                c.send(ServerMessage::TreeChanged {
                    worktree_id: wt.clone(),
                    path: tp.clone(),
                    kind: TreeChangeKind::Added,
                    from: None,
                    to: None,
                });
            })
        };
        let on_deleted = {
            let c = conn.clone();
            let wt = worktree_id.clone();
            let tp = tree_path.clone();
            Arc::new(move |_| {
                c.send(ServerMessage::TreeChanged {
                    worktree_id: wt.clone(),
                    path: tp.clone(),
                    kind: TreeChangeKind::Deleted,
                    from: None,
                    to: None,
                });
            })
        };
        let on_error = {
            let c = conn.clone();
            let tp = tree_path.clone();
            Arc::new(move |msg| {
                let label = if tp.is_empty() {
                    "root".to_string()
                } else {
                    tp.clone()
                };
                c.send(ServerMessage::SystemError {
                    message: format!("Tree watcher error for {label}: {msg}"),
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
    conn.register_tree_watcher(&watch_key, watch_key.clone());
    registry
        .lock()
        .unwrap()
        .insert(watch_key.clone(), watcher.clone());

    if let Err(e) = watcher.spawn(abs_path.to_str().unwrap_or("")) {
        conn.send(ServerMessage::SystemError {
            message: format!(
                "Failed to watch tree at {}: {e}",
                if tree_path.is_empty() {
                    "root"
                } else {
                    &tree_path
                }
            ),
        });
        conn.unregister_tree_watcher(&watch_key);
        registry.lock().unwrap().remove(&watch_key);
    }
}

/// Handle `tree:unwatch`: release one consumer's reference.
pub async fn handle_tree_unwatch(
    conn: &WsConnection,
    registry: &WatcherRegistry,
    msg: &ClientMessage,
) {
    let ClientMessage::TreeUnwatch { worktree_id, path } = msg else {
        return;
    };
    let tree_path = path.clone().unwrap_or_default();
    let watch_key = format!("tree:{worktree_id}:{tree_path}");
    if let Some(_released) = conn.release_tree_watcher(&watch_key) {
        if let Some(watcher) = registry.lock().unwrap().remove(&watch_key) {
            watcher.close();
        }
    }
}
