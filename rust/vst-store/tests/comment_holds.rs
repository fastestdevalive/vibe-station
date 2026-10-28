//! Held markers on `comments`: a Rich Chat send marks rows `heldBy`, every
//! reader treats them as absent, restore clears the marker (renumbering a taken
//! pin), persist deletes them. Plus the guard that keeps readers filtering.

use vst_store::comment_consumers::{
    Consumer, HeldFilter, HoldSpec, ScheduleSpec, StoredHold, TakeLimits,
};
use vst_store::comments::{AnchorUpdate, CreateOutcome};
use vst_store::StoreHandle;
use vst_types::artifacts::ScopeKey;
use vst_types::review::{
    AnchorState, CommentSurface, PathKind, PayloadState, RestoreReason, ReviewComment, ReviewError,
    ReviewRecord, MAX_COMMENTS,
};

const T0: &str = "2026-01-01T00:00:00.000Z";
const T1: &str = "2026-01-01T00:05:00.000Z";
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

fn comment(scope: &ScopeKey, id: &str, line: u32) -> ReviewComment {
    ReviewComment {
        id: id.to_string(),
        scope_kind: scope.scope_kind,
        scope_id: scope.scope_id.clone(),
        pin: 0,
        path: "f.rs".to_string(),
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

async fn create(store: &StoreHandle, s: &ScopeKey, id: &str, line: u32) -> ReviewComment {
    match store
        .create_comment(comment(s, id, line), None, T0)
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

fn hold_spec(id: &str) -> Consumer {
    Consumer::Hold(HoldSpec {
        hold_id: id.into(),
        session_id: "s1".into(),
        turn_id: "t1".into(),
        created_at: T0.into(),
    })
}

async fn take(
    store: &StoreHandle,
    s: &ScopeKey,
    names: &[&str],
    hold: &str,
) -> Result<vst_store::comment_consumers::Taken, ReviewError> {
    store
        .take_for_consumer(s, &ids(names), None, "main", LIMITS, hold_spec(hold))
        .await
        .unwrap()
}

fn held_count(store: &StoreHandle) -> i64 {
    store
        .raw_conn()
        .query_row(
            "SELECT COUNT(*) FROM comments WHERE heldBy IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap()
}

/// The held row `id` as stored: (text, version, attachedTo, path). Read straight
/// from the DB because every store reader re-reads through live-only selects, so
/// a return value cannot show whether an unfiltered UPDATE touched the row.
fn stored(store: &StoreHandle, id: &str) -> (String, i64, Option<String>, String) {
    store
        .raw_conn()
        .query_row(
            "SELECT text, version, attachedTo, path FROM comments \
             WHERE id = ?1 AND heldBy IS NOT NULL",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap()
}

#[tokio::test]
async fn a_held_row_is_invisible_to_every_reader() {
    let (store, _d) = open();
    let s = scope();
    create(&store, &s, "a", 1).await; // pin 1, will be held
    create(&store, &s, "b", 2).await; // pin 2, stays live
    take(&store, &s, &["a"], "h1").await.unwrap();

    assert!(store.get_comment("a").await.unwrap().is_none());
    let listed = store.list_comments(&s, None, false).await.unwrap();
    assert_eq!(
        listed.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        ["b"]
    );
    assert!(store
        .list_comments(&s, None, true)
        .await
        .unwrap()
        .iter()
        .all(|c| c.id != "a"));
    assert!(store
        .update_comment_text("a", "x", 1, T1)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        stored(&store, "a"),
        ("text a".into(), 1, None, "f.rs".into()),
        "a stale PATCH did not edit the held row"
    );
    assert!(store.delete_comment("a").await.unwrap().is_none());
    assert_eq!(held_count(&store), 1, "the stale delete did not remove it");

    // attach-all skips it
    let out = store
        .attach_comments(&s, "session:s2", None, T1)
        .await
        .unwrap();
    assert_eq!(out.attached, ["b"]);
    let out = store
        .attach_comments(&s, "session:s2", Some(&ids(&["a"])), T1)
        .await
        .unwrap();
    assert!(out.attached.is_empty() && out.changed.is_empty());
    assert_eq!(
        stored(&store, "a").2,
        None,
        "attach never touched the held row"
    );

    // lease sweeps / channel flips never upsert it (even if a stale lease was set)
    store
        .raw_conn()
        .execute(
            "UPDATE comments SET attachedTo = 'session:s2', attachTouchedAt = '2000-01-01T00:00:00.000Z' WHERE id = 'a'",
            [],
        )
        .unwrap();
    assert!(store
        .expire_leases("2030-01-01T00:00:00.000Z")
        .await
        .unwrap()
        .iter()
        .all(|c| c.id != "a"));
    assert_eq!(
        stored(&store, "a").2.as_deref(),
        Some("session:s2"),
        "the lease sweep left the held row's lease alone"
    );
    assert!(store
        .detach_composer("session:s2")
        .await
        .unwrap()
        .iter()
        .all(|c| c.id != "a"));
    assert_eq!(
        stored(&store, "a").2.as_deref(),
        Some("session:s2"),
        "detaching the composer left the held row attached"
    );
    assert_eq!(store.refresh_lease(&s, "session:s2", T1).await.unwrap(), 0);
    assert!(store.dismiss_restored(&s).await.unwrap().is_empty());

    // re-anchor skips it
    let moved = store
        .apply_anchor_updates(vec![AnchorUpdate {
            id: "a".into(),
            path: "g.rs".into(),
            moved_from: Some("f.rs".into()),
            anchor: AnchorState::Anchored,
            reason: None,
            current: None,
        }])
        .await
        .unwrap();
    assert!(moved.is_empty());
    assert_eq!(
        stored(&store, "a").3,
        "f.rs",
        "re-anchor did not move the held row"
    );

    // pins and the cap ignore it
    assert_eq!(store.next_comment_pin(&s).await.unwrap(), 3);
}

#[tokio::test]
async fn held_rows_do_not_count_toward_the_cap() {
    let (store, _d) = open();
    let s = scope();
    for n in 0..MAX_COMMENTS {
        create(&store, &s, &format!("c{n}"), n as u32).await;
    }
    let big = TakeLimits {
        max_comments: MAX_COMMENTS,
        max_bytes: usize::MAX / 2,
    };
    let all: Vec<String> = (0..MAX_COMMENTS).map(|n| format!("c{n}")).collect();
    store
        .take_for_consumer(&s, &all, None, "main", big, hold_spec("h1"))
        .await
        .unwrap()
        .unwrap();
    let c = store
        .create_comment(comment(&s, "new", 1), None, T1)
        .await
        .unwrap();
    assert!(matches!(c, CreateOutcome::Created(ref c) if c.pin == 1));
}

#[tokio::test]
async fn create_with_a_held_id_is_taken_but_a_live_row_may_reuse_a_held_pin() {
    let (store, _d) = open();
    let s = scope();
    create(&store, &s, "a", 1).await;
    take(&store, &s, &["a"], "h1").await.unwrap();
    let again = store
        .create_comment(comment(&s, "a", 1), None, T1)
        .await
        .unwrap();
    assert_eq!(again, CreateOutcome::IdTaken);
    let b = create(&store, &s, "b", 2).await;
    assert_eq!(b.pin, 1, "pin 1 is free among live rows");
}

#[tokio::test]
async fn scopes_and_purges_see_held_only_scopes() {
    let (store, _d) = open();
    store
        .raw_conn()
        .execute_batch(
            "INSERT INTO projects (id, absolutePath, prefix, isGit, createdAt) VALUES ('p-live', '/x', 'x', 0, 't');",
        )
        .unwrap();
    let (w1, w2) = (
        ScopeKey::worktree("wt-purge"),
        ScopeKey::worktree("wt-orphan"),
    );
    for w in [&w1, &w2] {
        let id = format!("a-{}", w.scope_id);
        create(&store, w, &id, 1).await;
        take(&store, w, &[id.as_str()], &format!("h-{}", w.scope_id))
            .await
            .unwrap();
        assert!(store
            .list_comments(w, None, false)
            .await
            .unwrap()
            .is_empty());
    }
    let scopes = store.list_comment_scopes().await.unwrap();
    assert!(scopes.contains(&w1) && scopes.contains(&w2));
    assert_eq!(store.purge_scope_comments(&w1).await.unwrap(), 1);
    assert_eq!(store.purge_orphan_comments().await.unwrap(), 1);
    assert_eq!(held_count(&store), 0);
}

#[test]
fn every_comments_statement_filters_held_rows_or_is_allowlisted() {
    // (needle in the statement, why it may see held rows)
    const ALLOW: &[&str] = &[
        "DELETE FROM comments WHERE scopeKind = ?1 AND scopeId = ?2", // purge_scope_comments
        "DELETE FROM comments WHERE {ORPHAN}",                        // purge_orphan_comments
        "FROM comments ORDER BY 1, 2",                                // list_comment_scopes
        "DELETE FROM comments WHERE heldBy = ?1",                     // remove_hold
    ];
    // Every source file of the crate: a new module's `FROM comments` is checked too.
    let src_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut sources: Vec<(String, String)> = Vec::new();
    for entry in std::fs::read_dir(&src_dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "rs") {
            sources.push((
                path.file_name().unwrap().to_string_lossy().into_owned(),
                std::fs::read_to_string(&path).unwrap(),
            ));
        }
    }
    let mut bad = Vec::new();
    for (file, src) in &sources {
        for pat in ["FROM comments", "UPDATE comments", "DELETE FROM comments"] {
            for (at, _) in src.match_indices(pat) {
                if pat == "FROM comments" && src[..at].ends_with("DELETE ") {
                    continue; // covered by the DELETE pattern
                }
                let start = at;
                // up to the closing quote of the string literal
                let mut end = at;
                let b = src.as_bytes();
                while end < b.len() && !(b[end] == b'"' && b[end - 1] != b'\\') {
                    end += 1;
                }
                let stmt = &src[start..end];
                // a `format!` literal may continue after the quote on `{LIVE}`; the
                // quote ends the literal, so also accept the `{LIVE}` placeholder.
                // `select_one_any` is exempt by call site, not by a shared suffix: the
                // text just before `FROM comments` must select the held flag
                // (`heldBy IS NOT NULL`), so an unfiltered `... WHERE id = ?1` DELETE or
                // `select_one` cannot hide behind it.
                let selects_held_flag = pat == "FROM comments"
                    && src[at.saturating_sub(40)..at].contains("heldBy IS NOT NULL");
                // Only the WHERE part counts: `SET heldBy = ?2` alone must not
                // satisfy the guard (dropping `AND heldBy IS NULL` has to fail it).
                let where_part = stmt.split_once("WHERE").map(|(_, w)| w).unwrap_or("");
                let ok = where_part.contains("heldBy")
                    || stmt.contains("{LIVE}")
                    || selects_held_flag
                    || ALLOW.iter().any(|a| {
                        let tail = &src[start..(end + 1).min(src.len())];
                        stmt.contains(a) || tail.contains(a)
                    });
                if !ok {
                    bad.push(format!("{file}: {}", stmt.replace('\n', " ")));
                }
            }
        }
    }
    assert!(
        bad.is_empty(),
        "statements missing the live filter: {bad:#?}"
    );
}

#[test]
fn an_existing_db_with_the_old_pin_index_migrates() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vst.db");
    {
        let store = StoreHandle::open(&path).unwrap();
        let c = store.raw_conn();
        c.execute_batch(
            "DROP INDEX idx_comments_scope_pin_live;
             DROP INDEX idx_comments_heldBy;
             ALTER TABLE comments DROP COLUMN heldBy;
             ALTER TABLE comments DROP COLUMN heldSession;
             ALTER TABLE comments DROP COLUMN heldTurn;
             ALTER TABLE comments DROP COLUMN heldAt;
             CREATE UNIQUE INDEX idx_comments_scope_pin ON comments(scopeKind, scopeId, pin);
             INSERT INTO comments (id, scopeKind, scopeId, pin, path, pathKind, surface, quote, text, createdAt, updatedAt)
               VALUES ('old', 'worktree', 'wt-1', 1, 'f.rs', 'repo', 'file', 'q', 't', 't', 't');",
        )
        .unwrap();
    }
    let store = StoreHandle::open(&path).unwrap();
    let rt = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    rt.block_on(async {
        let s = scope();
        assert_eq!(store.list_comments(&s, None, false).await.unwrap().len(), 1);
        take(&store, &s, &["old"], "h1").await.unwrap();
        let b = create(&store, &s, "b", 1).await;
        assert_eq!(b.pin, 1, "live pin 1 beside held pin 1");
    });
    let old: i64 = store
        .raw_conn()
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name = 'idx_comments_scope_pin'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(old, 0, "the full unique index is dropped");
}

#[tokio::test]
async fn send_hides_persist_deletes_and_restore_brings_back() {
    let (store, _d) = open();
    let s = scope();
    create(&store, &s, "a", 1).await;
    create(&store, &s, "b", 2).await;
    create(&store, &s, "c", 3).await;
    let t = take(&store, &s, &["a", "b"], "h1").await.unwrap();
    assert_eq!(t.deleted, ["a", "b"], "event data unchanged");
    assert_eq!(store.list_comments(&s, None, false).await.unwrap().len(), 1);
    // persist
    let hold = store.remove_hold("h1").await.unwrap().unwrap();
    assert_eq!(hold.record.comments.len(), 2);
    assert_eq!(held_count(&store), 0);
    assert_eq!(store.list_comments(&s, None, false).await.unwrap().len(), 1);

    // cancel path
    take(&store, &s, &["c"], "h2").await.unwrap();
    let (h, rows) = store
        .restore_hold("h2", RestoreReason::TurnCancelled, T1)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(h.hold_id, "h2");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].restored_reason, Some(RestoreReason::TurnCancelled));
    assert_eq!(held_count(&store), 0);
}

#[tokio::test]
async fn restore_renumbers_a_taken_pin_and_resets_version_and_updated_at() {
    let (store, _d) = open();
    let s = scope();
    create(&store, &s, "a", 1).await;
    store
        .update_comment_text("a", "edited", 1, T0)
        .await
        .unwrap();
    take(&store, &s, &["a"], "h1").await.unwrap();
    let n = create(&store, &s, "n", 2).await;
    assert_eq!(n.pin, 1);
    let (_, rows) = store
        .restore_hold("h1", RestoreReason::Restart, T1)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(rows[0].pin, 2, "pin 1 was taken: max + 1, tx succeeds");
    assert_eq!(rows[0].version, 1);
    assert_eq!(rows[0].updated_at, T1);
    assert_eq!(rows[0].restored_reason, Some(RestoreReason::Restart));
    assert_eq!(store.get_comment("a").await.unwrap().unwrap().pin, 2);
}

#[tokio::test]
async fn two_takes_of_one_id_and_persist_vs_restore_have_one_winner() {
    let (store, _d) = open();
    let s = scope();
    create(&store, &s, "a", 1).await;
    take(&store, &s, &["a"], "h1").await.unwrap();
    let second = take(&store, &s, &["a"], "h2").await;
    assert!(matches!(second, Err(ReviewError::Changed { .. })));
    assert!(store.get_hold("h2").await.unwrap().is_none());

    let (r1, r2) = tokio::join!(
        store.restore_hold("h1", RestoreReason::TurnCancelled, T1),
        store.restore_hold("h1", RestoreReason::TurnCancelled, T1)
    );
    assert_eq!(
        [r1.unwrap().is_some(), r2.unwrap().is_some()]
            .iter()
            .filter(|x| **x)
            .count(),
        1
    );

    take(&store, &s, &["a"], "h3").await.unwrap();
    let (p, r) = tokio::join!(
        store.remove_hold("h3"),
        store.restore_hold("h3", RestoreReason::TurnCancelled, T1)
    );
    assert_eq!(
        [p.unwrap().is_some(), r.unwrap().is_some()]
            .iter()
            .filter(|x| **x)
            .count(),
        1,
        "persist and cancel: exactly one wins"
    );
}

#[tokio::test]
async fn idempotent_take_reads_the_held_rows_and_takes_nothing() {
    let (store, _d) = open();
    let s = scope();
    create(&store, &s, "a", 1).await;
    create(&store, &s, "b", 2).await;
    let first = take(&store, &s, &["a", "b"], "h1").await.unwrap();
    let retry = take(&store, &s, &["a", "b"], "h1").await.unwrap();
    assert!(retry.existing && retry.deleted.is_empty());
    assert_eq!(retry.snapshots, first.snapshots);
    assert_eq!(held_count(&store), 2);
}

#[tokio::test]
async fn rehome_moves_every_row_and_list_holds_filters_by_session() {
    let (store, _d) = open();
    let s = scope();
    for (i, n) in ["a", "b", "c"].iter().enumerate() {
        create(&store, &s, n, i as u32 + 1).await;
    }
    take(&store, &s, &["a", "b"], "h1").await.unwrap();
    take(&store, &s, &["c"], "h2").await.unwrap();
    assert!(store.rehome_hold("h1", "s2", "t2").await.unwrap());
    assert!(!store.rehome_hold("nope", "s2", "t2").await.unwrap());
    let s2 = store.list_holds(Some("s2")).await.unwrap();
    assert_eq!(s2.len(), 1);
    assert_eq!(
        (
            s2[0].hold_id.as_str(),
            s2[0].turn_id.as_str(),
            s2[0].record.comments.len()
        ),
        ("h1", "t2", 2)
    );
    assert_eq!(store.list_holds(Some("s1")).await.unwrap().len(), 1);
    assert_eq!(store.list_holds(None).await.unwrap().len(), 2);
}

#[tokio::test]
async fn taking_attached_rows_detaches_them() {
    let (store, _d) = open();
    let s = scope();
    create(&store, &s, "a", 1).await;
    store
        .attach_comments(&s, "session:s1", None, T0)
        .await
        .unwrap();
    store
        .take_for_consumer(
            &s,
            &ids(&["a"]),
            Some("session:s1"),
            "main",
            LIMITS,
            hold_spec("h1"),
        )
        .await
        .unwrap()
        .unwrap();
    let attached: i64 = store
        .raw_conn()
        .query_row(
            "SELECT COUNT(*) FROM comments WHERE heldBy IS NOT NULL AND (attachedTo IS NOT NULL OR attachedAt IS NOT NULL OR attachTouchedAt IS NOT NULL)",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(attached, 0);
}

fn sched(id: &str) -> ScheduleSpec {
    ScheduleSpec {
        id: id.into(),
        session_id: "s1".into(),
        message: "m".into(),
        fire_at: T0.into(),
        now: T0.into(),
        channel: Some("json".into()),
        attachments: None,
    }
}

#[tokio::test]
async fn adopt_inserts_held_rows_skips_present_ids_and_restore_flips_the_payload() {
    let (store, _d) = open();
    let s = scope();
    create(&store, &s, "a", 1).await;
    create(&store, &s, "b", 2).await;
    let taken = store
        .take_for_consumer(
            &s,
            &ids(&["a", "b"]),
            None,
            "main",
            LIMITS,
            Consumer::Schedule(sched("r1")),
        )
        .await
        .unwrap()
        .unwrap();
    create(&store, &s, "b", 1).await; // the user re-created "b" while it was scheduled
    let adopted = store
        .insert_hold(
            StoredHold {
                hold_id: "adopt:r1".into(),
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
    assert!(adopted);
    assert_eq!(held_count(&store), 1, "only `a`; live `b` was skipped");
    assert_eq!(store.list_comments(&s, None, false).await.unwrap().len(), 1);
    let (_, rows) = store
        .restore_hold("adopt:r1", RestoreReason::SendFailed, T1)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(rows.len(), 1);

    // Every id skipped: no held rows, the payload still flips adopted -> restored.
    let taken = store
        .take_for_consumer(
            &s,
            &ids(&["a"]),
            None,
            "main",
            LIMITS,
            Consumer::Schedule(sched("r2")),
        )
        .await
        .unwrap()
        .unwrap();
    create(&store, &s, "a", 1).await;
    store
        .insert_hold(
            StoredHold {
                hold_id: "adopt:r2".into(),
                scope: s.clone(),
                session_id: "s1".into(),
                turn_id: "t2".into(),
                record: ReviewRecord {
                    name: "main".into(),
                    comments: taken.snapshots,
                },
                created_at: T0.into(),
            },
            Some("r2"),
        )
        .await
        .unwrap();
    assert!(store
        .restore_hold("adopt:r2", RestoreReason::SendFailed, T1)
        .await
        .unwrap()
        .is_none());
    assert!(
        !store
            .set_payload_state("r2", PayloadState::Restored, Some(&[PayloadState::Adopted]))
            .await
            .unwrap(),
        "already flipped to restored"
    );
    assert!(store
        .list_held_snapshots(HeldFilter::Session("s1"))
        .await
        .unwrap()
        .is_empty());
}

fn payload_state(store: &StoreHandle, row: &str) -> String {
    let raw: String = store
        .raw_conn()
        .query_row(
            "SELECT commentsSnapshot FROM scheduled_messages WHERE id = ?1",
            [row],
            |r| r.get(0),
        )
        .unwrap();
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    v["state"].as_str().unwrap().to_string()
}

fn adopt_hold(
    id: &str,
    s: &ScopeKey,
    snaps: Vec<vst_types::review::ReviewCommentSnapshot>,
) -> StoredHold {
    StoredHold {
        hold_id: format!("adopt:{id}"),
        scope: s.clone(),
        session_id: "s1".into(),
        turn_id: "t1".into(),
        record: ReviewRecord {
            name: "main".into(),
            comments: snaps,
        },
        created_at: T0.into(),
    }
}

async fn schedule_row(
    store: &StoreHandle,
    s: &ScopeKey,
    row: &str,
    comment: &str,
) -> Vec<vst_types::review::ReviewCommentSnapshot> {
    create(store, s, comment, 1).await;
    store
        .take_for_consumer(
            s,
            &ids(&[comment]),
            None,
            "main",
            LIMITS,
            Consumer::Schedule(sched(row)),
        )
        .await
        .unwrap()
        .unwrap()
        .snapshots
}

/// CR-01: a late `restore_hold` after the turn persisted (`remove_hold`) is the
/// losing racer: it finds nothing and must leave the payload `adopted`.
#[tokio::test]
async fn a_late_restore_after_persist_leaves_the_payload_adopted() {
    let (store, _d) = open();
    let s = scope();
    let snaps = schedule_row(&store, &s, "r1", "a").await;
    assert!(store
        .insert_hold(adopt_hold("r1", &s, snaps), Some("r1"))
        .await
        .unwrap());
    assert_eq!(payload_state(&store, "r1"), "adopted");
    assert!(store.remove_hold("adopt:r1").await.unwrap().is_some());
    assert!(store
        .restore_hold("adopt:r1", RestoreReason::TurnCancelled, T1)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        payload_state(&store, "r1"),
        "adopted",
        "comments were delivered"
    );
}

/// CR-02: an adoption in which every id was skipped stores no hold row, so the
/// payload goes straight to `restored` (nothing for boot to find) and a Retry of
/// the failed row can re-hold.
#[tokio::test]
async fn an_adoption_with_every_id_live_again_leaves_the_payload_restored() {
    let (store, _d) = open();
    let s = scope();
    let snaps = schedule_row(&store, &s, "r2", "a").await;
    create(&store, &s, "a", 1).await; // back in the panel while scheduled
    assert!(store
        .insert_hold(adopt_hold("r2", &s, snaps), Some("r2"))
        .await
        .unwrap());
    assert_eq!(held_count(&store), 0);
    assert!(store.list_holds(None).await.unwrap().is_empty());
    assert_eq!(payload_state(&store, "r2"), "restored");
    store.claim_scheduled_message("r2", "s1", T1).await.unwrap();
    store
        .mark_scheduled_message_failed("r2", "boom", None, T1)
        .await
        .unwrap();
    let reheld = store
        .rehold_failed_schedule_row("r2", "main", LIMITS)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reheld, Some(ids(&["a"])));
    assert_eq!(payload_state(&store, "r2"), "held");
}

/// CR-03: a held row with a NULL marker column must not make `list_holds` fail
/// (boot swallows the error and would then see no holds at all).
#[tokio::test]
async fn a_null_marker_column_does_not_hide_other_holds() {
    let (store, _d) = open();
    let s = scope();
    create(&store, &s, "a", 1).await;
    create(&store, &s, "b", 2).await;
    take(&store, &s, &["a"], "h1").await.unwrap();
    take(&store, &s, &["b"], "h2").await.unwrap();
    store
        .raw_conn()
        .execute(
            "UPDATE comments SET heldSession = NULL, heldTurn = NULL, heldAt = NULL WHERE id = 'a'",
            [],
        )
        .unwrap();
    let mut holds = store.list_holds(None).await.unwrap();
    holds.sort_by(|x, y| x.hold_id.cmp(&y.hold_id));
    assert_eq!(
        holds.iter().map(|h| h.hold_id.as_str()).collect::<Vec<_>>(),
        ["h1", "h2"]
    );
    assert_eq!(holds[0].session_id, "");
    assert_eq!(holds[1].session_id, "s1");
    let (_, rows) = store
        .restore_hold("h1", RestoreReason::Restart, T1)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(rows.len(), 1);
}
