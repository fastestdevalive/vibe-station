//! 2.T11: the event batcher with a paused clock.

use std::time::Duration;

use tokio::sync::broadcast::error::TryRecvError;
use vst_artifacts::batcher::{Batcher, BATCH_WINDOW, CHUNK_ROWS};
use vst_types::artifacts::{
    AddedVia, ArtifactKind, ArtifactRemoveReason, ArtifactRow, ArtifactState, ScopeKey, ScopeKind,
};
use vst_types::{Broadcaster, ServerEvent};

fn row(id: &str, edits: u32) -> ArtifactRow {
    ArtifactRow {
        id: id.into(),
        scope_kind: ScopeKind::Worktree,
        scope_id: "w".into(),
        path: format!("/p/{id}.md"),
        display_path: format!("{id}.md"),
        in_repo: false,
        kind: ArtifactKind::Doc,
        size: Some(1),
        state: ArtifactState::Ok,
        pinned: false,
        edit_count: edits,
        writers: vec![],
        added_via: AddedVia::Capture,
        created_at: "t".into(),
        last_written_at: "t".into(),
    }
}

fn scope() -> ScopeKey {
    ScopeKey::worktree("w")
}

async fn tick() {
    tokio::time::advance(BATCH_WINDOW + Duration::from_millis(1)).await;
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
}

#[tokio::test(start_paused = true)]
async fn updates_to_one_id_in_a_window_make_one_event_and_rev_counts_flushes() {
    let bc = Broadcaster::new(64);
    let mut rx = bc.subscribe();
    let b = Batcher::new(bc);
    let _task = b.clone().start();
    tick().await;
    assert!(
        matches!(rx.try_recv(), Err(TryRecvError::Empty)),
        "empty window emits nothing"
    );

    b.upsert(row("a", 1), true);
    b.upsert(row("a", 2), false);
    assert_eq!(b.rev(&scope()), 0, "rev is stamped at flush");
    tick().await;
    match rx.try_recv().unwrap() {
        ServerEvent::ArtifactUpserted { rev, rows, .. } => {
            assert_eq!(rev, 1);
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].row.edit_count, 2, "last write wins");
            assert!(rows[0].created, "created is sticky within a window");
        }
        other => panic!("unexpected {other:?}"),
    }
    assert!(matches!(rx.try_recv(), Err(TryRecvError::Empty)));

    b.upsert(row("b", 1), true);
    tick().await;
    match rx.try_recv().unwrap() {
        ServerEvent::ArtifactUpserted { rev, .. } => assert_eq!(rev, 2),
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(b.rev(&scope()), 2);
    tick().await;
    assert!(matches!(rx.try_recv(), Err(TryRecvError::Empty)));
}

#[tokio::test(start_paused = true)]
async fn removal_cancels_a_pending_upsert_and_chunks_are_bounded() {
    let bc = Broadcaster::new(64);
    let mut rx = bc.subscribe();
    let b = Batcher::new(bc);
    let _task = b.clone().start();

    b.upsert(row("a", 1), true);
    b.remove(&scope(), vec!["a".into()], ArtifactRemoveReason::Removed);
    tick().await;
    match rx.try_recv().unwrap() {
        ServerEvent::ArtifactRemoved {
            ids, reason, rev, ..
        } => {
            assert_eq!(ids, vec!["a".to_string()]);
            assert_eq!(reason, ArtifactRemoveReason::Removed);
            assert_eq!(rev, 1);
        }
        other => panic!("unexpected {other:?}"),
    }
    assert!(matches!(rx.try_recv(), Err(TryRecvError::Empty)));

    for i in 0..(CHUNK_ROWS * 2 + 5) {
        b.upsert(row(&format!("r{i}"), 1), true);
    }
    tick().await;
    let mut sizes = Vec::new();
    let mut revs = Vec::new();
    while let Ok(ServerEvent::ArtifactUpserted { rows, rev, .. }) = rx.try_recv() {
        sizes.push(rows.len());
        revs.push(rev);
    }
    assert_eq!(sizes, vec![CHUNK_ROWS, CHUNK_ROWS, 5]);
    assert_eq!(
        revs,
        vec![2, 3, 4],
        "each event takes the next consecutive rev"
    );
}
