//! 2.T7: missing rows, hash-matched moves, explicit moves, lazy revalidation.

mod common;

use common::Env;
use vst_artifacts::ReadOutcome;
use vst_types::artifacts::{ArtifactRemoveReason, ArtifactSink, ArtifactState, FileEffect};
use vst_types::ServerEvent;

#[tokio::test]
async fn deleted_file_is_missing_and_a_hash_match_merges_into_the_old_row() {
    let mut env = Env::new().await;
    let a = env.file(&env.out("a.md"), "same bytes");
    env.write_now("sess-a", &a).await;
    let old = env.handle.list(&env.scope).await.unwrap().items[0].clone();
    env.handle.pin(&old.id, true).await.unwrap();

    std::fs::remove_file(&a).unwrap();
    env.handle.clear_revalidation_debounce();
    let list = env.handle.list(&env.scope).await.unwrap();
    assert_eq!(list.items[0].state, ArtifactState::Missing);
    let _ = env.events();

    // The same bytes appear at a new path (a second row).
    let b = env.file(&env.out("b.md"), "same bytes");
    env.write_now("sess-a", &b).await;
    env.handle.clear_revalidation_debounce();
    let list = env.handle.list(&env.scope).await.unwrap();
    assert_eq!(list.items.len(), 1, "merged into one row");
    let row = &list.items[0];
    assert_eq!(row.id, old.id, "the OLD row survives");
    assert_eq!(row.path, b.to_string_lossy());
    assert!(row.pinned);
    assert_eq!(row.state, ArtifactState::Ok);
    assert_eq!(row.edit_count, 1);

    let ev = env.events();
    assert!(
        ev.iter().any(|e| matches!(e, ServerEvent::ArtifactRemoved { reason: ArtifactRemoveReason::Merged, ids, .. } if !ids.contains(&old.id))),
        "the new row is reported as removed{{merged}}: {ev:?}"
    );
}

#[tokio::test]
async fn ambiguous_matches_stay_missing() {
    let env = Env::new().await;
    let a = env.file(&env.out("a.md"), "dup");
    env.write_now("sess-a", &a).await;
    std::fs::remove_file(&a).unwrap();
    let b = env.file(&env.out("b.md"), "dup");
    let c = env.file(&env.out("c.md"), "dup");
    env.write_now("sess-a", &b).await;
    env.write_now("sess-a", &c).await;
    env.handle.clear_revalidation_debounce();
    let list = env.handle.list(&env.scope).await.unwrap();
    assert_eq!(list.items.len(), 3);
    let missing: Vec<_> = list
        .items
        .iter()
        .filter(|r| r.state == ArtifactState::Missing)
        .collect();
    assert_eq!(missing.len(), 1);
    assert_eq!(missing[0].path, a.to_string_lossy());
}

#[tokio::test]
async fn explicit_move_effect_updates_the_row_in_place() {
    let env = Env::with_sessions(&["sess-a", "sess-b"]).await;
    let a = env.file(&env.out("old.md"), "moved content");
    env.write_now("sess-a", &a).await;
    let before = env.handle.list(&env.scope).await.unwrap().items[0].clone();
    env.handle.pin(&before.id, true).await.unwrap();

    let b = env.out("new.md");
    std::fs::rename(&a, &b).unwrap();
    let mut changes = env.handle.subscribe_changes();
    env.handle.record(
        env.ctx("sess-b"),
        vec![FileEffect::moved(a.to_string_lossy(), b.to_string_lossy())],
    );
    env.handle.drain_now().await;

    let list = env.handle.list(&env.scope).await.unwrap();
    assert_eq!(list.items.len(), 1);
    let row = &list.items[0];
    assert_eq!(row.id, before.id);
    assert_eq!(row.path, b.to_string_lossy());
    assert!(row.pinned);
    assert_eq!(row.edit_count, 1);
    assert_eq!(row.writers[0], "sess-b");
    let mut saw_move = false;
    while let Ok(c) = changes.try_recv() {
        saw_move |= matches!(c, vst_artifacts::ArtifactChange::Moved { .. });
    }
    assert!(saw_move);
}

#[tokio::test]
async fn move_to_an_ineligible_destination_marks_the_old_row_missing() {
    let env = Env::new().await;
    let a = env.file(&env.root.join("docs/a.md"), "doc");
    env.write_now("sess-a", &a).await;
    let dest = env.root.join("node_modules/a.md");
    std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
    std::fs::rename(&a, &dest).unwrap();
    env.handle.record(
        env.ctx("sess-a"),
        vec![FileEffect::moved(
            a.to_string_lossy(),
            dest.to_string_lossy(),
        )],
    );
    env.handle.drain_now().await;
    let list = env.handle.list(&env.scope).await.unwrap();
    assert_eq!(list.items.len(), 1, "no new row");
    assert_eq!(list.items[0].state, ArtifactState::Missing);
}

#[tokio::test]
async fn content_get_on_a_moved_file_serves_it_and_emits_an_upsert() {
    let mut env = Env::new().await;
    let a = env.file(&env.out("a.md"), "moving text");
    env.write_now("sess-a", &a).await;
    let id = env.handle.list(&env.scope).await.unwrap().items[0]
        .id
        .clone();
    let b = env.out("b.md");
    std::fs::rename(&a, &b).unwrap();
    env.write_now("sess-a", &b).await; // second row, no list in between
    let _ = env.events();

    match env.handle.read_content(&id).await {
        ReadOutcome::Text { bytes, .. } => assert_eq!(bytes, b"moving text"),
        other => panic!("expected the moved file, got {other:?}"),
    }
    let ev = env.events();
    assert!(ev.iter().any(|e| matches!(e, ServerEvent::ArtifactUpserted { rows, .. } if rows.iter().any(|r| r.row.id == id && r.row.path == b.to_string_lossy()))));
    let list = env.handle.list(&env.scope).await.unwrap();
    assert_eq!(list.items.len(), 1);
}

#[tokio::test]
async fn revalidate_paths_sets_missing_and_emits_one_upsert() {
    let mut env = Env::new().await;
    let a = env.file(&env.out("a.md"), "gone soon");
    let keep = env.file(&env.out("keep.md"), "stays");
    env.write_now("sess-a", &a).await;
    env.write_now("sess-a", &keep).await;
    let _ = env.events();
    std::fs::remove_file(&a).unwrap();
    let n = env
        .handle
        .revalidate_paths(&env.scope, &[a.clone(), keep.clone()])
        .await;
    assert_eq!(n, 1);
    let ev = env.events();
    let ups: Vec<_> = ev
        .iter()
        .filter_map(|e| match e {
            ServerEvent::ArtifactUpserted { rows, .. } => Some(rows),
            _ => None,
        })
        .collect();
    assert_eq!(ups.len(), 1);
    assert_eq!(ups[0].len(), 1);
    assert_eq!(ups[0][0].row.state, ArtifactState::Missing);
    // Back again: cleared.
    std::fs::write(&a, "gone soon").unwrap();
    assert_eq!(env.handle.revalidate_paths(&env.scope, &[a]).await, 1);
}

#[tokio::test]
async fn delete_effect_never_creates_and_marks_an_existing_row_missing() {
    let env = Env::new().await;
    let a = env.file(&env.out("d.md"), "x");
    // A delete of something never recorded is a no-op.
    env.handle.record(
        env.ctx("sess-a"),
        vec![FileEffect::delete(a.to_string_lossy())],
    );
    env.handle.drain_now().await;
    assert_eq!(env.handle.list(&env.scope).await.unwrap().total, 0);
    // A delete effect for a file that still exists changes nothing.
    env.write_now("sess-a", &a).await;
    env.handle.record(
        env.ctx("sess-a"),
        vec![FileEffect::delete(a.to_string_lossy())],
    );
    env.handle.drain_now().await;
    assert_eq!(
        env.handle.list(&env.scope).await.unwrap().items[0].state,
        ArtifactState::Ok
    );
    // A real delete flips the row to missing.
    std::fs::remove_file(&a).unwrap();
    env.handle.record(
        env.ctx("sess-a"),
        vec![FileEffect::delete(a.to_string_lossy())],
    );
    env.handle.drain_now().await;
    let list = env.handle.list(&env.scope).await.unwrap();
    assert_eq!(list.items.len(), 1);
    assert_eq!(list.items[0].state, ArtifactState::Missing);
}

#[tokio::test]
async fn revalidation_debounce_map_forgets_removed_rows() {
    let env = Env::new().await;
    let a = env.file(&env.out("a.md"), "one");
    env.write_now("sess-a", &a).await;
    let row = env.handle.list(&env.scope).await.unwrap().items[0].clone();
    assert_eq!(env.handle.revalidation_debounce_len(), 1);

    env.handle.remove(&row.id).await.unwrap();
    // Within the window the entry is still there; after it, the next listing
    // drops it instead of keeping the id for the daemon's lifetime.
    tokio::time::sleep(vst_artifacts::REVALIDATE_DEBOUNCE + std::time::Duration::from_millis(200))
        .await;
    env.handle.list(&env.scope).await.unwrap();
    assert_eq!(env.handle.revalidation_debounce_len(), 0);
}
