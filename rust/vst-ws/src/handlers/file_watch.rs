//! `file:watch` / `file:unwatch` handlers — refcounted file watchers
//! (Decision 8).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use vst_types::ws::{ClientMessage, ServerMessage};

use crate::connection::WsConnection;
use crate::streams::file_watcher::{FileWatcher, WatcherCallbacks, WatcherHandle};

/// Resolves a watch id to its absolute root path.
pub type WorktreePathResolver =
    Arc<dyn Fn(&str, vst_types::ws::WatchScope) -> Option<PathBuf> + Send + Sync>;

/// One live watcher registration in the shared registry: the watcher plus the
/// number of live subscribers (across ALL connections) currently referencing
/// it. The count is authoritative — a `FileWatcher` is spawned on the first
/// registration for a key and closed only when the count returns to zero.
///
/// `subscribers` is the set of connections that should receive this watcher's
/// push (`ServerMessage::TreeChanged` for tree watchers, `FileChanged`/
/// `FileDeleted`/error for file watchers), keyed by `WsConnection::id()` for
/// O(1) join/leave. The watcher itself is spawned once and its callbacks look
/// this map up fresh on every filesystem event (not a snapshot taken at spawn
/// time), so every connection sharing the watcher gets live updates — not
/// just whichever connection happened to create it.
#[derive(Clone)]
pub struct SharedWatcher {
    pub watcher: Arc<FileWatcher>,
    pub ref_count: usize,
    pub subscribers: HashMap<String, WsConnection>,
}

/// The server-owned registry of live watchers.
///
/// Keyed by watch key (`tree:<worktree_id>:<tree_path>` / `file:<worktree_id>:<path>`).
/// Holds BOTH the per-key shared refcount (authoritative — governs when a
/// `FileWatcher` is spawned and closed) and a per-`worktree_id` counter used to
/// decide when a worktree's `FileSearchIndex` entry should be evicted: a
/// worktree is only forgotten once the LAST of its watchers (root tree or any
/// individually-watched subdir) closes, since they all feed the same index.
#[derive(Default)]
pub struct WatcherRegistryInner {
    pub watchers: HashMap<String, SharedWatcher>,
    pub worktree_counts: HashMap<String, usize>,
}

/// Registry of live watchers keyed by watch key (owned by the server).
pub type WatcherRegistry = Arc<Mutex<WatcherRegistryInner>>;

/// The connections that should receive a `FileChanged`/`FileDeleted`/error push
/// for `watch_key` right now — looked up fresh from the shared registry on every
/// filesystem event, not snapshotted when the watcher was created, so every
/// connection currently sharing the watcher (via the dedup-join path in
/// `handle_file_watch`) gets live updates, not just whichever connection
/// happened to spawn it.
fn file_watch_subscribers(registry: &WatcherRegistry, watch_key: &str) -> Vec<WsConnection> {
    registry
        .lock()
        .unwrap()
        .watchers
        .get(watch_key)
        .map(|sw| sw.subscribers.values().cloned().collect())
        .unwrap_or_default()
}

/// Handle `file:watch`: start watching a file for changes (refcounted).
pub fn handle_file_watch(
    conn: &WsConnection,
    registry: &WatcherRegistry,
    resolve_root: &WorktreePathResolver,
    msg: &ClientMessage,
) {
    let ClientMessage::FileWatch {
        worktree_id,
        path,
        scope,
    } = msg
    else {
        return;
    };
    let watch_key = format!("file:{worktree_id}:{path}");

    // If another consumer already watches this key on THIS connection, just add
    // a reference (same as tree watchers — a second local consumer short-circuits
    // here and never touches the shared registry).
    if conn.retain_file_watcher(&watch_key) {
        return;
    }

    // Global shared dedup (mirrors tree:watch's cause-B fix). If another
    // connection already holds a live watcher for this key, just increment the
    // shared count, register THIS connection as a subscriber so it keeps
    // receiving `FileChanged`/`FileDeleted` too (the watcher's callbacks look
    // subscribers up fresh per event — see `file_watch_subscribers` — so joining
    // here is enough, no new `FileWatcher`/inotify fd needed). The authoritative
    // refcount lives here in the shared registry, NOT in the per-connection map
    // (which only knows what THIS connection holds).
    {
        let mut reg = registry.lock().unwrap();
        if let Some(sw) = reg.watchers.get_mut(&watch_key) {
            sw.ref_count += 1;
            sw.subscribers.insert(conn.id().to_string(), conn.clone());
            drop(reg);
            conn.register_file_watcher(&watch_key, watch_key.clone());
            return;
        }
    }

    let Some(root) = resolve_root(worktree_id, *scope) else {
        conn.send(ServerMessage::SystemError {
            message: format!("Worktree '{worktree_id}' not found"),
        });
        return;
    };
    let abs_path = root.join(path);

    let callbacks = {
        let wt = worktree_id.clone();
        let p = path.clone();
        let on_changed = {
            let registry = Arc::clone(registry);
            let key = watch_key.clone();
            let wt = wt.clone();
            let p = p.clone();
            Arc::new(move |_| {
                for c in file_watch_subscribers(&registry, &key) {
                    c.send(ServerMessage::FileChanged {
                        worktree_id: wt.clone(),
                        path: p.clone(),
                    });
                }
            })
        };
        let on_deleted = {
            let registry = Arc::clone(registry);
            let key = watch_key.clone();
            let wt = wt.clone();
            let p = p.clone();
            Arc::new(move |_| {
                for c in file_watch_subscribers(&registry, &key) {
                    c.send(ServerMessage::FileDeleted {
                        worktree_id: wt.clone(),
                        path: p.clone(),
                    });
                }
            })
        };
        let on_error = {
            let registry = Arc::clone(registry);
            let key = watch_key.clone();
            let p = p.clone();
            Arc::new(move |msg| {
                for c in file_watch_subscribers(&registry, &key) {
                    c.send(ServerMessage::SystemError {
                        message: format!("File watcher error for {p}: {msg}"),
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
    // Register before starting so a follow-up consumer retains the entry.
    conn.register_file_watcher(&watch_key, watch_key.clone());
    registry
        .lock()
        .unwrap()
        .watchers
        .insert(
            watch_key.clone(),
            SharedWatcher {
                watcher: watcher.clone(),
                ref_count: 1,
                subscribers: HashMap::from([(conn.id().to_string(), conn.clone())]),
            },
        );

    if let Err(e) = watcher.watch_file(abs_path.to_str().unwrap_or("")) {
        conn.send(ServerMessage::SystemError {
            message: format!("Failed to watch file {path}: {e}"),
        });
        // Force-teardown: unregister the failed entry.
        conn.unregister_file_watcher(&watch_key);
        registry.lock().unwrap().watchers.remove(&watch_key);
    }
}

/// Handle `file:unwatch`: release one consumer's reference; close the watcher
/// only when the shared refcount hits 0.
pub async fn handle_file_unwatch(
    conn: &WsConnection,
    registry: &WatcherRegistry,
    msg: &ClientMessage,
) {
    let ClientMessage::FileUnwatch {
        worktree_id, path, ..
    } = msg
    else {
        return;
    };
    let watch_key = format!("file:{worktree_id}:{path}");
    if let Some(_released) = conn.release_file_watcher(&watch_key) {
        release_shared_file_watcher(registry, &watch_key, conn.id()).await;
    }
}

/// Release every file watcher a closing connection was still holding.
///
/// Mirrors exactly what the explicit `file:unwatch` path does, but iterates the
/// connection's full holdings. A page reload / crashed tab / lost socket never
/// sends `file:unwatch`, so without this a dead connection's watchers would leak
/// forever (the bug this fix ships to close).
///
/// `handle_file_watch` only ever takes ONE global (shared-registry) ref per
/// connection per key — a second local subscriber on the same connection
/// short-circuits at `conn.retain_file_watcher` and never touches the shared
/// registry. So the release side must also drop exactly ONE global ref per key
/// here, regardless of how many local subscribers this connection had —
/// `conn.unregister_file_watcher` clears the connection's entire local hold on a
/// key in one call (vs. `release_file_watcher`, which only drops one local unit
/// and is what the graceful `file:unwatch` path above uses, one call per client
/// message). Decrementing the shared count once per LOCAL unit here (the shape
/// the tree:watch fix had to correct) would over-release whenever a connection
/// had more than one local subscriber on the same key — with two DIFFERENT
/// connections sharing a watcher, one connection's disconnect would wrongly drop
/// the other's still-live global ref and close its watcher.
pub async fn release_connection_file_watches(conn: &WsConnection, registry: &WatcherRegistry) {
    let keys = conn.file_watch_keys();
    for key in keys {
        conn.unregister_file_watcher(&key);
        release_shared_file_watcher(registry, &key, conn.id()).await;
    }
}

/// Decrement the shared refcount for a watch key. When it returns to zero,
/// close the underlying `FileWatcher` (blocking teardown of its inotify
/// watches). Unlike tree watchers, file watchers don't feed the
/// `FileSearchIndex`, so there is no per-worktree count or eviction to manage.
async fn release_shared_file_watcher(
    registry: &WatcherRegistry,
    watch_key: &str,
    conn_id: &str,
) {
    let closed_watcher = {
        let mut reg = registry.lock().unwrap();
        match reg.watchers.get_mut(watch_key) {
            Some(sw) => {
                sw.ref_count = sw.ref_count.saturating_sub(1);
                sw.subscribers.remove(conn_id);
                if sw.ref_count > 0 {
                    None
                } else {
                    reg.watchers.remove(watch_key).map(|sw| sw.watcher)
                }
            }
            None => None,
        }
    };
    if let Some(watcher) = closed_watcher {
        // Tearing down the notify watcher (releases the inotify fd) is blocking
        // work, so keep it off the calling task.
        let _ = tokio::task::spawn_blocking(move || watcher.close()).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    use crate::connection::{WsConnection, WsSinkHandle};
    use std::sync::Mutex;

    fn registry() -> WatcherRegistry {
        Arc::new(Mutex::new(WatcherRegistryInner::default()))
    }

    fn resolve_root(root: std::path::PathBuf) -> WorktreePathResolver {
        Arc::new(move |_id: &str, _scope: vst_types::ws::WatchScope| Some(root.clone()))
    }

    // Phase 0 — regression test proving the file-watcher leak (bug 2: global
    // unconditional registry insert overwriting another connection's watcher).
    //
    // Two SEPARATE connections watch the SAME file path. The registry must end
    // up with a SINGLE shared `Arc<FileWatcher>` for the key: the second
    // connection reuses the first's watcher instead of spawning a brand-new one
    // that overwrites the registry slot and leaks the first's background task
    // (which keeps an inotify fd alive forever with no reachable handle to close
    // it).
    //
    // Against the pre-fix code the second `handle_file_watch` spawns a fresh
    // `FileWatcher` and overwrites the registry entry, so the two reads observe
    // DIFFERENT `Arc`s and this assertion fails.
    #[tokio::test]
    async fn two_connections_watching_same_file_share_one_watcher() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("existing.rs"), "x").unwrap();
        let registry = registry();
        let resolve_root = resolve_root(root.path().to_path_buf());

        let conn_a = WsConnection::new(WsSinkHandle::mock(0));
        let conn_b = WsConnection::new(WsSinkHandle::mock(0));

        let key = "file:wt1:existing.rs".to_string();
        let msg = || ClientMessage::FileWatch {
            worktree_id: "wt1".into(),
            path: "existing.rs".into(),
            scope: vst_types::ws::WatchScope::Worktree,
        };

        handle_file_watch(&conn_a, &registry, &resolve_root, &msg());
        let first = registry
            .lock()
            .unwrap()
            .watchers
            .get(&key)
            .cloned()
            .expect("first connection registered a watcher");

        handle_file_watch(&conn_b, &registry, &resolve_root, &msg());
        let second = registry
            .lock()
            .unwrap()
            .watchers
            .get(&key)
            .cloned()
            .expect("second connection found a watcher for the same key");

        assert!(
            Arc::ptr_eq(&first.watcher, &second.watcher),
            "bug 2: a second connection watching the same file must reuse the \
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
    // only pushes `FileChanged` to whichever connection happened to spawn it
    // would silently break every OTHER connection's UI refresh. This asserts
    // the subscriber set itself (what the watcher's callbacks read on every
    // filesystem event via `file_watch_subscribers`), not a full inotify
    // round-trip — what's new here is that joining and releasing correctly
    // track WHO should receive the push.
    #[tokio::test]
    async fn joining_and_releasing_a_shared_watcher_updates_its_subscriber_set() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("existing.rs"), "x").unwrap();
        let registry = registry();
        let resolve_root = resolve_root(root.path().to_path_buf());
        let conn_a = WsConnection::new(WsSinkHandle::mock(0));
        let conn_b = WsConnection::new(WsSinkHandle::mock(0));
        let key = "file:wt1:existing.rs".to_string();
        let msg = || ClientMessage::FileWatch {
            worktree_id: "wt1".into(),
            path: "existing.rs".into(),
            scope: vst_types::ws::WatchScope::Worktree,
        };

        handle_file_watch(&conn_a, &registry, &resolve_root, &msg());
        let subs = file_watch_subscribers(&registry, &key);
        assert_eq!(subs.len(), 1, "creator is its own first subscriber");
        assert_eq!(subs[0].id(), conn_a.id());

        // conn_b joins the ALREADY-shared watcher (the dedup-join branch) —
        // it must be added to the subscriber set, not silently left out.
        handle_file_watch(&conn_b, &registry, &resolve_root, &msg());
        let subs = file_watch_subscribers(&registry, &key);
        let ids: std::collections::HashSet<String> =
            subs.iter().map(|c| c.id().to_string()).collect();
        assert_eq!(
            ids,
            std::collections::HashSet::from([conn_a.id().to_string(), conn_b.id().to_string()]),
            "both connections sharing the watcher must be subscribers"
        );

        // conn_a releases (e.g. its tab closed) — it must drop out of the
        // subscriber set while the watcher stays alive for conn_b.
        release_connection_file_watches(&conn_a, &registry).await;
        assert!(
            registry.lock().unwrap().watchers.contains_key(&key),
            "watcher must survive — conn_b still holds a ref"
        );
        let remaining = file_watch_subscribers(&registry, &key);
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

    // Regression: `joining_and_releasing_a_shared_watcher_updates_its_subscriber_set`
    // above only asserts the registry's `subscribers` bookkeeping via
    // `file_watch_subscribers` — the SAME helper `on_changed`/`on_deleted`/
    // `on_error` call internally. That proves the data structure is right,
    // but not that the callbacks actually READ it — a regression back to
    // capturing one connection at watcher-creation time (instead of looking
    // subscribers up fresh per event) would leave every assertion above
    // green. This test goes through a REAL filesystem event and a REAL
    // WsSinkHandle, so it can only pass if `on_changed` truly fans out to
    // every current subscriber.
    #[tokio::test]
    async fn shared_watcher_delivers_a_real_file_change_to_every_subscriber() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("watched.rs");
        fs::write(&target, "v1").unwrap();
        let registry = registry();
        let resolve_root = resolve_root(root.path().to_path_buf());

        let sent_a = Arc::new(Mutex::new(Vec::new()));
        let sent_b = Arc::new(Mutex::new(Vec::new()));
        let conn_a = WsConnection::new(WsSinkHandle::from_parts(
            sent_a.clone(),
            Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            Arc::new(Mutex::new(None)),
        ));
        let conn_b = WsConnection::new(WsSinkHandle::from_parts(
            sent_b.clone(),
            Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            Arc::new(Mutex::new(None)),
        ));

        let key = "file:wt1:watched.rs".to_string();
        let msg = || ClientMessage::FileWatch {
            worktree_id: "wt1".into(),
            path: "watched.rs".into(),
            scope: vst_types::ws::WatchScope::Worktree,
        };

        handle_file_watch(&conn_a, &registry, &resolve_root, &msg());
        // Speed up the debounce so the test doesn't wait 200ms+ per poll.
        registry
            .lock()
            .unwrap()
            .watchers
            .get(&key)
            .unwrap()
            .watcher
            .set_debounce_ms_for_test(20);
        // conn_b joins the ALREADY-shared watcher via the dedup path.
        handle_file_watch(&conn_b, &registry, &resolve_root, &msg());

        fs::write(&target, "v2").unwrap();

        // Poll for up to ~4s for both sinks to have received a FileChanged
        // frame for this path (mirrors `vst-ws/tests/file_watcher.rs`'s own
        // polling pattern for real inotify events).
        let saw_it = |sent: &Arc<Mutex<Vec<serde_json::Value>>>| {
            sent.lock().unwrap().iter().any(|v| {
                v.get("type").and_then(|t| t.as_str()) == Some("file:changed")
                    && v.get("path").and_then(|p| p.as_str()) == Some("watched.rs")
            })
        };
        let mut ok = false;
        for _ in 0..40 {
            if saw_it(&sent_a) && saw_it(&sent_b) {
                ok = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(
            ok,
            "both subscribers sharing the watcher must receive the live FileChanged \
             push, not just whichever connection created it — conn_a saw: {:?}, \
             conn_b saw: {:?}",
            sent_a.lock().unwrap(),
            sent_b.lock().unwrap()
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

    // Regression: the disconnect-release path must decrement the SHARED
    // refcount once per KEY (not once per local subscriber a connection held).
    // `handle_file_watch` short-circuits a second local watch of the same key at
    // `conn.retain_file_watcher` and never touches the shared registry, so a
    // release that decremented once per local unit would over-release whenever a
    // connection had more than one local subscriber on the same key. With two
    // DIFFERENT connections sharing a watcher, one connection's disconnect would
    // wrongly drop the other's still-live global ref, closing its watcher.
    #[tokio::test]
    async fn disconnecting_connection_with_two_local_subscribers_does_not_over_release_shared_ref()
    {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("existing.rs"), "x").unwrap();
        let registry = registry();
        let resolve_root = resolve_root(root.path().to_path_buf());
        let conn_a = WsConnection::new(WsSinkHandle::mock(0));
        let conn_b = WsConnection::new(WsSinkHandle::mock(0));
        let key = "file:wt1:existing.rs".to_string();
        let msg = || ClientMessage::FileWatch {
            worktree_id: "wt1".into(),
            path: "existing.rs".into(),
            scope: vst_types::ws::WatchScope::Worktree,
        };

        // conn_a watches the SAME key twice locally — but this only ever takes
        // ONE global ref (the second call short-circuits at
        // conn.retain_file_watcher).
        handle_file_watch(&conn_a, &registry, &resolve_root, &msg());
        handle_file_watch(&conn_a, &registry, &resolve_root, &msg());
        // conn_b joins too, taking the second (and only other) global ref.
        handle_file_watch(&conn_b, &registry, &resolve_root, &msg());
        assert_eq!(registry.lock().unwrap().watchers.get(&key).unwrap().ref_count, 2);

        // conn_a's tab closes without ever sending file:unwatch.
        release_connection_file_watches(&conn_a, &registry).await;

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

        // Cleanup.
        {
            let mut reg = registry.lock().unwrap();
            if let Some(sw) = reg.watchers.remove(&key) {
                drop(reg);
                sw.watcher.close();
            }
        }
    }

    // Phase 2 — a dead connection releases ALL the file watchers it was
    // holding (bug 1): a page reload / crashed tab never sends `file:unwatch`,
    // so the only thing that stops its watchers leaking is the disconnect path.
    #[tokio::test]
    async fn disconnect_releases_all_file_watchers() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.rs"), "a").unwrap();
        fs::write(root.path().join("b.rs"), "b").unwrap();
        let registry = registry();
        let resolve_root = resolve_root(root.path().to_path_buf());
        let conn = WsConnection::new(WsSinkHandle::mock(0));

        handle_file_watch(
            &conn,
            &registry,
            &resolve_root,
            &ClientMessage::FileWatch {
                worktree_id: "wt1".into(),
                path: "a.rs".into(),
                scope: vst_types::ws::WatchScope::Worktree,
            },
        );
        handle_file_watch(
            &conn,
            &registry,
            &resolve_root,
            &ClientMessage::FileWatch {
                worktree_id: "wt1".into(),
                path: "b.rs".into(),
                scope: vst_types::ws::WatchScope::Worktree,
            },
        );
        assert_eq!(registry.lock().unwrap().watchers.len(), 2);

        // Simulate the connection dropping without ever sending file:unwatch.
        release_connection_file_watches(&conn, &registry).await;

        assert!(
            registry.lock().unwrap().watchers.is_empty(),
            "disconnect must release every file watcher (bug 1)"
        );
    }

    // Phase 1 — a project-scope `file:watch` resolves against a resolver that
    // distinguishes scopes: it returns a root ONLY for `(id, WatchScope::Project)`,
    // never for `(id, WatchScope::Worktree)`. The watcher must register
    // successfully (no `SystemError` sent), proving `handle_file_watch` threads
    // `msg.scope` through to `resolve_root`.
    #[tokio::test]
    async fn project_scope_file_watch_resolves_against_project_branch() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("proj.rs"), "x").unwrap();
        let registry = registry();
        let resolve_root: WorktreePathResolver = Arc::new(move |id: &str, scope: vst_types::ws::WatchScope| {
            match scope {
                vst_types::ws::WatchScope::Project if id == "proj1" => Some(root.path().to_path_buf()),
                _ => None,
            }
        });

        let sent = Arc::new(Mutex::new(Vec::new()));
        let conn = WsConnection::new(WsSinkHandle::from_parts(
            sent.clone(),
            Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            Arc::new(Mutex::new(None)),
        ));

        handle_file_watch(
            &conn,
            &registry,
            &resolve_root,
            &ClientMessage::FileWatch {
                worktree_id: "proj1".into(),
                path: "proj.rs".into(),
                scope: vst_types::ws::WatchScope::Project,
            },
        );

        assert!(
            registry.lock().unwrap().watchers.contains_key("file:proj1:proj.rs"),
            "project-scope watcher must register successfully"
        );
        assert!(
            !sent.lock().unwrap().iter().any(|v| v.get("type").and_then(|t| t.as_str()) == Some("system:error")),
            "project-scope resolution must not send SystemError"
        );

        // Cleanup.
        {
            let mut reg = registry.lock().unwrap();
            if let Some(sw) = reg.watchers.remove("file:proj1:proj.rs") {
                drop(reg);
                sw.watcher.close();
            }
        }
    }
}
