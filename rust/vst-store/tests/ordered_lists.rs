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
