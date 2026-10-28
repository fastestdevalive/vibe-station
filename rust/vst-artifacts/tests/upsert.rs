//! 2.T4, 2.T5, 2.T5b, 2.T8, 2.T12: capture pipeline against a real store and
//! file system.

mod common;

use common::Env;
use vst_types::artifacts::{
    ArtifactRemoveReason, ArtifactSink, ArtifactState, FileEffect, ARTIFACT_CAP,
};
use vst_types::ServerEvent;

fn upserts(events: &[ServerEvent]) -> Vec<&ServerEvent> {
    events
        .iter()
        .filter(|e| matches!(e, ServerEvent::ArtifactUpserted { .. }))
        .collect()
}

#[tokio::test]
async fn upsert_is_idempotent_and_counts_only_changed_bytes() {
    let mut env = Env::new().await;
    let a = env.file(&env.out("a.md"), "one");
    let b = env.file(&env.out("b.md"), "bee");

    env.write_now("sess-a", &a).await;
    env.write_now("sess-a", &b).await;
    let ev = env.events();
    assert_eq!(upserts(&ev).len(), 1, "both rows in one batched event");

    // Same effect again: nothing changes, no event.
    env.write_now("sess-a", &a).await;
    assert!(env.events().is_empty());
    let list = env.handle.list(&env.scope).await.unwrap();
    assert_eq!(list.items.len(), 2);
    assert_eq!(list.items[0].path, b.to_string_lossy(), "newest first");
    assert!(list.items.iter().all(|r| r.edit_count == 1));

    // Changed bytes: editCount 2 and the row moves to the front.
    std::fs::write(&a, "two").unwrap();
    env.write_now("sess-a", &a).await;
    let ev = env.events();
    assert_eq!(upserts(&ev).len(), 1);
    let list = env.handle.list(&env.scope).await.unwrap();
    assert_eq!(list.items[0].path, a.to_string_lossy());
    assert_eq!(list.items[0].edit_count, 2);

    // Same bytes rewritten (new mtime): no edit, no reorder, no event.
    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(&a, "two").unwrap();
    env.write_now("sess-a", &a).await;
    assert!(env.events().is_empty());
    let list = env.handle.list(&env.scope).await.unwrap();
    assert_eq!(list.items[0].path, a.to_string_lossy());
    assert_eq!(list.items[0].edit_count, 2);
    assert_eq!(list.items[0].size, Some(3));
}

#[tokio::test]
async fn created_flag_and_display_path() {
    let mut env = Env::new().await;
    let doc = env.file(&env.root.join("docs/plan.md"), "p");
    let shot = env.file(&env.out("shot.png"), "png");
    env.write_now("sess-a", &doc).await;
    env.write_now("sess-a", &shot).await;
    let ev = env.events();
    let ServerEvent::ArtifactUpserted { rows, scope_id, .. } = upserts(&ev)[0].clone() else {
        unreachable!()
    };
    assert_eq!(scope_id, "wt-1");
    assert!(rows.iter().all(|r| r.created));
    let list = env.handle.list(&env.scope).await.unwrap();
    let plan = list.items.iter().find(|r| r.in_repo).unwrap();
    assert_eq!(plan.display_path, "docs/plan.md");
    let png = list.items.iter().find(|r| !r.in_repo).unwrap();
    // UI display collapses the macOS /private aliases.
    let shown = shot.to_string_lossy().replacen("/private", "", 1);
    assert_eq!(
        png.display_path,
        if shot.starts_with("/private") {
            shown
        } else {
            shot.to_string_lossy().into_owned()
        }
    );
    assert_eq!(png.state, ArtifactState::Ok);
}

#[tokio::test]
async fn ineligible_and_denied_effects_record_nothing() {
    let mut env = Env::with_sessions(&["sess-a"]).await;
    let src = env.file(&env.root.join("src/main.rs"), "fn main(){}");
    let nm = env.file(&env.root.join("node_modules/p/readme.md"), "x");
    let secret = env.file(&env.out("id_rsa"), "key");
    let dotenv = env.file(&env.out(".env"), "A=1");
    let gone = env.out("never-written.md");
    for p in [&src, &nm, &secret, &dotenv, &gone] {
        env.record("sess-a", p);
    }
    env.handle.drain_now().await;
    assert!(env.events().is_empty());
    assert_eq!(env.handle.list(&env.scope).await.unwrap().total, 0);
}

#[tokio::test]
async fn two_sessions_one_file_one_row_with_writers_newest_first() {
    let env = Env::with_sessions(&["a", "b", "c", "d", "e", "f"]).await;
    let f = env.file(&env.out("shared.md"), "v0");
    env.write_now("a", &f).await;
    env.write_now("b", &f).await;
    let list = env.handle.list(&env.scope).await.unwrap();
    assert_eq!(list.items.len(), 1);
    assert_eq!(list.items[0].writers, vec!["b", "a"]);
    for s in ["c", "d", "e", "f"] {
        env.write_now(s, &f).await;
    }
    let list = env.handle.list(&env.scope).await.unwrap();
    assert_eq!(
        list.items[0].writers,
        vec!["f", "e", "d", "c", "b"],
        "sixth writer evicts the oldest"
    );
    assert_eq!(list.items[0].edit_count, 1, "writers alone are not edits");
}

#[tokio::test]
async fn writers_union_inside_one_coalescing_window() {
    let env = Env::with_sessions(&["a", "b"]).await;
    let f = env.file(&env.out("w.md"), "x");
    env.record("a", &f);
    env.record("b", &f);
    env.record("a", &f);
    env.handle.drain_now().await;
    let list = env.handle.list(&env.scope).await.unwrap();
    assert_eq!(list.items.len(), 1);
    assert_eq!(
        list.items[0].writers,
        vec!["a", "b"],
        "last toucher first, both present"
    );

    // A fresh file written by a then b in ONE window: [b, a].
    let g = env.file(&env.out("g.md"), "y");
    env.record("a", &g);
    env.record("b", &g);
    env.handle.drain_now().await;
    let list = env.handle.list(&env.scope).await.unwrap();
    let row = list
        .items
        .iter()
        .find(|r| r.path == g.to_string_lossy())
        .unwrap();
    assert_eq!(row.writers, vec!["b", "a"]);
}

#[tokio::test]
async fn move_then_write_in_one_window_applies_both() {
    let env = Env::with_sessions(&["a", "b"]).await;
    let x = env.file(&env.out("x.md"), "content");
    env.write_now("a", &x).await;
    let id = env.handle.list(&env.scope).await.unwrap().items[0]
        .id
        .clone();
    env.handle.pin(&id, true).await.unwrap();

    let y = env.out("y.md");
    std::fs::rename(&x, &y).unwrap();
    env.handle.record(
        env.ctx("a"),
        vec![FileEffect::moved(x.to_string_lossy(), y.to_string_lossy())],
    );
    env.record("b", &y);
    env.handle.drain_now().await;

    let list = env.handle.list(&env.scope).await.unwrap();
    assert_eq!(list.items.len(), 1, "moved in place, not a second row");
    let row = &list.items[0];
    assert_eq!(row.id, id);
    assert_eq!(row.path, y.to_string_lossy());
    assert!(row.pinned);
    assert_eq!(row.edit_count, 1);
    assert_eq!(row.writers[0], "b");
    assert!(row.writers.contains(&"a".to_string()));
}

#[tokio::test]
async fn cap_drops_oldest_unpinned_and_reports_ids() {
    let mut env = Env::new().await;
    let total = ARTIFACT_CAP as usize + 5;
    let files: Vec<_> = (0..total)
        .map(|i| env.file(&env.out(&format!("f{i:04}.md")), &format!("c{i}")))
        .collect();
    for f in &files[..10] {
        env.record("sess-a", f);
    }
    env.handle.drain_now().await;
    let first = env.handle.list(&env.scope).await.unwrap();
    // Pin the 3 oldest rows.
    let pinned: Vec<String> = first
        .items
        .iter()
        .rev()
        .take(3)
        .map(|r| r.id.clone())
        .collect();
    for id in &pinned {
        env.handle.pin(id, true).await.unwrap();
    }
    let _ = env.events();
    for f in &files[10..] {
        env.record("sess-a", f);
    }
    env.handle.drain_now().await;
    let list = env.handle.list(&env.scope).await.unwrap();
    assert_eq!(list.total, ARTIFACT_CAP);
    assert_eq!(list.items.len(), ARTIFACT_CAP as usize);
    for id in &pinned {
        assert!(
            list.items.iter().any(|r| &r.id == id),
            "pinned rows survive the cap"
        );
    }
    let ev = env.events();
    let dropped: Vec<String> = ev
        .iter()
        .filter_map(|e| match e {
            ServerEvent::ArtifactRemoved { ids, reason, .. }
                if *reason == ArtifactRemoveReason::Cap =>
            {
                Some(ids.clone())
            }
            _ => None,
        })
        .flatten()
        .collect();
    assert_eq!(dropped.len(), 5);
    // The dropped five are the oldest unpinned: files 3..8.
    for d in &dropped {
        assert!(!list.items.iter().any(|r| &r.id == d));
    }
    let survivors: Vec<_> = list.items.iter().map(|r| r.path.clone()).collect();
    for f in &files[3..8] {
        assert!(!survivors.contains(&f.to_string_lossy().into_owned()));
    }
    assert!(survivors.contains(&files[8].to_string_lossy().into_owned()));
    // The broadcast never names a dropped row as upserted afterwards.
    let ups: Vec<_> = ev
        .iter()
        .filter_map(|e| match e {
            ServerEvent::ArtifactUpserted { rows, .. } => Some(rows.clone()),
            _ => None,
        })
        .flatten()
        .collect();
    assert!(ups.iter().all(|u| !dropped.contains(&u.row.id)));
}

#[tokio::test]
async fn remove_hides_until_written_again() {
    let mut env = Env::new().await;
    let f = env.file(&env.out("r.md"), "1");
    env.write_now("sess-a", &f).await;
    let id = env.handle.list(&env.scope).await.unwrap().items[0]
        .id
        .clone();
    let _ = env.events();
    env.handle.remove(&id).await.unwrap();
    assert!(env.handle.remove(&id).await.is_err());
    let ev = env.events();
    assert!(ev.iter().any(|e| matches!(
        e,
        ServerEvent::ArtifactRemoved {
            reason: ArtifactRemoveReason::Removed,
            ..
        }
    )));
    let list = env.handle.list(&env.scope).await.unwrap();
    assert!(list.items.is_empty());
    assert_eq!(list.total, 1, "hidden rows count toward the cap");
    assert!(matches!(
        env.handle.read_content(&id).await,
        vst_artifacts::ReadOutcome::NotFound
    ));
    std::fs::write(&f, "2").unwrap();
    env.write_now("sess-a", &f).await;
    let list = env.handle.list(&env.scope).await.unwrap();
    assert_eq!(list.items.len(), 1);
    assert_eq!(list.items[0].id, id, "same row comes back");
    let ev = env.events();
    let created = ev.iter().any(|e| matches!(e, ServerEvent::ArtifactUpserted { rows, .. } if rows.iter().any(|r| r.created)));
    assert!(created, "a revived row is announced as new to the list");
}

#[tokio::test]
async fn shutdown_drains_pending_intake_before_abort() {
    let env = Env::new().await;
    let f = env.file(&env.out("late.md"), "z");
    env.record("sess-a", &f);
    // No start(): the effect is only in the intake. Shutdown must persist it.
    env.handle.shutdown(std::time::Duration::from_secs(1)).await;
    let reopened = vst_store::StoreHandle::open(&env.db_path).unwrap();
    let rows = reopened.list_artifacts(&env.scope).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].path, f.to_string_lossy());
}

#[tokio::test]
async fn started_workers_apply_and_broadcast_without_manual_drains() {
    let mut env = Env::new().await;
    let task = env.handle.start();
    let f = env.file(&env.out("auto.md"), "z");
    env.record("sess-a", &f);
    let got = tokio::time::timeout(std::time::Duration::from_millis(900), async {
        loop {
            match env.rx.recv().await {
                Ok(ServerEvent::ArtifactUpserted { rows, .. }) => break rows,
                Ok(_) => {}
                Err(e) => panic!("{e}"),
            }
        }
    })
    .await
    .expect("upsert event within 900 ms");
    assert_eq!(got.len(), 1);
    task.abort();
}
