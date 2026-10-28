//! `comments` (incl. held rows): schema (no FK), pins that are
//! max+1 of the scope's live rows (restarting at 1 when it is empty), caps, idempotent create and restore, attach leases, and the
//! consumer-side takes (hold / schedule / immediate Terminal row).

use rusqlite::Connection;
use vst_store::comment_consumers::{
    Consumer, HeldFilter, HoldSpec, ScheduleSpec, StoredHold, TakeLimits,
};
use vst_store::comments::CreateOutcome;
use vst_store::schema::ensure_schema;
use vst_store::StoreHandle;
use vst_types::artifacts::ScopeKey;
use vst_types::review::{
    AnchorState, CommentSurface, PathKind, PayloadState, RestoreReason, ReviewComment,
    ReviewCommentSnapshot, ReviewError, ReviewRecord, MAX_COMMENTS,
};

const T0: &str = "2026-01-01T00:00:00.000Z";
const LIMITS: TakeLimits = TakeLimits {
    max_comments: 200,
    max_bytes: 131_072,
};

fn scope() -> ScopeKey {
    ScopeKey::worktree("wt-1")
}

fn open() -> (StoreHandle, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vst.db")).unwrap();
    (store, dir)
}

fn comment(scope: &ScopeKey, id: &str, path: &str, line: u32) -> ReviewComment {
    ReviewComment {
        id: id.to_string(),
        scope_kind: scope.scope_kind,
        scope_id: scope.scope_id.clone(),
        pin: 0,
        path: path.to_string(),
        path_kind: PathKind::Repo,
        surface: CommentSurface::File,
        diff_scope: None,
        base_sha: None,
        side: None,
        line_start: Some(line),
        line_end: Some(line),
        old_start: None,
        old_end: None,
        new_start: None,
        new_end: None,
        quote: format!("quote {id}"),
        prefix: "pre".into(),
        suffix: "suf".into(),
        occurrence: 1,
        text: format!("text {id}"),
        anchor: AnchorState::Anchored,
        anchor_reason: None,
        current: None,
        moved_from: None,
        attached_to: None,
        restored_reason: None,
        block_bytes: 40,
        version: 1,
        created_at: String::new(),
        updated_at: String::new(),
    }
}

async fn create(
    store: &StoreHandle,
    s: &ScopeKey,
    id: &str,
    path: &str,
    line: u32,
) -> ReviewComment {
    match store
        .create_comment(comment(s, id, path, line), None, T0)
        .await
        .unwrap()
    {
        CreateOutcome::Created(c) | CreateOutcome::Existing(c) => c,
        other => panic!("unexpected {other:?}"),
    }
}

fn ids(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn tables_have_no_foreign_keys_and_a_unique_pin_index() {
    let conn = Connection::open_in_memory().unwrap();
    ensure_schema(&conn).unwrap();
    ensure_schema(&conn).unwrap(); // idempotent
    let sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name = 'comments'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        !sql.contains("REFERENCES"),
        "comments must have no FK: {sql}"
    );
    for col in ["heldBy", "heldSession", "heldTurn", "heldAt"] {
        assert!(sql.contains(col), "missing {col}");
    }
    let ledger: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name = 'comment_turn_holds'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(ledger, 0, "the hold ledger table is gone");
    let insert = |id: &str, pin: i64| {
        conn.execute(
            "INSERT INTO comments (id, scopeKind, scopeId, pin, path, pathKind, surface, quote, text, createdAt, updatedAt) \
             VALUES (?1, 'worktree', 'w', ?2, 'a', 'repo', 'file', 'q', 't', 't', 't')",
            rusqlite::params![id, pin],
        )
    };
    insert("a", 1).unwrap();
    assert!(
        insert("b", 1).is_err(),
        "UNIQUE(scope, pin) among live rows"
    );
    // A held row is outside the index: a live row may reuse its pin.
    conn.execute("UPDATE comments SET heldBy = 'h' WHERE id = 'a'", [])
        .unwrap();
    insert("b", 1).unwrap();
}

#[tokio::test]
async fn pins_are_highest_existing_plus_one_and_restart_after_a_send() {
    let (store, _d) = open();
    let s = scope();
    let a = create(&store, &s, "a", "f.rs", 1).await;
    let b = create(&store, &s, "b", "f.rs", 2).await;
    let c = create(&store, &s, "c", "f.rs", 3).await;
    assert_eq!((a.pin, b.pin, c.pin), (1, 2, 3));
    // Deleting the highest frees its number (nothing higher exists).
    store.delete_comment("c").await.unwrap().unwrap();
    assert_eq!(create(&store, &s, "d", "f.rs", 4).await.pin, 3);
    // Send/consume all three: the scope is empty, numbering restarts at 1.
    take_all(&store, &s, &["a", "b", "d"], "h1").await;
    assert_eq!(store.next_comment_pin(&s).await.unwrap(), 1);
    assert_eq!(create(&store, &s, "e", "f.rs", 5).await.pin, 1);
    // Another scope has its own numbering.
    let other = ScopeKey::project("p-1");
    assert_eq!(create(&store, &other, "x", "f.rs", 1).await.pin, 1);
}

async fn take_all(
    store: &StoreHandle,
    s: &ScopeKey,
    names: &[&str],
    hold: &str,
) -> Vec<ReviewCommentSnapshot> {
    store
        .take_for_consumer(
            s,
            &ids(names),
            None,
            "main",
            LIMITS,
            Consumer::Hold(HoldSpec {
                hold_id: hold.into(),
                session_id: "s1".into(),
                turn_id: "t1".into(),
                created_at: T0.into(),
            }),
        )
        .await
        .unwrap()
        .unwrap()
        .snapshots
        .to_vec()
}

#[tokio::test]
async fn a_remaining_high_pin_keeps_numbering_going_up() {
    let (store, _d) = open();
    let s = scope();
    for (i, n) in ["a", "b", "c", "d", "e"].iter().enumerate() {
        create(&store, &s, n, "f.rs", i as u32).await;
    }
    take_all(&store, &s, &["a", "b", "c", "d"], "h1").await; // pin 5 remains
    assert_eq!(create(&store, &s, "f", "f.rs", 9).await.pin, 6);
}

#[tokio::test]
async fn restore_of_a_consumed_comment_with_a_taken_pin_gets_max_plus_one() {
    let (store, _d) = open();
    let s = scope();
    create(&store, &s, "a", "f.rs", 1).await;
    create(&store, &s, "b", "f.rs", 2).await;
    take_all(&store, &s, &["a", "b"], "h1").await;
    let new = create(&store, &s, "n", "f.rs", 3).await;
    assert_eq!(new.pin, 1);
    let (_, back) = store
        .restore_hold("h1", RestoreReason::TurnCancelled, T0)
        .await
        .unwrap()
        .unwrap();
    // a (pin 1) collides with the new comment -> max+1 = 2; b's pin 2 is then taken -> 3.
    let pins: std::collections::HashMap<_, _> =
        back.iter().map(|c| (c.id.clone(), c.pin)).collect();
    assert_eq!(pins["a"], 2);
    assert_eq!(pins["b"], 3);
    assert_eq!(store.get_comment("n").await.unwrap().unwrap().pin, 1);
    let all = store.list_comments(&s, None, false).await.unwrap();
    let mut p: Vec<u32> = all.iter().map(|c| c.pin).collect();
    p.sort_unstable();
    assert_eq!(p, [1, 2, 3], "unique, nothing duplicated or lost");
}

#[tokio::test]
async fn concurrent_creates_get_unique_pins() {
    let (store, _d) = open();
    let s = scope();
    let mut tasks = Vec::new();
    for n in 0..40 {
        let (store, s) = (store.clone(), s.clone());
        tasks.push(tokio::spawn(async move {
            create(&store, &s, &format!("c{n}"), "f.rs", n).await.pin
        }));
    }
    let mut pins = Vec::new();
    for t in tasks {
        pins.push(t.await.unwrap());
    }
    pins.sort_unstable();
    assert_eq!(pins, (1..=40).collect::<Vec<u32>>());
}

#[tokio::test]
async fn the_501st_comment_is_refused_but_restore_still_inserts() {
    let (store, _d) = open();
    let s = scope();
    for n in 0..MAX_COMMENTS {
        create(&store, &s, &format!("c{n}"), "f.rs", n as u32).await;
    }
    let out = store
        .create_comment(comment(&s, "extra", "f.rs", 9), None, T0)
        .await
        .unwrap();
    assert_eq!(out, CreateOutcome::CapReached);
    // Restore ignores the cap (a restore never loses comments).
    let snap = comment(&s, "restored", "g.rs", 1);
    let mut snap = snap.to_snapshot();
    snap.pin = 900;
    let back = store
        .restore_comments(&s, &[snap], RestoreReason::SendFailed, T0)
        .await
        .unwrap();
    assert_eq!(back.len(), 1);
    assert_eq!(
        store.list_comments(&s, None, false).await.unwrap().len(),
        MAX_COMMENTS + 1
    );
}

#[tokio::test]
async fn create_is_idempotent_by_id_and_scoped() {
    let (store, _d) = open();
    let s = scope();
    let first = create(&store, &s, "a", "f.rs", 1).await;
    let mut dup = comment(&s, "a", "f.rs", 1);
    dup.text = "changed".into();
    match store.create_comment(dup, None, T0).await.unwrap() {
        CreateOutcome::Existing(c) => assert_eq!(c, first),
        other => panic!("{other:?}"),
    }
    let other_scope = ScopeKey::worktree("wt-2");
    let out = store
        .create_comment(comment(&other_scope, "a", "f.rs", 1), None, T0)
        .await
        .unwrap();
    assert_eq!(out, CreateOutcome::IdTaken);
    assert_eq!(store.list_comments(&s, None, false).await.unwrap().len(), 1);
}

#[tokio::test]
async fn restore_pin_is_used_only_when_free() {
    let (store, _d) = open();
    let s = scope();
    create(&store, &s, "a", "f.rs", 1).await; // pin 1
    create(&store, &s, "b", "f.rs", 2).await; // pin 2
    store.delete_comment("a").await.unwrap();
    let back = match store
        .create_comment(comment(&s, "a2", "f.rs", 1), Some(1), T0)
        .await
        .unwrap()
    {
        CreateOutcome::Created(c) => c,
        o => panic!("{o:?}"),
    };
    assert_eq!(back.pin, 1);
    // Pin 2 is taken: a fresh pin is allocated instead.
    let fresh = match store
        .create_comment(comment(&s, "b2", "f.rs", 2), Some(2), T0)
        .await
        .unwrap()
    {
        CreateOutcome::Created(c) => c,
        o => panic!("{o:?}"),
    };
    assert_eq!(fresh.pin, 3);
    // A free pin above the highest is kept as-is (it is free).
    let free = match store
        .create_comment(comment(&s, "z", "f.rs", 9), Some(99), T0)
        .await
        .unwrap()
    {
        CreateOutcome::Created(c) => c,
        o => panic!("{o:?}"),
    };
    assert_eq!(free.pin, 99);
}

#[tokio::test]
async fn patch_bumps_version_and_a_deleted_comment_is_not_found() {
    let (store, _d) = open();
    let s = scope();
    create(&store, &s, "a", "f.rs", 1).await;
    let c = store
        .update_comment_text("a", "new text", 50, "2026-01-01T00:00:05.000Z")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (c.text.as_str(), c.version, c.block_bytes),
        ("new text", 2, 50)
    );
    store.delete_comment("a").await.unwrap().unwrap();
    assert!(store
        .update_comment_text("a", "x", 1, T0)
        .await
        .unwrap()
        .is_none());
    assert!(store.delete_comment("a").await.unwrap().is_none());
}

#[tokio::test]
async fn list_orders_by_path_line_pin_and_filters() {
    let (store, _d) = open();
    let s = scope();
    create(&store, &s, "a", "b.rs", 5).await;
    create(&store, &s, "b", "a.rs", 20).await;
    create(&store, &s, "c", "a.rs", 3).await;
    let all = store.list_comments(&s, None, false).await.unwrap();
    assert_eq!(
        all.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        ["c", "b", "a"]
    );
    assert_eq!(
        store
            .list_comments(&s, Some("b.rs"), false)
            .await
            .unwrap()
            .len(),
        1
    );
    store
        .attach_comments(&s, "session:s1", Some(&ids(&["a"])), T0)
        .await
        .unwrap();
    assert_eq!(store.list_comments(&s, None, true).await.unwrap().len(), 2);
}

#[tokio::test]
async fn restore_keeps_pins_is_idempotent_and_detaches() {
    let (store, _d) = open();
    let s = scope();
    create(&store, &s, "a", "f.rs", 1).await;
    create(&store, &s, "b", "f.rs", 2).await;
    store
        .attach_comments(&s, "session:s1", None, T0)
        .await
        .unwrap();
    let rows = store.list_comments(&s, None, false).await.unwrap();
    let snaps: Vec<_> = rows.iter().map(ReviewComment::to_snapshot).collect();
    let taken = store
        .take_for_consumer(
            &s,
            &ids(&["a", "b"]),
            Some("session:s1"),
            "main",
            LIMITS,
            Consumer::Hold(HoldSpec {
                hold_id: "h1".into(),
                session_id: "s1".into(),
                turn_id: "t1".into(),
                created_at: T0.into(),
            }),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(taken.snapshots.len(), 2);
    assert!(store
        .list_comments(&s, None, false)
        .await
        .unwrap()
        .is_empty());

    let (_, back) = store
        .restore_hold(
            "h1",
            RestoreReason::TurnCancelled,
            "2026-01-01T00:01:00.000Z",
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(back.iter().map(|c| c.pin).collect::<Vec<_>>(), [1, 2]);
    assert!(store
        .restore_hold("h1", RestoreReason::SendFailed, T0)
        .await
        .unwrap()
        .is_none());
    for c in &back {
        assert_eq!(c.attached_to, None, "restore always detaches");
        assert_eq!(c.restored_reason, Some(RestoreReason::TurnCancelled));
    }
    // Idempotent: a second restore inserts nothing and changes nothing.
    let again = store
        .restore_comments(&s, &snaps, RestoreReason::SendFailed, T0)
        .await
        .unwrap();
    assert!(again.is_empty());
    let now = store.list_comments(&s, None, false).await.unwrap();
    assert_eq!(now.len(), 2);
    assert_eq!(now[0].restored_reason, Some(RestoreReason::TurnCancelled));
    // The next pin follows the live rows.
    assert_eq!(create(&store, &s, "c", "f.rs", 3).await.pin, 3);
    // Dismissing clears the notice and reports the changed rows.
    let cleared = store.dismiss_restored(&s).await.unwrap();
    assert_eq!(cleared.len(), 2);
    assert!(cleared.iter().all(|c| c.restored_reason.is_none()));
}

#[tokio::test]
async fn restore_never_overwrites_a_live_comment_with_the_same_pin() {
    let (store, _d) = open();
    let s = scope();
    let live = create(&store, &s, "live", "f.rs", 1).await;
    let mut snap = comment(&s, "gone", "f.rs", 1).to_snapshot();
    snap.pin = live.pin;
    let back = store
        .restore_comments(&s, &[snap], RestoreReason::Restart, T0)
        .await
        .unwrap();
    assert_eq!(back.len(), 1);
    assert_eq!(back[0].pin, 2, "taken pin -> max+1, no duplicate");
    assert_eq!(
        store.get_comment("live").await.unwrap().unwrap().text,
        "text live"
    );
}

#[tokio::test]
async fn attach_moves_between_composers_and_leases_expire() {
    let (store, _d) = open();
    let s = scope();
    for (i, id) in ["a", "b", "c"].iter().enumerate() {
        create(&store, &s, id, "f.rs", i as u32).await;
    }
    let out = store
        .attach_comments(&s, "session:one", None, "2026-01-01T00:00:00.000Z")
        .await
        .unwrap();
    assert_eq!(out.changed.len(), 3);
    // Same key again: a refresh, no change events.
    let again = store
        .attach_comments(&s, "session:one", None, "2026-01-01T00:10:00.000Z")
        .await
        .unwrap();
    assert!(again.changed.is_empty());
    assert_eq!(again.attached.len(), 3);
    // Another composer takes some of them.
    let moved = store
        .attach_comments(
            &s,
            "session:two",
            Some(&ids(&["a"])),
            "2026-01-01T00:11:00.000Z",
        )
        .await
        .unwrap();
    assert_eq!(moved.changed.len(), 1);
    assert_eq!(moved.changed[0].attached_to.as_deref(), Some("session:two"));
    // refresh never adds.
    assert_eq!(
        store
            .refresh_lease(&s, "session:one", "2026-01-01T00:20:00.000Z")
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        store.refresh_lease(&s, "session:nobody", T0).await.unwrap(),
        0
    );
    // Expiry detaches only stale leases (a: 00:11, b/c: 00:20).
    let expired = store
        .expire_leases("2026-01-01T00:15:00.000Z")
        .await
        .unwrap();
    assert_eq!(
        expired.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        ["a"]
    );
    // Detach by composer, then everywhere.
    let det = store
        .detach_comments(&s, Some("session:one"), Some(&ids(&["b"])))
        .await
        .unwrap();
    assert_eq!(det.len(), 1);
    let rest = store.detach_composer("session:one").await.unwrap();
    assert_eq!(
        rest.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        ["c"]
    );
    assert!(store.list_comments(&s, None, true).await.unwrap().len() == 3);
}

#[tokio::test]
async fn take_validates_ids_composer_and_size() {
    let (store, _d) = open();
    let s = scope();
    create(&store, &s, "a", "f.rs", 1).await;
    create(&store, &s, "b", "f.rs", 2).await;
    let hold = |n: &str| {
        Consumer::Hold(HoldSpec {
            hold_id: n.into(),
            session_id: "s1".into(),
            turn_id: format!("t-{n}"),
            created_at: T0.into(),
        })
    };
    // Unknown id => Changed with the remaining count; nothing deleted.
    let r = store
        .take_for_consumer(&s, &ids(&["a", "ghost"]), None, "main", LIMITS, hold("h0"))
        .await
        .unwrap();
    assert_eq!(r.unwrap_err(), ReviewError::Changed { remaining: 1 });
    assert_eq!(store.list_comments(&s, None, false).await.unwrap().len(), 2);
    // Attached elsewhere => NotAttached, and a chip send needs the right key.
    store
        .attach_comments(&s, "session:b", Some(&ids(&["b"])), T0)
        .await
        .unwrap();
    let r = store
        .take_for_consumer(&s, &ids(&["b"]), None, "main", LIMITS, hold("h1"))
        .await
        .unwrap();
    assert_eq!(r.unwrap_err(), ReviewError::NotAttached);
    let r = store
        .take_for_consumer(
            &s,
            &ids(&["b"]),
            Some("session:a"),
            "main",
            LIMITS,
            hold("h1"),
        )
        .await
        .unwrap();
    assert_eq!(r.unwrap_err(), ReviewError::NotAttached);
    let r = store
        .take_for_consumer(
            &s,
            &ids(&["a"]),
            Some("session:a"),
            "main",
            LIMITS,
            hold("h1"),
        )
        .await
        .unwrap();
    assert_eq!(
        r.unwrap_err(),
        ReviewError::NotAttached,
        "unattached ids need no composer"
    );
    // Too many / too big => nothing deleted.
    let tiny = TakeLimits {
        max_comments: 1,
        max_bytes: 131_072,
    };
    let r = store
        .take_for_consumer(&s, &ids(&["a", "b"]), None, "main", tiny, hold("h2"))
        .await
        .unwrap();
    assert!(matches!(
        r.unwrap_err(),
        ReviewError::NotAttached | ReviewError::TooLarge { .. }
    ));
    store.detach_comments(&s, None, None).await.unwrap();
    let r = store
        .take_for_consumer(&s, &ids(&["a", "b"]), None, "main", tiny, hold("h2"))
        .await
        .unwrap();
    assert_eq!(
        r.unwrap_err(),
        ReviewError::TooLarge {
            limit: 1,
            unit: "comments"
        }
    );
    let small = TakeLimits {
        max_comments: 200,
        max_bytes: 100,
    };
    let r = store
        .take_for_consumer(&s, &ids(&["a", "b"]), None, "main", small, hold("h2"))
        .await
        .unwrap();
    assert_eq!(
        r.unwrap_err(),
        ReviewError::TooLarge {
            limit: 100,
            unit: "bytes"
        }
    );
    assert_eq!(store.list_comments(&s, None, false).await.unwrap().len(), 2);
    assert!(store.get_hold("h2").await.unwrap().is_none());
}

#[tokio::test]
async fn take_for_hold_is_idempotent_by_hold_id_and_remove_has_one_winner() {
    let (store, _d) = open();
    let s = scope();
    create(&store, &s, "a", "f.rs", 1).await;
    let spec = || {
        Consumer::Hold(HoldSpec {
            hold_id: "h1".into(),
            session_id: "s1".into(),
            turn_id: "t1".into(),
            created_at: T0.into(),
        })
    };
    let first = store
        .take_for_consumer(&s, &ids(&["a"]), None, "main", LIMITS, spec())
        .await
        .unwrap()
        .unwrap();
    assert!(!first.existing);
    assert_eq!(first.deleted, ["a"]);
    // A retry with the same hold id takes nothing and reports the stored snapshot.
    let retry = store
        .take_for_consumer(&s, &ids(&["a"]), None, "main", LIMITS, spec())
        .await
        .unwrap()
        .unwrap();
    assert!(retry.existing && retry.deleted.is_empty());
    assert_eq!(retry.snapshots, first.snapshots);
    let hold = store.get_hold("h1").await.unwrap().unwrap();
    assert_eq!(
        (
            hold.session_id.as_str(),
            hold.turn_id.as_str(),
            hold.record.name.as_str()
        ),
        ("s1", "t1", ""),
        "the name is not stored: it is rendered from the in-memory turn"
    );
    assert!(store.rehome_hold("h1", "s2", "t2").await.unwrap());
    assert_eq!(store.list_holds(Some("s2")).await.unwrap().len(), 1);
    assert!(store.list_holds(Some("s1")).await.unwrap().is_empty());
    let (a, b) = tokio::join!(store.remove_hold("h1"), store.remove_hold("h1"));
    assert_eq!(
        [a.unwrap().is_some(), b.unwrap().is_some()]
            .iter()
            .filter(|x| **x)
            .count(),
        1
    );
    assert!(store.get_hold("h1").await.unwrap().is_none());
}

fn spec(id: &str, session: &str, channel: &str) -> ScheduleSpec {
    ScheduleSpec {
        id: id.into(),
        session_id: session.into(),
        message: "please look".into(),
        fire_at: T0.into(),
        now: T0.into(),
        channel: Some(channel.into()),
        attachments: None,
    }
}

#[tokio::test]
async fn immediate_terminal_row_is_claimed_waiting_and_one_per_session() {
    let (store, _d) = open();
    let s = scope();
    for (i, id) in ["a", "b", "c"].iter().enumerate() {
        create(&store, &s, id, "f.rs", i as u32).await;
    }
    // A waiting schedule row of the session must not block, only be counted.
    store
        .take_for_consumer(
            &s,
            &ids(&["c"]),
            None,
            "main",
            LIMITS,
            Consumer::Schedule(spec("sched-1", "s1", "tmux")),
        )
        .await
        .unwrap()
        .unwrap();
    store
        .claim_scheduled_message("sched-1", "s1", T0)
        .await
        .unwrap();
    store
        .mark_scheduled_phase("sched-1", None, "waiting", T0)
        .await
        .unwrap();

    let taken = store
        .take_for_terminal_row(
            &s,
            &ids(&["a"]),
            None,
            "main",
            LIMITS,
            spec("td-1", "s1", "tmux"),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(taken.waits_behind, Some(1));
    let row = store.get_scheduled_message("td-1").await.unwrap().unwrap();
    assert_eq!(row.origin.as_deref(), Some("immediate"));
    assert_eq!(row.channel.as_deref(), Some("tmux"));
    assert_eq!(row.message, "please look");
    assert!(row.claimed_at.is_some());
    assert_eq!(row.delivery_phase.as_deref(), Some("waiting"));
    // Second send to the same session: InFlight, nothing taken.
    let r = store
        .take_for_terminal_row(
            &s,
            &ids(&["b"]),
            None,
            "main",
            LIMITS,
            spec("td-2", "s1", "tmux"),
        )
        .await
        .unwrap();
    assert_eq!(r.unwrap_err(), ReviewError::InFlight);
    assert!(store.get_scheduled_message("td-2").await.unwrap().is_none());
    assert!(store.get_comment("b").await.unwrap().is_some());
    // The same id again is a Duplicate, another session is free.
    let r = store
        .take_for_terminal_row(
            &s,
            &ids(&["b"]),
            None,
            "main",
            LIMITS,
            spec("td-1", "s1", "tmux"),
        )
        .await
        .unwrap();
    assert_eq!(r.unwrap_err(), ReviewError::Duplicate);
    store
        .take_for_terminal_row(
            &s,
            &ids(&["b"]),
            None,
            "main",
            LIMITS,
            spec("td-3", "s2", "tmux"),
        )
        .await
        .unwrap()
        .unwrap();
    // Listing: both immediate rows of the scope, none of the schedule row.
    let rows = store.list_immediate_rows(&s).await.unwrap();
    assert_eq!(
        rows.iter().map(|r| r.row_id.as_str()).collect::<Vec<_>>(),
        ["td-1", "td-3"]
    );
    assert_eq!(rows[0].waits_behind, 1);
    assert_eq!(rows[0].payload.comments.len(), 1);
    assert_eq!(
        store.claimed_immediate_ids().await.unwrap(),
        ["td-1", "td-3"]
    );
    assert!(store
        .list_immediate_rows(&ScopeKey::project("other"))
        .await
        .unwrap()
        .is_empty());
    assert!(store.delete_scheduled_message("td-1").await.unwrap());
    assert!(!store.delete_scheduled_message("td-1").await.unwrap());
}

#[tokio::test]
async fn payload_state_flips_and_held_snapshot_listing_is_filtered() {
    let (store, _d) = open();
    let s = scope();
    for (i, id) in ["a", "b", "c", "d"].iter().enumerate() {
        create(&store, &s, id, "f.rs", i as u32).await;
    }
    let take = |id: &str, row: &str, session: &str, channel: &str| {
        let store = store.clone();
        let s = s.clone();
        let (id, row, session, channel) = (
            id.to_string(),
            row.to_string(),
            session.to_string(),
            channel.to_string(),
        );
        async move {
            store
                .take_for_consumer(
                    &s,
                    &[id],
                    None,
                    "main",
                    LIMITS,
                    Consumer::Schedule(spec(&row, &session, &channel)),
                )
                .await
                .unwrap()
                .unwrap();
        }
    };
    take("a", "r-json", "s1", "json").await;
    take("b", "r-tmux", "s1", "tmux").await;
    take("c", "r-other", "s2", "json").await;
    take("d", "r-orphan", "ghost", "json").await;

    let s1 = store
        .list_held_snapshots(HeldFilter::Session("s1"))
        .await
        .unwrap();
    assert_eq!(
        s1.iter().map(|h| h.row_id.as_str()).collect::<Vec<_>>(),
        ["r-json"],
        "tmux rows are not listed"
    );
    assert_eq!(s1[0].payload.state, PayloadState::Held);

    // Flip held -> adopted only from held; a second flip is a no-op.
    assert!(store
        .set_payload_state("r-json", PayloadState::Adopted, Some(&[PayloadState::Held]))
        .await
        .unwrap());
    assert!(!store
        .set_payload_state("r-json", PayloadState::Adopted, Some(&[PayloadState::Held]))
        .await
        .unwrap());
    assert!(!store
        .set_payload_state(
            "r-json",
            PayloadState::Restored,
            Some(&[PayloadState::Held])
        )
        .await
        .unwrap());
    assert!(store
        .list_held_snapshots(HeldFilter::Session("s1"))
        .await
        .unwrap()
        .is_empty());
    assert!(!store
        .set_payload_state("missing", PayloadState::Restored, None)
        .await
        .unwrap());

    // Claimed rows: only those with claimedAt.
    store
        .claim_scheduled_message("r-other", "s2", T0)
        .await
        .unwrap();
    let claimed = store
        .list_held_snapshots(HeldFilter::Claimed)
        .await
        .unwrap();
    assert_eq!(
        claimed
            .iter()
            .map(|h| h.row_id.as_str())
            .collect::<Vec<_>>(),
        ["r-other"]
    );
}

#[tokio::test]
async fn adopting_a_snapshot_into_a_hold_flips_the_row_in_the_same_transaction() {
    let (store, _d) = open();
    let s = scope();
    create(&store, &s, "a", "f.rs", 1).await;
    let taken = store
        .take_for_consumer(
            &s,
            &ids(&["a"]),
            None,
            "main",
            LIMITS,
            Consumer::Schedule(spec("r1", "s1", "json")),
        )
        .await
        .unwrap()
        .unwrap();
    store
        .insert_hold(
            StoredHold {
                hold_id: "h1".into(),
                scope: s.clone(),
                session_id: "s1".into(),
                turn_id: "t1".into(),
                record: ReviewRecord {
                    name: "main".into(),
                    comments: taken.snapshots,
                },
                created_at: T0.into(),
            },
            Some("r1"),
        )
        .await
        .unwrap();
    assert!(store.get_hold("h1").await.unwrap().is_some());
    assert!(store
        .list_held_snapshots(HeldFilter::Session("s1"))
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn purges_remove_comments_and_holds_and_refuse_without_projects() {
    let (store, _d) = open();
    let s = scope();
    create(&store, &s, "a", "f.rs", 1).await;
    create(&store, &s, "b", "f.rs", 2).await;
    store
        .take_for_consumer(
            &s,
            &ids(&["b"]),
            None,
            "main",
            LIMITS,
            Consumer::Hold(HoldSpec {
                hold_id: "h".into(),
                session_id: "s1".into(),
                turn_id: "t".into(),
                created_at: T0.into(),
            }),
        )
        .await
        .unwrap()
        .unwrap();
    // No projects at all: the orphan purge refuses.
    assert_eq!(store.purge_orphan_comments().await.unwrap(), 0);
    assert_eq!(store.list_comments(&s, None, false).await.unwrap().len(), 1);
    assert_eq!(
        store.purge_scope_comments(&s).await.unwrap(),
        2,
        "the held row is purged too"
    );
    assert!(store
        .list_comments(&s, None, false)
        .await
        .unwrap()
        .is_empty());
    assert!(store.get_hold("h").await.unwrap().is_none());
    assert_eq!(
        store.next_comment_pin(&s).await.unwrap(),
        1,
        "pins restart with the scope"
    );
}

/// Seed one comment and one hold for `s` (hold takes comment `<tag>-b`).
async fn seed_with_hold(store: &StoreHandle, s: &ScopeKey, tag: &str) {
    create(store, s, &format!("{tag}-a"), "f.rs", 1).await;
    let b = format!("{tag}-b");
    create(store, s, &b, "f.rs", 2).await;
    store
        .take_for_consumer(
            s,
            &[b],
            None,
            "main",
            LIMITS,
            Consumer::Hold(HoldSpec {
                hold_id: format!("{tag}-hold"),
                session_id: "s1".into(),
                turn_id: "t".into(),
                created_at: T0.into(),
            }),
        )
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn purging_a_worktree_or_project_scope_removes_only_its_comments_and_holds() {
    let (store, _d) = open();
    let (wt, proj, keep) = (
        ScopeKey::worktree("wt-1"),
        ScopeKey::project("p-1"),
        ScopeKey::worktree("wt-keep"),
    );
    seed_with_hold(&store, &wt, "w").await;
    seed_with_hold(&store, &proj, "p").await;
    seed_with_hold(&store, &keep, "k").await;
    assert_eq!(store.purge_scope_comments(&wt).await.unwrap(), 2);
    assert_eq!(store.purge_scope_comments(&proj).await.unwrap(), 2);
    for (s, hold) in [(&wt, "w-hold"), (&proj, "p-hold")] {
        assert!(store
            .list_comments(s, None, false)
            .await
            .unwrap()
            .is_empty());
        assert!(store.get_hold(hold).await.unwrap().is_none());
    }
    assert_eq!(
        store.list_comments(&keep, None, false).await.unwrap().len(),
        1
    );
    assert!(store.get_hold("k-hold").await.unwrap().is_some());
}

#[tokio::test]
async fn orphan_purge_sweeps_deleted_worktrees_and_projects_but_keeps_live_ones() {
    let (store, _d) = open();
    store
        .raw_conn()
        .execute_batch(
            "INSERT INTO projects (id, absolutePath, prefix, isGit, createdAt) VALUES ('p-live', '/x', 'x', 0, 't');
             INSERT INTO worktrees (id, projectId, branch, createdAt, sortOrder) VALUES ('wt-live', 'p-live', 'b', 't', 0);",
        )
        .unwrap();
    let live = [ScopeKey::worktree("wt-live"), ScopeKey::project("p-live")];
    let dead = [ScopeKey::worktree("wt-dead"), ScopeKey::project("p-dead")];
    for (i, s) in live.iter().chain(dead.iter()).enumerate() {
        seed_with_hold(&store, s, &format!("s{i}")).await;
    }
    assert_eq!(store.purge_orphan_comments().await.unwrap(), 4);
    for (i, s) in live.iter().enumerate() {
        assert_eq!(store.list_comments(s, None, false).await.unwrap().len(), 1);
        assert!(store
            .get_hold(&format!("s{i}-hold"))
            .await
            .unwrap()
            .is_some());
    }
    for (i, s) in dead.iter().enumerate() {
        assert!(store
            .list_comments(s, None, false)
            .await
            .unwrap()
            .is_empty());
        let hold = format!("s{}-hold", i + 2);
        assert!(store.get_hold(&hold).await.unwrap().is_none());
    }
}

#[tokio::test]
async fn anchor_updates_never_bump_version_and_only_report_real_changes() {
    use vst_store::comments::AnchorUpdate;
    use vst_types::review::{AnchorReason, LineSpan};
    let (store, _d) = open();
    let s = scope();
    let c = create(&store, &s, "c1", "a.rs", 3).await;
    let same = AnchorUpdate {
        id: "c1".into(),
        path: "a.rs".into(),
        moved_from: None,
        anchor: AnchorState::Anchored,
        reason: None,
        current: None,
    };
    assert!(store
        .apply_anchor_updates(vec![same])
        .await
        .unwrap()
        .is_empty());

    let moved = AnchorUpdate {
        id: "c1".into(),
        path: "b.rs".into(),
        moved_from: Some("a.rs".into()),
        anchor: AnchorState::CantCheck,
        reason: Some(AnchorReason::WatchLimit),
        current: Some(LineSpan { start: 7, end: 8 }),
    };
    let changed = store
        .apply_anchor_updates(vec![moved.clone()])
        .await
        .unwrap();
    assert_eq!(changed.len(), 1);
    let row = &changed[0];
    assert_eq!(row.path, "b.rs");
    assert_eq!(row.moved_from.as_deref(), Some("a.rs"));
    assert_eq!(row.anchor, AnchorState::CantCheck);
    assert_eq!(row.anchor_reason, Some(AnchorReason::WatchLimit));
    assert_eq!(row.current, Some(LineSpan { start: 7, end: 8 }));
    assert_eq!(row.version, c.version, "anchor writes never bump version");
    assert_eq!(row.updated_at, c.updated_at);
    // Idempotent, and unknown ids are skipped.
    assert!(store
        .apply_anchor_updates(vec![moved])
        .await
        .unwrap()
        .is_empty());
    let ghost = AnchorUpdate {
        id: "nope".into(),
        path: "x".into(),
        moved_from: None,
        anchor: AnchorState::Outdated,
        reason: None,
        current: None,
    };
    assert!(store
        .apply_anchor_updates(vec![ghost])
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn comment_scopes_lists_each_scope_with_comments_once() {
    let (store, _d) = open();
    let (a, b) = (ScopeKey::worktree("wt-a"), ScopeKey::project("p-1"));
    create(&store, &a, "c1", "a.rs", 1).await;
    create(&store, &a, "c2", "a.rs", 2).await;
    create(&store, &b, "c3", "b.rs", 1).await;
    let mut scopes = store.list_comment_scopes().await.unwrap();
    scopes.sort_by(|x, y| x.scope_id.cmp(&y.scope_id));
    assert_eq!(
        scopes,
        vec![ScopeKey::project("p-1"), ScopeKey::worktree("wt-a")]
    );
}

#[tokio::test]
async fn claimed_filter_skips_rows_that_carry_a_delivery_phase() {
    let (store, _d) = open();
    let s = scope();
    for (i, id) in ["a", "b"].iter().enumerate() {
        create(&store, &s, id, "f.rs", i as u32).await;
    }
    for (c, row) in [("a", "r-flight"), ("b", "r-waiting")] {
        store
            .take_for_consumer(
                &s,
                &[c.to_string()],
                None,
                "main",
                LIMITS,
                Consumer::Schedule(spec(row, "s1", "json")),
            )
            .await
            .unwrap()
            .unwrap();
        store.claim_scheduled_message(row, "s1", T0).await.unwrap();
    }
    // A row a terminal job holds `waiting` (the session became Terminal after the
    // row was made under Rich Chat): recovery re-arms it, so it keeps its comments.
    assert!(store
        .mark_scheduled_phase("r-waiting", None, "waiting", T0)
        .await
        .unwrap());
    let claimed = store
        .list_held_snapshots(HeldFilter::Claimed)
        .await
        .unwrap();
    assert_eq!(
        claimed
            .iter()
            .map(|h| h.row_id.as_str())
            .collect::<Vec<_>>(),
        ["r-flight"]
    );
}
