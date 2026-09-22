//! `tree:watch` / `tree:unwatch` handlers — refcounted tree watchers
//! (Decision 8).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use vst_types::ws::{ClientMessage, ServerMessage, TreeChangeKind};

use crate::connection::WsConnection;
use crate::services::file_search::FileSearchIndex;
use crate::streams::file_watcher::{FileWatcher, WatcherCallbacks, WatcherHandle};

use super::file_watch::{SharedWatcher, WatcherRegistry, WorktreePathResolver};

/// Apply a single observed filesystem change to the [`FileSearchIndex`].
///
/// `abs` is the absolute changed path delivered by the tree watcher; `root` is
/// the watched worktree root. Paths outside `root` are ignored. This is a plain
/// async fn with no `WsConnection`/`WatcherRegistry` dependency, so tests can
/// call it directly.
pub(crate) async fn apply_tree_change(
    file_search: &FileSearchIndex,
    worktree_id: &str,
    root: &Path,
    abs: &str,
    deleted: bool,
) {
    let abs_path = Path::new(abs);
    let Ok(rel) = abs_path.strip_prefix(root) else {
        return; // outside root — ignore
    };
    let rel_posix = crate::services::file_list::to_posix(&rel.to_string_lossy());

    if deleted {
        // merge_subtree alone covers both the file and directory case — its
        // exact-match + prefix-strip removes everything under rel_posix.
        // No separate remove() call — would be redundant (Decision 2).
        file_search
            .merge_subtree(worktree_id, &rel_posix, vec![])
            .await;
        return;
    }

    if abs_path.is_dir() {
        // Directory-materialized-with-contents gap: a directory that just
        // appeared has no per-file events for what's inside it yet — walk it
        // explicitly and merge the results under this prefix.
        let file_list = file_search.file_list_handle();
        let result = file_list.list_files(abs_path.to_path_buf()).await;
        let prefixed: Vec<String> = result
            .files
            .into_iter()
            .map(|f| format!("{rel_posix}/{f}"))
            .collect();
        file_search
            .merge_subtree(worktree_id, &rel_posix, prefixed)
            .await;
    } else {
        file_search.insert(worktree_id, &rel_posix).await;
    }
}

/// Handle `tree:watch`: start watching a directory tree for changes.
///
/// The watch registration itself (a pruned directory walk plus one inotify
/// watch per directory — see `streams::file_watcher`) is filesystem-bound
/// blocking work, so it runs on a blocking thread. It is still **awaited**: the
/// caller must learn whether the watch was established, and a failure has to
/// surface as the same `system:error` frame (and the same registry rollback) as
/// before.
pub async fn handle_tree_watch(
    conn: &WsConnection,
    registry: &WatcherRegistry,
    resolve_root: &WorktreePathResolver,
    file_search: &Arc<FileSearchIndex>,
    msg: &ClientMessage,
) {
    let ClientMessage::TreeWatch { worktree_id, path } = msg else {
        return;
    };
    let tree_path = path.clone().unwrap_or_default();
    let watch_key = format!("tree:{worktree_id}:{tree_path}");

    // Same connection sending the same watch twice (redundant) — bump its own
    // refcount and return; do not spawn or double-count globally.
    if conn.retain_tree_watcher(&watch_key) {
        return;
    }

    // Global shared dedup (fixes cause B). If another connection already holds
    // a live watcher for this key, just increment the shared count, register
    // THIS connection as a subscriber so it keeps receiving `TreeChanged` too
    // (the watcher's callbacks look subscribers up fresh per event — see
    // below — so joining here is enough, no new `FileWatcher`/inotify fd
    // needed). The authoritative refcount lives here in the shared registry,
    // NOT in the per-connection map (which only knows what THIS connection
    // holds).
    {
        let mut reg = registry.lock().unwrap();
        if let Some(sw) = reg.watchers.get_mut(&watch_key) {
            sw.ref_count += 1;
            sw.subscribers.insert(conn.id().to_string(), conn.clone());
            drop(reg);
            conn.register_tree_watcher(&watch_key, watch_key.clone());
            return;
        }
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
            let registry = Arc::clone(registry);
            let key = watch_key.clone();
            let wt = worktree_id.clone();
            let tp = tree_path.clone();
            let file_search = Arc::clone(file_search);
            let root = root.clone();
            Arc::new(move |abs: String| {
                for c in tree_watch_subscribers(&registry, &key) {
                    c.send(ServerMessage::TreeChanged {
                        worktree_id: wt.clone(),
                        path: tp.clone(),
                        kind: TreeChangeKind::Added,
                        from: None,
                        to: None,
                    });
                }
                let file_search = Arc::clone(&file_search);
                let wt = wt.clone();
                let root = root.clone();
                let abs = abs.clone();
                tokio::spawn(async move {
                    apply_tree_change(&file_search, &wt, &root, &abs, false).await;
                });
            })
        };
        let on_deleted = {
            let registry = Arc::clone(registry);
            let key = watch_key.clone();
            let wt = worktree_id.clone();
            let tp = tree_path.clone();
            let file_search = Arc::clone(file_search);
            let root = root.clone();
            Arc::new(move |abs: String| {
                for c in tree_watch_subscribers(&registry, &key) {
                    c.send(ServerMessage::TreeChanged {
                        worktree_id: wt.clone(),
                        path: tp.clone(),
                        kind: TreeChangeKind::Deleted,
                        from: None,
                        to: None,
                    });
                }
                let file_search = Arc::clone(&file_search);
                let wt = wt.clone();
                let root = root.clone();
                let abs = abs.clone();
                tokio::spawn(async move {
                    apply_tree_change(&file_search, &wt, &root, &abs, true).await;
                });
            })
        };
        let on_error = {
            let registry = Arc::clone(registry);
            let key = watch_key.clone();
            let tp = tree_path.clone();
            Arc::new(move |msg| {
                let label = if tp.is_empty() {
                    "root".to_string()
                } else {
                    tp.clone()
                };
                for c in tree_watch_subscribers(&registry, &key) {
                    c.send(ServerMessage::SystemError {
                        message: format!("Tree watcher error for {label}: {msg}"),
                    });
                }
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
    {
        let mut reg = registry.lock().unwrap();
        reg.watchers.insert(
            watch_key.clone(),
            SharedWatcher {
                watcher: watcher.clone(),
                ref_count: 1,
                subscribers: HashMap::from([(conn.id().to_string(), conn.clone())]),
            },
        );
        *reg.worktree_counts.entry(worktree_id.clone()).or_insert(0) += 1;
    }

    let spawn_result = {
        let watcher = watcher.clone();
        let path = abs_path.to_string_lossy().into_owned();
        match tokio::task::spawn_blocking(move || watcher.spawn(&path)).await {
            Ok(res) => res.map_err(|e| e.to_string()),
            Err(join_err) => Err(join_err.to_string()),
        }
    };

    if let Err(e) = spawn_result {
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
        // Roll back the registry insert and the per-worktree count.
        let mut reg = registry.lock().unwrap();
        reg.watchers.remove(&watch_key);
        if let Some(c) = reg.worktree_counts.get_mut(worktree_id) {
            *c = c.saturating_sub(1);
            if *c == 0 {
                reg.worktree_counts.remove(worktree_id);
            }
        }
    }
}

/// Handle `tree:unwatch`: release one consumer's reference.
pub async fn handle_tree_unwatch(
    conn: &WsConnection,
    registry: &WatcherRegistry,
    file_search: &Arc<FileSearchIndex>,
    msg: &ClientMessage,
) {
    let ClientMessage::TreeUnwatch { worktree_id, path } = msg else {
        return;
    };
    let tree_path = path.clone().unwrap_or_default();
    let watch_key = format!("tree:{worktree_id}:{tree_path}");
    if let Some(_released) = conn.release_tree_watcher(&watch_key) {
        release_shared_tree_watcher(registry, file_search, worktree_id, &watch_key, conn.id())
            .await;
    }
}

/// Release every tree watcher a closing connection was still holding.
///
/// Mirrors exactly what the explicit `tree:unwatch` path does, but iterates the
/// connection's full holdings. A page reload / crashed tab / lost socket never
/// sends `tree:unwatch`, so without this a dead connection's watchers would
/// leak forever (cause A).
///
/// `handle_tree_watch` only ever takes ONE global (shared-registry) ref per
/// connection per key — a second local subscriber on the same connection
/// (e.g. `FileTreeSidebar` and `FilePreviewPane` both watching the same
/// worktree) short-circuits at `conn.retain_tree_watcher` and never touches
/// the shared registry. So the release side must also drop exactly ONE global
/// ref per key here, regardless of how many local subscribers this connection
/// had — `conn.unregister_tree_watcher` clears the connection's entire local
/// hold on a key in one call (vs. `release_tree_watcher`, which only drops
/// one local unit and is what the graceful `tree:unwatch` path above uses,
/// one call per client message). Decrementing the shared count once per LOCAL
/// unit here (the previous approach) over-released whenever a connection had
/// more than one local subscriber: with two tabs on the same worktree, the
/// closing tab's second local unit would wrongly drop the OTHER tab's still-
/// live global ref, closing its watcher and evicting the index out from
/// under it.
pub async fn release_connection_tree_watches(
    conn: &WsConnection,
    registry: &WatcherRegistry,
    file_search: &Arc<FileSearchIndex>,
) {
    let keys = conn.tree_watch_keys();
    for key in keys {
        let worktree_id = worktree_id_from_watch_key(&key).to_string();
        conn.unregister_tree_watcher(&key);
        release_shared_tree_watcher(registry, file_search, &worktree_id, &key, conn.id()).await;
    }
}

/// The connections that should receive a `TreeChanged`/error push for
/// `watch_key` right now — looked up fresh from the shared registry on every
/// filesystem event, not snapshotted when the watcher was created, so every
/// connection currently sharing the watcher (via the dedup-join path in
/// `handle_tree_watch`) gets live updates, not just whichever connection
/// happened to spawn it.
fn tree_watch_subscribers(registry: &WatcherRegistry, watch_key: &str) -> Vec<WsConnection> {
    registry
        .lock()
        .unwrap()
        .watchers
        .get(watch_key)
        .map(|sw| sw.subscribers.values().cloned().collect())
        .unwrap_or_default()
}

/// Extract the `worktree_id` from a `tree:<worktree_id>:<tree_path>` watch key.
fn worktree_id_from_watch_key(watch_key: &str) -> &str {
    watch_key
        .strip_prefix("tree:")
        .and_then(|rest| rest.split_once(':'))
        .map(|(wt, _)| wt)
        .unwrap_or("")
}

/// Decrement the shared refcount for a watch key. When it returns to zero,
/// close the underlying `FileWatcher` (blocking teardown of its inotify
/// watches) and, if this was the LAST live watcher for the worktree across all
/// its `tree_path`s, evict the `FileSearchIndex` entry so the next query
/// re-derives it from disk (Phase 3).
async fn release_shared_tree_watcher(
    registry: &WatcherRegistry,
    file_search: &Arc<FileSearchIndex>,
    worktree_id: &str,
    watch_key: &str,
    conn_id: &str,
) {
    let (closed_watcher, evict) = {
        let mut reg = registry.lock().unwrap();
        match reg.watchers.get_mut(watch_key) {
            Some(sw) => {
                sw.ref_count = sw.ref_count.saturating_sub(1);
                sw.subscribers.remove(conn_id);
                if sw.ref_count > 0 {
                    (None, false)
                } else {
                    let removed = reg.watchers.remove(watch_key);
                    let mut evict = false;
                    if let Some(c) = reg.worktree_counts.get_mut(worktree_id) {
                        *c = c.saturating_sub(1);
                        if *c == 0 {
                            reg.worktree_counts.remove(worktree_id);
                            evict = true;
                        }
                    }
                    (removed.map(|sw| sw.watcher), evict)
                }
            }
            None => (None, false),
        }
    };

    if let Some(watcher) = closed_watcher {
        // Tearing down thousands of inotify watches is blocking work too (it
        // drops the `notify` watcher and joins its own thread), so keep it off
        // the calling task.
        let _ = tokio::task::spawn_blocking(move || watcher.close()).await;
    }
    if evict {
        file_search.evict(worktree_id).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    use crate::connection::{WsConnection, WsSinkHandle};
    use crate::handlers::file_watch::{WatcherRegistry, WatcherRegistryInner, WorktreePathResolver};
    use crate::services::file_list::FileList;
    use crate::streams::file_watcher::WatcherHandle;
    use std::sync::Mutex;

    fn index() -> Arc<FileSearchIndex> {
        Arc::new(FileSearchIndex::new(Arc::new(FileList::new())))
    }

    // Lazily populate `worktree_id` from `root` on disk (public API) so the
    // index has an entry for it before `apply_tree_change`'s insert/merge
    // calls, which are no-ops on an unpopulated worktree.
    async fn populate(idx: &FileSearchIndex, worktree_id: &str, root: &Path) {
        idx.search(worktree_id, root, "", usize::MAX).await;
    }

    #[tokio::test]
    async fn apply_tree_change_single_file_inserts() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("existing.rs"), "x").unwrap();
        let idx = index();
        populate(&idx, "wt1", root.path()).await;

        fs::write(root.path().join("newfile.rs"), "y").unwrap();
        let abs = root.path().join("newfile.rs");
        apply_tree_change(&idx, "wt1", root.path(), &abs.to_string_lossy(), false).await;

        let res = idx
            .search("wt1", root.path(), "newfile", 100)
            .await;
        assert_eq!(res.files, vec!["newfile.rs".to_string()]);
    }

    #[tokio::test]
    async fn apply_tree_change_directory_merges_its_files() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("dir");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("a.rs"), "a").unwrap();
        fs::write(dir.join("sub/b.rs"), "b").unwrap();
        let idx = index();
        populate(&idx, "wt1", root.path()).await;

        apply_tree_change(&idx, "wt1", root.path(), &dir.to_string_lossy(), false).await;

        let res = idx.search("wt1", root.path(), "", 100).await;
        assert!(res.files.contains(&"dir/a.rs".to_string()));
        assert!(res.files.contains(&"dir/sub/b.rs".to_string()));
    }

    #[tokio::test]
    async fn apply_tree_change_deleted_removes_exact_and_nested() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("dir");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("x.rs"), "x").unwrap();
        fs::write(dir.join("sub/y.rs"), "y").unwrap();
        fs::write(root.path().join("keep.rs"), "k").unwrap();
        let idx = index();
        populate(&idx, "wt1", root.path()).await;

        apply_tree_change(&idx, "wt1", root.path(), &dir.to_string_lossy(), true).await;

        let res = idx.search("wt1", root.path(), "", 100).await;
        assert!(!res.files.contains(&"dir".to_string()));
        assert!(!res.files.contains(&"dir/x.rs".to_string()));
        assert!(!res.files.contains(&"dir/sub/y.rs".to_string()));
        assert!(res.files.contains(&"keep.rs".to_string()));
    }

    // Phase 0 — regression test proving the tree-watcher leak (cause B).
    //
    // Two SEPARATE connections watch the SAME worktree root. The registry must
    // end up with a SINGLE shared `Arc<FileWatcher>` for the key: the second
    // connection reuses the first's watcher instead of spawning a brand-new one
    // that overwrites the registry slot and leaks the first's background task
    // (which keeps an inotify fd alive forever with no reachable handle to close
    // it — the `/proc/<pid>/fdinfo` 9-fd symptom in the plan).
    //
    // Against the pre-fix code the second `handle_tree_watch` spawns a fresh
    // `FileWatcher` and overwrites the registry entry, so the two reads observe
    // DIFFERENT `Arc`s and this assertion fails.
    #[tokio::test]
    async fn two_connections_watching_same_tree_share_one_watcher() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("existing.rs"), "x").unwrap();
        let file_search = index();
        let registry: WatcherRegistry = Arc::new(Mutex::new(WatcherRegistryInner::default()));
        let resolve_root: WorktreePathResolver = {
            let root = root.path().to_path_buf();
            Arc::new(move |_| Some(root.clone()))
        };

        let conn_a = WsConnection::new(WsSinkHandle::mock(0));
        let conn_b = WsConnection::new(WsSinkHandle::mock(0));

        let key = "tree:wt1:".to_string();
        let msg = || ClientMessage::TreeWatch {
            worktree_id: "wt1".into(),
            path: None,
        };

        handle_tree_watch(&conn_a, &registry, &resolve_root, &file_search, &msg()).await;
        let first = registry
            .lock()
            .unwrap()
            .watchers
            .get(&key)
            .cloned()
            .expect("first connection registered a watcher");

        handle_tree_watch(&conn_b, &registry, &resolve_root, &file_search, &msg()).await;
        let second = registry
            .lock()
            .unwrap()
            .watchers
            .get(&key)
            .cloned()
            .expect("second connection found a watcher for the same key");

        assert!(
            Arc::ptr_eq(&first.watcher, &second.watcher),
            "cause B: a second connection watching the same tree must reuse the \
             first connection's watcher, not spawn a duplicate that overwrites \
             the registry slot and leaks the original"
        );

        // Cleanup the shared watcher so the test leaves no leaked background
        // task / inotify fd behind regardless of the assertion's outcome.
        {
            let mut reg = registry.lock().unwrap();
            if let Some(sw) = reg.watchers.remove(&key) {
                drop(reg);
                sw.watcher.close();
            }
        }
    }

    // Regression: sharing one watcher (above) is only correct if EVERY
    // connection sharing it still gets live updates — a shared watcher that
    // only pushes `TreeChanged` to whichever connection happened to spawn it
    // would silently break every OTHER connection's UI refresh. This asserts
    // the subscriber set itself (what the watcher's callbacks read on every
    // filesystem event via `tree_watch_subscribers`), not a full inotify
    // round-trip — the callbacks' event-loop plumbing is exercised by
    // `streams::file_watcher`'s own tests; what's new here is that joining
    // and releasing correctly track WHO should receive the push.
    #[tokio::test]
    async fn joining_and_releasing_a_shared_watcher_updates_its_subscriber_set() {
        let root = tempfile::tempdir().unwrap();
        let file_search = index();
        let registry: WatcherRegistry = Arc::new(Mutex::new(WatcherRegistryInner::default()));
        let resolve_root: WorktreePathResolver = {
            let root = root.path().to_path_buf();
            Arc::new(move |_| Some(root.clone()))
        };
        let conn_a = WsConnection::new(WsSinkHandle::mock(0));
        let conn_b = WsConnection::new(WsSinkHandle::mock(0));
        let key = "tree:wt1:".to_string();
        let msg = || ClientMessage::TreeWatch {
            worktree_id: "wt1".into(),
            path: None,
        };

        handle_tree_watch(&conn_a, &registry, &resolve_root, &file_search, &msg()).await;
        let subs = tree_watch_subscribers(&registry, &key);
        assert_eq!(subs.len(), 1, "creator is its own first subscriber");
        assert_eq!(subs[0].id(), conn_a.id());

        // conn_b joins the ALREADY-shared watcher (the dedup-join branch) —
        // it must be added to the subscriber set, not silently left out.
        handle_tree_watch(&conn_b, &registry, &resolve_root, &file_search, &msg()).await;
        let subs = tree_watch_subscribers(&registry, &key);
        let ids: std::collections::HashSet<String> =
            subs.iter().map(|c| c.id().to_string()).collect();
        assert_eq!(
            ids,
            std::collections::HashSet::from([conn_a.id().to_string(), conn_b.id().to_string()]),
            "both connections sharing the watcher must be subscribers"
        );

        // conn_a releases (e.g. its tab closed) — it must drop out of the
        // subscriber set while the watcher stays alive for conn_b.
        release_connection_tree_watches(&conn_a, &registry, &file_search).await;
        assert!(
            registry.lock().unwrap().watchers.contains_key(&key),
            "watcher must survive — conn_b still holds a ref"
        );
        let remaining = tree_watch_subscribers(&registry, &key);
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id(), conn_b.id());

        // Cleanup.
        {
            let mut reg = registry.lock().unwrap();
            if let Some(sw) = reg.watchers.remove(&key) {
                drop(reg);
                sw.watcher.close();
            }
        }
    }

    // Regression: the disconnect-release path used to decrement the SHARED
    // refcount once per LOCAL subscriber a connection held, instead of once
    // per key — over-releasing whenever a connection had more than one local
    // subscriber on the same key (the normal case: FileTreeSidebar AND
    // FilePreviewPane both call useTreeWatch for the same worktree from the
    // same browser tab/connection). With two DIFFERENT connections sharing a
    // watcher, one connection's disconnect would wrongly drop the other's
    // still-live global ref, closing the watcher and evicting the index out
    // from under it.
    #[tokio::test]
    async fn disconnecting_connection_with_two_local_subscribers_does_not_over_release_shared_ref()
    {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.rs"), "a").unwrap();
        let file_search = index();
        let registry: WatcherRegistry = Arc::new(Mutex::new(WatcherRegistryInner::default()));
        let resolve_root: WorktreePathResolver = {
            let root = root.path().to_path_buf();
            Arc::new(move |_| Some(root.clone()))
        };
        let conn_a = WsConnection::new(WsSinkHandle::mock(0));
        let conn_b = WsConnection::new(WsSinkHandle::mock(0));
        let key = "tree:wt1:".to_string();
        let msg = || ClientMessage::TreeWatch {
            worktree_id: "wt1".into(),
            path: None,
        };

        // conn_a watches the SAME key twice locally — e.g. FileTreeSidebar
        // and FilePreviewPane both mounted on the same tab — but this only
        // ever takes ONE global ref (the second call short-circuits at
        // conn.retain_tree_watcher).
        handle_tree_watch(&conn_a, &registry, &resolve_root, &file_search, &msg()).await;
        handle_tree_watch(&conn_a, &registry, &resolve_root, &file_search, &msg()).await;
        // conn_b joins too, taking the second (and only other) global ref.
        handle_tree_watch(&conn_b, &registry, &resolve_root, &file_search, &msg()).await;
        assert_eq!(registry.lock().unwrap().watchers.get(&key).unwrap().ref_count, 2);

        // conn_a's tab closes without ever sending tree:unwatch.
        release_connection_tree_watches(&conn_a, &registry, &file_search).await;

        // conn_b's ref must survive: exactly one global decrement for conn_a,
        // not two.
        let sw = registry
            .lock()
            .unwrap()
            .watchers
            .get(&key)
            .cloned()
            .expect("conn_b's watcher must still be registered");
        assert_eq!(sw.ref_count, 1, "only conn_a's single global ref should have been released");
        assert_eq!(sw.subscribers.len(), 1);
        assert_eq!(sw.subscribers.values().next().unwrap().id(), conn_b.id());

        // The index must NOT have been evicted — conn_b is still watching.
        file_search.search("wt1", root.path(), "", 100).await;
        let res = file_search.search("wt1", root.path(), "a", 100).await;
        assert_eq!(
            res.files,
            vec!["a.rs".to_string()],
            "index must still be populated/live — conn_b's watch must not have been evicted"
        );

        // Cleanup.
        {
            let mut reg = registry.lock().unwrap();
            if let Some(sw) = reg.watchers.remove(&key) {
                drop(reg);
                sw.watcher.close();
            }
        }
    }

    // Phase 2 — a dead connection releases ALL the tree watchers it was
    // holding (cause A): a page reload / crashed tab never sends `tree:unwatch`,
    // so the only thing that stops its watchers leaking is the disconnect path.
    #[tokio::test]
    async fn disconnect_releases_all_tree_watchers_and_evicts_index() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.rs"), "a").unwrap();
        let file_search = index();
        let registry: WatcherRegistry = Arc::new(Mutex::new(WatcherRegistryInner::default()));
        let resolve_root: WorktreePathResolver = {
            let root = root.path().to_path_buf();
            Arc::new(move |_| Some(root.clone()))
        };
        let conn = WsConnection::new(WsSinkHandle::mock(0));

        handle_tree_watch(
            &conn,
            &registry,
            &resolve_root,
            &file_search,
            &ClientMessage::TreeWatch {
                worktree_id: "wt1".into(),
                path: None,
            },
        )
        .await;
        // Populate the index so there is an entry that should be evicted.
        file_search.search("wt1", root.path(), "", 100).await;
        assert!(!registry.lock().unwrap().watchers.is_empty());

        // Simulate the connection dropping without ever sending tree:unwatch.
        release_connection_tree_watches(&conn, &registry, &file_search).await;

        assert!(
            registry.lock().unwrap().watchers.is_empty(),
            "disconnect must release the watcher (cause A)"
        );
        assert!(registry.lock().unwrap().worktree_counts.is_empty());

        // Last watcher closed → index evicted. A search with a path that no
        // longer contains a.rs must re-derive from disk (empty) rather than
        // serve the stale cached entry.
        let empty = tempfile::tempdir().unwrap();
        let res = file_search.search("wt1", empty.path(), "", 100).await;
        assert!(
            res.files.is_empty(),
            "disconnect must evict the index entry once the last watcher closes"
        );
    }

    // Phase 3 / plan point 4 — eviction is scoped per-worktree, not per-key. A
    // worktree can have more than one `tree:watch` (root + individually-watched
    // subdirs all feed the same index); releasing one must NOT evict while
    // another for the same worktree is still live.
    #[tokio::test]
    async fn subdir_watch_does_not_evict_while_root_watch_is_live() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("src")).unwrap();
        fs::write(root.path().join("src/a.rs"), "a").unwrap();
        let file_search = index();
        let registry: WatcherRegistry = Arc::new(Mutex::new(WatcherRegistryInner::default()));
        let resolve_root: WorktreePathResolver = {
            let root = root.path().to_path_buf();
            Arc::new(move |_| Some(root.clone()))
        };
        let conn = WsConnection::new(WsSinkHandle::mock(0));

        // Watch the worktree root AND a subdir of the same worktree.
        handle_tree_watch(
            &conn,
            &registry,
            &resolve_root,
            &file_search,
            &ClientMessage::TreeWatch {
                worktree_id: "wt1".into(),
                path: None,
            },
        )
        .await;
        handle_tree_watch(
            &conn,
            &registry,
            &resolve_root,
            &file_search,
            &ClientMessage::TreeWatch {
                worktree_id: "wt1".into(),
                path: Some("src".into()),
            },
        )
        .await;

        let root_key = "tree:wt1:".to_string();
        let subdir_key = "tree:wt1:src".to_string();
        assert!(registry.lock().unwrap().watchers.contains_key(&root_key));
        assert!(registry.lock().unwrap().watchers.contains_key(&subdir_key));

        // Populate the index so there is an entry to (potentially) evict.
        file_search.search("wt1", root.path(), "", 100).await;

        // Releasing ONLY the subdir watch must NOT evict — the root watch is
        // still feeding the same worktree's index.
        handle_tree_unwatch(
            &conn,
            &registry,
            &file_search,
            &ClientMessage::TreeUnwatch {
                worktree_id: "wt1".into(),
                path: Some("src".into()),
            },
        )
        .await;
        assert!(!registry.lock().unwrap().watchers.contains_key(&subdir_key));
        assert!(registry.lock().unwrap().watchers.contains_key(&root_key));
        let before = file_search.search("wt1", tempfile::tempdir().unwrap().path(), "", 100).await;
        assert!(
            before.files.contains(&"src/a.rs".to_string()),
            "a subdir watch closing must not evict while the root watch is live"
        );

        // Releasing the ROOT watch — the last watcher for the worktree — MUST
        // evict: a subsequent search re-walks disk from the given path.
        handle_tree_unwatch(
            &conn,
            &registry,
            &file_search,
            &ClientMessage::TreeUnwatch {
                worktree_id: "wt1".into(),
                path: None,
            },
        )
        .await;
        assert!(registry.lock().unwrap().watchers.is_empty());
        let after = file_search.search("wt1", tempfile::tempdir().unwrap().path(), "", 100).await;
        assert!(
            after.files.is_empty(),
            "closing the last watcher must evict the worktree's index entry"
        );
    }
}
