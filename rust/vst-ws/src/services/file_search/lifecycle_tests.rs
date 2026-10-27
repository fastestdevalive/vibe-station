//! Eviction-epoch and watch-mid-walk regression tests (see
//! `docs/FILE-SEARCH-LIFECYCLE.md`, "Evict during a request" / "Watch armed mid-walk").

use super::*;
use std::fs;

fn park() -> (Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>) {
    (
        Arc::new(tokio::sync::Notify::new()),
        Arc::new(tokio::sync::Notify::new()),
    )
}

async fn clear_hook(idx: &FileSearchIndex) {
    *idx.walk_hook.lock().await = None;
}

fn running_handle(idx: &FileSearchIndex, key: &str) -> (watch::Receiver<bool>, CancellationToken) {
    let map = idx.in_flight.lock().unwrap();
    let r = map.running.get(key).expect("walk registered");
    (r.done.clone(), r.cancel.clone())
}

#[tokio::test]
async fn evict_during_first_walk_does_not_resurrect() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("v.txt"), "1").unwrap();
    let idx = Arc::new(FileSearchIndex::new(Arc::new(FileList::new())));
    let (reached, release) = park();
    idx.set_walk_hook(Arc::clone(&reached), Arc::clone(&release))
        .await;

    let (i2, p) = (Arc::clone(&idx), dir.path().to_path_buf());
    let first = tokio::spawn(async move { i2.search("k", &p, "", 10).await });
    reached.notified().await;
    let (_, token) = running_handle(&idx, "k");

    idx.evict("k").await;
    assert!(token.is_cancelled(), "doomed walk is cancelled");
    drop(dir); // the worktree directory is gone
    clear_hook(&idx).await;
    release.notify_one();

    let r = first.await.unwrap();
    assert!(
        r.indexing && r.files.is_empty(),
        "empty, indexing so the client asks again"
    );
    assert!(!idx.index.read().await.contains_key("k"), "not resurrected");
    assert_eq!(idx.walk_count.load(Ordering::SeqCst), 1, "no re-kick");
}

#[tokio::test]
async fn evict_during_stale_refresh_does_not_resurrect() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("v.txt"), "1").unwrap();
    let idx = Arc::new(FileSearchIndex::with_ttl(
        Arc::new(FileList::new()),
        Duration::ZERO,
    ));
    idx.search("k", dir.path(), "", 10).await;
    let (reached, release) = park();
    idx.set_walk_hook(Arc::clone(&reached), Arc::clone(&release))
        .await;
    let r = idx.search("k", dir.path(), "", 10).await;
    assert_eq!(r.files, vec!["v.txt".to_string()], "served stale");
    reached.notified().await;
    let (mut done, token) = running_handle(&idx, "k");

    idx.evict("k").await;
    assert!(token.is_cancelled(), "doomed refresh is cancelled");
    clear_hook(&idx).await;
    release.notify_one();
    let _ = done.wait_for(|d| *d).await;

    assert!(!idx.index.read().await.contains_key("k"), "not resurrected");
    assert_eq!(idx.walk_count.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn kick_refuses_when_key_was_evicted_after_request_began() {
    let dir = tempfile::tempdir().unwrap();
    let idx = Arc::new(FileSearchIndex::new(Arc::new(FileList::new())));
    let epoch = idx.evict_epoch("k");
    idx.evict("k").await;
    assert!(idx.kick("k", dir.path(), epoch).is_none());
    assert!(idx.kick("k", dir.path(), idx.evict_epoch("k")).is_some());
    idx.settle("k").await;
}

#[tokio::test]
async fn watch_armed_mid_walk_forces_one_more_walk() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.txt"), "1").unwrap();
    let idx = Arc::new(FileSearchIndex::new(Arc::new(FileList::new())));
    let (reached, release) = park();
    idx.set_walk_hook(Arc::clone(&reached), Arc::clone(&release))
        .await;

    let (i2, p) = (Arc::clone(&idx), dir.path().to_path_buf());
    let first = tokio::spawn(async move { i2.search("k", &p, "", 10).await });
    reached.notified().await; // rg already listed {a.txt}
    idx.watch_started("k").await;
    fs::write(dir.path().join("b.txt"), "2").unwrap(); // no watcher event for it
    clear_hook(&idx).await;
    release.notify_one();
    let r = first.await.unwrap();
    assert_eq!(r.files, vec!["a.txt".to_string()]);
    assert!(
        idx.index.read().await.get("k").unwrap().stale,
        "walk completion keeps the entry stale"
    );
    assert!(!idx.is_fresh("k").await);

    idx.search("k", dir.path(), "", 10).await; // stale-serve + refresh
    idx.settle("k").await;
    let r = idx.search("k", dir.path(), "", 10).await;
    assert!(
        r.files.contains(&"b.txt".to_string()),
        "second walk indexes b"
    );
    assert_eq!(idx.walk_count.load(Ordering::SeqCst), 2);
    assert!(idx.is_fresh("k").await, "watched and settled: fresh again");
}
