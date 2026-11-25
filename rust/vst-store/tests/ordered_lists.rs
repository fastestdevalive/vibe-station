//! Behavior contract for `orderedListsStore.ts` (part 01-storage).
//! Ported 1:1 from `daemon/src/__tests__/orderedListsStore.test.ts`.

use vst_store::StoreHandle;

#[tokio::test]
async fn set_overwrites_rather_than_appending() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store
        .set_ordered_list("pinned-all", vec!["a".into(), "b".into()])
        .await;
    store.set_ordered_list("pinned-all", vec!["c".into()]).await;
    let list = store.get_ordered_list("pinned-all").await;
    assert_eq!(list.item_ids, vec!["c"]);
    assert!(list.updated_at.is_some());
}

#[tokio::test]
async fn rows_for_different_scope_keys_are_isolated() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store.set_ordered_list("pinned-all", vec!["a".into()]).await;
    store
        .set_ordered_list("workspaces:global", vec!["b".into()])
        .await;
    let a = store.get_ordered_list("pinned-all").await;
    let b = store.get_ordered_list("workspaces:global").await;
    assert_eq!(a.item_ids, vec!["a"]);
    assert_eq!(b.item_ids, vec!["b"]);
}

#[tokio::test]
async fn missing_row_returns_empty_list_and_null_updated_at() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let list = store.get_ordered_list("pinned-all").await;
    assert!(list.item_ids.is_empty());
    assert!(list.updated_at.is_none());
}

#[tokio::test]
async fn update_none_leaves_list_and_timestamp_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    // Absent row + closure None: still no row written.
    assert!(store
        .update_ordered_list("pinned-all", |_| None)
        .await
        .expect("store ok")
        .is_none());
    assert!(store
        .get_ordered_list("pinned-all")
        .await
        .updated_at
        .is_none());

    store.set_ordered_list("pinned-all", vec!["a".into()]).await;
    let before = store.get_ordered_list("pinned-all").await;
    assert!(store
        .update_ordered_list("pinned-all", |_| None)
        .await
        .expect("store ok")
        .is_none());
    let after = store.get_ordered_list("pinned-all").await;
    assert_eq!(before, after);
}

#[tokio::test]
async fn update_some_writes_and_returns_new_list() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store.set_ordered_list("pinned-all", vec!["a".into()]).await;
    let got = store
        .update_ordered_list("pinned-all", |cur| {
            assert_eq!(cur, ["a".to_string()]);
            Some(vec!["b".into(), "a".into()])
        })
        .await
        .expect("store ok")
        .expect("written");
    assert_eq!(got.item_ids, vec!["b", "a"]);
    assert!(got.updated_at.is_some());
    let stored = store.get_ordered_list("pinned-all").await;
    assert_eq!(stored.item_ids, vec!["b", "a"]);
    assert_eq!(stored.updated_at, got.updated_at);
}

#[tokio::test]
async fn concurrent_prepends_all_land() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    let mut tasks = Vec::new();
    for i in 0..20 {
        let s = store.clone();
        tasks.push(tokio::spawn(async move {
            s.update_ordered_list("pinned-all", move |cur| {
                let mut next = vec![format!("id-{i}")];
                next.extend(cur.iter().cloned());
                Some(next)
            })
            .await
        }));
    }
    for t in tasks {
        assert!(t.await.unwrap().expect("store ok").is_some());
    }
    let mut ids = store.get_ordered_list("pinned-all").await.item_ids;
    assert_eq!(ids.len(), 20);
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 20);
}
