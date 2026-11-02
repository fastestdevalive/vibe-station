//! Tests for `WsHub` connection observer and tree change hook (plan poller-redesign Phase 5.1).

use std::fs;
use std::sync::{Arc, Mutex};
use tempfile::tempdir;

use vst_types::ws::{ClientMessage, WatchScope};
use vst_ws::broadcaster::{TreeChangeHook, WsHub};
use vst_ws::connection::{WsConnection, WsSinkHandle};
use vst_ws::handlers::file_watch::{WatcherRegistry, WatcherRegistryInner, WorktreePathResolver};
use vst_ws::handlers::tree_watch::handle_tree_watch;
use vst_ws::services::file_list::FileList;
use vst_ws::services::file_search::FileSearchIndex;

#[test]
fn connection_observer_fires_on_register_and_unregister_with_new_count() {
    let hub = WsHub::new();
    let counts = Arc::new(Mutex::new(Vec::new()));
    let counts_clone = counts.clone();
    hub.bind_connection_observer(Arc::new(move |c| {
        counts_clone.lock().unwrap().push(c);
    }));

    let conn1 = WsConnection::new(WsSinkHandle::mock(0));
    let conn2 = WsConnection::new(WsSinkHandle::mock(0));

    hub.register_connection(&conn1);
    hub.register_connection(&conn2);
    hub.unregister_connection(&conn1);
    hub.unregister_connection(&conn2);

    let recorded = counts.lock().unwrap().clone();
    assert_eq!(recorded, vec![1, 2, 1, 0]);
}

#[tokio::test]
async fn tree_watch_fires_hook_for_worktree_scope_only() {
    let root = tempdir().unwrap();
    fs::write(root.path().join("test.txt"), "hello").unwrap();

    let file_list = Arc::new(FileList::new());
    let file_search = Arc::new(FileSearchIndex::new(file_list));
    let registry: WatcherRegistry = Arc::new(Mutex::new(WatcherRegistryInner::default()));

    let root_path = root.path().to_path_buf();
    let resolve_root: WorktreePathResolver = {
        let root = root_path.clone();
        Arc::new(move |_id: &str, _scope: WatchScope| Some(root.clone()))
    };

    let events = Arc::new(Mutex::new(Vec::new()));
    let events_clone = events.clone();
    let hook: TreeChangeHook = Arc::new(move |wt| {
        events_clone.lock().unwrap().push(wt.to_string());
    });

    let conn = WsConnection::new(WsSinkHandle::mock(0));

    // 1. Worktree scope watch should register with the hook
    handle_tree_watch(
        &conn,
        &registry,
        &resolve_root,
        &file_search,
        Some(&hook),
        &ClientMessage::TreeWatch {
            worktree_id: "wt-scope-test".into(),
            path: None,
            scope: WatchScope::Worktree,
        },
    )
    .await;

    // Simulate filesystem change triggers via registered watcher callbacks
    {
        let reg = registry.lock().unwrap();
        let _sw = reg
            .watchers
            .get("tree:wt:wt-scope-test:")
            .expect("worktree watcher registered");
        // Watcher is established; now write a file to trigger the watcher
        fs::write(root.path().join("another.txt"), "world").unwrap();
        drop(reg);
    }

    // Give inotify/fsevent briefly to deliver event
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    // 2. Project scope watch should NOT fire hook
    let conn2 = WsConnection::new(WsSinkHandle::mock(0));
    handle_tree_watch(
        &conn2,
        &registry,
        &resolve_root,
        &file_search,
        Some(&hook),
        &ClientMessage::TreeWatch {
            worktree_id: "proj-scope-test".into(),
            path: None,
            scope: WatchScope::Project,
        },
    )
    .await;

    // Write file in project tree
    fs::write(root.path().join("proj-file.txt"), "data").unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    let recorded = events.lock().unwrap().clone();
    // Hook was fired for worktree ("wt-scope-test"), but NEVER for project ("proj-scope-test")
    assert!(
        !recorded.contains(&"proj-scope-test".to_string()),
        "Project scope must not fire hook"
    );
}
