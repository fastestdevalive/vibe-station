//! Terminal-delivery state of `scheduled_messages`: migration of the new
//! columns (incl. legacy FK-table rebuild), delivery phase CAS, cancel races,
//! boot recovery by phase, origin handling, reset reassignment, pasted list.

use rusqlite::Connection;
use vst_store::{CancelOutcome, RecoveryOutcome, StoreHandle, MAX_PENDING_SCHEDULED};

const T0: &str = "2026-01-01T00:00:00Z";
const T1: &str = "2026-01-01T00:00:01Z";
const T2: &str = "2026-01-01T00:00:02Z";
const DUE: &str = "2026-01-01T00:00:10Z";
const NOW: &str = "2026-01-01T00:01:00Z";
const FUTURE: &str = "2026-01-01T01:00:00Z";
const S: &str = "sess-1";

async fn open() -> (tempfile::TempDir, StoreHandle) {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    (dir, store)
}

/// Insert a tmux row (origin NULL unless given), fire time `fire`.
async fn add(
    store: &StoreHandle,
    id: &str,
    fire: &str,
    created: &str,
    channel: Option<&str>,
    origin: Option<&str>,
) {
    store
        .insert_scheduled_message(
            id,
            S,
            &format!("msg {id}"),
            None,
            fire,
            created,
            channel,
            None,
            origin,
        )
        .await
        .unwrap();
}

/// Claim `id` and put it in `phase` (None leaves phase NULL).
async fn claim_to(store: &StoreHandle, id: &str, phase: Option<&str>) {
    assert!(store
        .claim_scheduled_message(id, S, NOW)
        .await
        .unwrap()
        .is_some());
    if let Some(p) = phase {
        assert!(store.mark_scheduled_phase(id, None, p, NOW).await.unwrap());
    }
}

fn columns(path: &std::path::Path) -> Vec<String> {
    let c = Connection::open(path).unwrap();
    let mut stmt = c.prepare("PRAGMA table_info(scheduled_messages)").unwrap();
    stmt.query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

const NEW_COLS: [&str; 5] = [
    "channel",
    "deliveryPhase",
    "failureKind",
    "commentsSnapshot",
    "origin",
];

fn legacy_table(fk: bool, with_claimed_at: bool) -> String {
    format!(
        "CREATE TABLE scheduled_messages (
           id TEXT PRIMARY KEY,
           sessionId TEXT NOT NULL {fk},
           message TEXT NOT NULL, attachments TEXT, fireAt TEXT NOT NULL,
           createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
           status TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','sent','cancelled','failed')),
           sentAt TEXT, sentTurnId TEXT, failureReason TEXT {claimed}
         );
         INSERT INTO scheduled_messages (id, sessionId, message, fireAt, createdAt, updatedAt)
           VALUES ('old', 'sess-1', 'legacy text', '{FUTURE}', '{T0}', '{T0}');",
        fk = if fk {
            "REFERENCES sessions(id) ON DELETE CASCADE"
        } else {
            ""
        },
        claimed = if with_claimed_at {
            ", claimedAt TEXT"
        } else {
            ""
        },
    )
}

async fn migrates_and_keeps_new_columns(fk: bool, with_claimed_at: bool) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vibe-station.db");
    // Foreign keys off: the legacy FK table points at a `sessions` table the
    // store creates later, exactly as on a real pre-fix database file.
    Connection::open(&path)
        .unwrap()
        .execute_batch(&format!(
            "PRAGMA foreign_keys = OFF; {}",
            legacy_table(fk, with_claimed_at)
        ))
        .unwrap();
    let store = StoreHandle::open(&path).unwrap();

    let cols = columns(&path);
    for c in NEW_COLS.iter().chain(&["claimedAt"]) {
        assert!(cols.iter().any(|x| x == c), "missing {c}: {cols:?}");
    }
    // The legacy row survived and reads with every new field None.
    let old = store.list_pending_scheduled_messages(S).await.unwrap();
    assert_eq!(old.len(), 1);
    let r = &old[0];
    assert_eq!(r.message, "legacy text");
    assert!(r.channel.is_none() && r.delivery_phase.is_none() && r.failure_kind.is_none());
    assert!(r.comments_snapshot.is_none() && r.origin.is_none() && r.claimed_at.is_none());

    // Every new column round-trips on a fresh insert.
    store
        .insert_scheduled_message(
            "new",
            S,
            "x",
            None,
            FUTURE,
            T1,
            Some("tmux"),
            Some(r#"{"comments":[{}]}"#),
            Some("immediate"),
        )
        .await
        .unwrap();
    claim_to(&store, "new", Some("waiting")).await;
    store
        .mark_scheduled_message_failed("new", "boom", Some("timed_out"), NOW)
        .await
        .unwrap();
    let f = &store.list_failed_scheduled_messages(S).await.unwrap()[0];
    assert_eq!(f.channel.as_deref(), Some("tmux"));
    assert_eq!(f.comments_snapshot.as_deref(), Some(r#"{"comments":[{}]}"#));
    assert_eq!(f.origin.as_deref(), Some("immediate"));
    assert_eq!(f.failure_kind.as_deref(), Some("timed_out"));
    assert!(
        f.delivery_phase.is_none() && f.claimed_at.is_none(),
        "failure clears phase + claim"
    );
    // Opening again is idempotent.
    drop(store);
    StoreHandle::open(&path).unwrap();
}

#[tokio::test]
async fn t1_db_without_the_new_columns_migrates() {
    migrates_and_keeps_new_columns(false, true).await;
}

#[tokio::test]
async fn t1b_legacy_fk_table_is_rebuilt_and_keeps_all_five_new_columns() {
    // The FK rebuild copies a fixed column list, so the new columns must be
    // added AFTER it. This legacy table also predates `claimedAt`.
    migrates_and_keeps_new_columns(true, false).await;
    migrates_and_keeps_new_columns(true, true).await;
}

#[tokio::test]
async fn t2_same_instant_rows_claim_in_created_then_id_order() {
    let (_d, store) = open().await;
    add(&store, "z", DUE, T0, None, None).await;
    add(&store, "b", DUE, T1, None, None).await;
    add(&store, "a", DUE, T1, None, None).await;
    let mut order = vec![];
    while let Some(r) = store
        .claim_next_due_scheduled_message(NOW, &[])
        .await
        .unwrap()
    {
        order.push(r.id);
    }
    assert_eq!(order, ["z", "a", "b"]);
}

#[tokio::test]
async fn t3_recovery_is_keyed_on_delivery_phase() {
    let (_d, store) = open().await;
    add(&store, "json", DUE, T0, None, None).await;
    add(&store, "wait", DUE, T0, Some("tmux"), Some("schedule")).await;
    add(&store, "paste", DUE, T0, Some("tmux"), None).await;
    add(&store, "nophase", DUE, T0, Some("tmux"), None).await;
    add(&store, "iwait", DUE, T0, Some("tmux"), Some("immediate")).await;
    add(&store, "ipaste", DUE, T0, Some("tmux"), Some("immediate")).await;
    add(&store, "future", FUTURE, T0, Some("tmux"), None).await;
    claim_to(&store, "json", None).await;
    claim_to(&store, "wait", Some("waiting")).await;
    claim_to(&store, "paste", Some("pasting")).await;
    claim_to(&store, "nophase", None).await;
    claim_to(&store, "iwait", Some("waiting")).await;
    claim_to(&store, "ipaste", Some("pasting")).await;

    let mut out = store
        .recover_orphaned_scheduled_messages(NOW)
        .await
        .unwrap();
    for v in [
        &mut out.rearmed,
        &mut out.failed_mid_paste,
        &mut out.failed_other_tmux,
    ] {
        v.sort();
    }
    assert_eq!(
        out,
        RecoveryOutcome {
            rearmed: vec!["wait".into()],
            failed_mid_paste: vec!["ipaste".into(), "paste".into()],
            failed_other_tmux: vec!["iwait".into(), "nophase".into()],
        }
    );

    // The re-armed row is a plain pending row again; the Send-now claim set its
    // fireAt to the claim time.
    let pending = store.list_pending_scheduled_messages(S).await.unwrap();
    let wait = pending.iter().find(|r| r.id == "wait").unwrap();
    assert!(wait.claimed_at.is_none() && wait.delivery_phase.is_none());
    assert_eq!(wait.fire_at, NOW);
    assert_eq!(pending.len(), 2, "wait + future: {pending:?}");

    let failed = store.list_failed_scheduled_messages(S).await.unwrap();
    let kind = |id: &str| {
        let r = failed.iter().find(|r| r.id == id).unwrap();
        (r.failure_kind.clone(), r.failure_reason.clone().unwrap())
    };
    assert_eq!(failed.len(), 5);
    assert_eq!(kind("json").0, None, "a json row keeps legacy NULL kind");
    assert!(kind("json").1.contains("being delivered"));
    assert_eq!(kind("nophase").0.as_deref(), Some("error"));
    assert!(
        kind("nophase").1.contains("being delivered"),
        "today's text"
    );
    assert_eq!(kind("paste").0.as_deref(), Some("restarted_mid_paste"));
    assert_eq!(kind("ipaste").0.as_deref(), Some("restarted_mid_paste"));
    assert_eq!(kind("iwait").0.as_deref(), Some("error"));
    assert!(kind("iwait").1.contains("before this was pasted"));
    // Second boot finds nothing left to recover.
    assert_eq!(
        store
            .recover_orphaned_scheduled_messages(NOW)
            .await
            .unwrap(),
        RecoveryOutcome::default()
    );
}

#[tokio::test]
async fn t4_pending_list_includes_waiting_and_pasting_but_not_claimed_json() {
    let (_d, store) = open().await;
    for id in ["sched", "wait", "paste", "json"] {
        add(
            &store,
            id,
            DUE,
            T0,
            Some(if id == "json" { "json" } else { "tmux" }),
            None,
        )
        .await;
    }
    claim_to(&store, "wait", Some("waiting")).await;
    claim_to(&store, "paste", Some("pasting")).await;
    claim_to(&store, "json", None).await;
    let list = store.list_pending_scheduled_messages(S).await.unwrap();
    let mut ids: Vec<&str> = list.iter().map(|r| r.id.as_str()).collect();
    ids.sort();
    assert_eq!(ids, ["paste", "sched", "wait"]);
    let snap = store.read_schedule_snapshot(S).await.unwrap();
    assert_eq!(snap.pending.len(), 3);
}

#[tokio::test]
async fn t5_cancel_and_phase_change_have_exactly_one_winner() {
    let (_d, store) = open().await;
    add(&store, "r", DUE, T0, Some("tmux"), None).await;
    claim_to(&store, "r", Some("waiting")).await;
    // A cancel while waiting wins; the phase change then loses.
    assert_eq!(
        store.cancel_scheduled_message("r", S).await.unwrap(),
        CancelOutcome::Deleted
    );
    assert!(!store
        .mark_scheduled_phase("r", Some("waiting"), "pasting", NOW)
        .await
        .unwrap());

    // A phase change first wins; the cancel then reports InFlight and the row stays.
    add(&store, "p", DUE, T0, Some("tmux"), None).await;
    claim_to(&store, "p", Some("waiting")).await;
    assert!(store
        .mark_scheduled_phase("p", Some("waiting"), "pasting", NOW)
        .await
        .unwrap());
    assert_eq!(
        store.cancel_scheduled_message("p", S).await.unwrap(),
        CancelOutcome::InFlight
    );
    assert_eq!(
        store
            .list_pending_scheduled_messages(S)
            .await
            .unwrap()
            .len(),
        1
    );
    // A wrong `from` phase never matches (waiting->pasting only once).
    assert!(!store
        .mark_scheduled_phase("p", Some("waiting"), "pasting", NOW)
        .await
        .unwrap());

    // A claimed json row (phase NULL) cannot be cancelled.
    add(&store, "j", DUE, T0, Some("json"), None).await;
    claim_to(&store, "j", None).await;
    assert_eq!(
        store.cancel_scheduled_message("j", S).await.unwrap(),
        CancelOutcome::NotFound
    );
    assert_eq!(
        store.cancel_scheduled_message("nope", S).await.unwrap(),
        CancelOutcome::NotFound
    );
    // An unclaimed pending row still cancels.
    add(&store, "u", FUTURE, T0, Some("tmux"), None).await;
    assert_eq!(
        store.cancel_scheduled_message("u", S).await.unwrap(),
        CancelOutcome::Deleted
    );

    // Racing for real: across many rows each race has exactly one winner.
    for i in 0..25 {
        let id = format!("race{i}");
        add(&store, &id, DUE, T0, Some("tmux"), None).await;
        claim_to(&store, &id, Some("waiting")).await;
        let (s1, s2, id1, id2) = (store.clone(), store.clone(), id.clone(), id.clone());
        let phase = tokio::spawn(async move {
            s1.mark_scheduled_phase(&id1, Some("waiting"), "pasting", NOW)
                .await
                .unwrap()
        });
        let cancel = tokio::spawn(async move {
            s2.cancel_scheduled_message(&id2, S).await.unwrap() == CancelOutcome::Deleted
        });
        let (phase, cancel) = (phase.await.unwrap(), cancel.await.unwrap());
        assert!(phase ^ cancel, "race {i}: phase={phase} cancel={cancel}");
    }
}

#[tokio::test]
async fn t6_retry_of_a_pasting_then_failed_row_clears_phase_claim_and_kind() {
    let (_d, store) = open().await;
    add(&store, "a", DUE, T0, Some("tmux"), None).await;
    claim_to(&store, "a", Some("waiting")).await;
    assert!(store
        .mark_scheduled_phase("a", Some("waiting"), "pasting", NOW)
        .await
        .unwrap());
    assert!(store
        .mark_scheduled_message_failed("a", "tmux broke", Some("error"), NOW)
        .await
        .unwrap());
    assert!(store
        .retry_failed_scheduled_message("a", S, NOW)
        .await
        .unwrap());
    let r = &store.list_pending_scheduled_messages(S).await.unwrap()[0];
    assert!(r.delivery_phase.is_none() && r.claimed_at.is_none() && r.failure_kind.is_none());
    assert!(r.failure_reason.is_none());
    assert_eq!(r.fire_at, NOW);
}

#[tokio::test]
async fn t7_pasting_marks_sent_and_prunes_to_the_cap() {
    let (_d, store) = open().await;
    // Only a `pasting` row can be pasted.
    add(&store, "x", DUE, T0, Some("tmux"), None).await;
    claim_to(&store, "x", Some("waiting")).await;
    assert!(!store.mark_scheduled_message_pasted("x", NOW).await.unwrap());
    store.cancel_scheduled_message("x", S).await.unwrap();

    for i in 0..205 {
        let id = format!("p{i:03}");
        add(&store, &id, DUE, T0, Some("tmux"), None).await;
        claim_to(&store, &id, Some("waiting")).await;
        assert!(store
            .mark_scheduled_phase(&id, Some("waiting"), "pasting", NOW)
            .await
            .unwrap());
        let sent_at = format!("2026-01-01T00:{:02}:{:02}Z", 10 + i / 60, i % 60);
        assert!(store
            .mark_scheduled_message_pasted(&id, &sent_at)
            .await
            .unwrap());
    }
    let kept = store
        .list_recent_pasted(S, "2000-01-01T00:00:00Z", 1000)
        .await
        .unwrap();
    assert_eq!(kept.len(), 200);
    assert_eq!(kept[0].id, "p204", "newest first");
    assert!(kept
        .iter()
        .all(|r| r.status == "sent" && r.sent_turn_id.is_none()));
    assert!(kept
        .iter()
        .all(|r| r.claimed_at.is_none() && r.delivery_phase.is_none()));
}

#[tokio::test]
async fn t8_origin_immediate_does_not_count_toward_the_cap_but_is_listed() {
    let (_d, store) = open().await;
    for i in 0..(MAX_PENDING_SCHEDULED - 1) {
        let origin = if i % 2 == 0 { None } else { Some("schedule") };
        add(
            &store,
            &format!("s{i:03}"),
            FUTURE,
            T0,
            Some("tmux"),
            origin,
        )
        .await;
    }
    for i in 0..5 {
        add(
            &store,
            &format!("i{i}"),
            FUTURE,
            T0,
            Some("tmux"),
            Some("immediate"),
        )
        .await;
    }
    assert_eq!(
        store.count_pending_schedule_rows(S).await.unwrap(),
        MAX_PENDING_SCHEDULED - 1
    );
    add(&store, "last", FUTURE, T0, Some("tmux"), Some("schedule")).await;
    assert_eq!(
        store.count_pending_schedule_rows(S).await.unwrap(),
        MAX_PENDING_SCHEDULED
    );

    let snap = store.read_schedule_snapshot(S).await.unwrap();
    assert_eq!(
        snap.pending.len(),
        MAX_PENDING_SCHEDULED as usize + 5,
        "snapshot lists immediate rows too"
    );
    let imm: Vec<_> = snap
        .pending
        .iter()
        .filter(|r| r.origin.as_deref() == Some("immediate"))
        .collect();
    assert_eq!(imm.len(), 5);
}

#[tokio::test]
async fn t9_list_recent_pasted_only_returns_terminal_pastes_in_the_window() {
    let (_d, store) = open().await;
    let since = "2026-01-01T00:30:00Z";
    for (id, sent_at) in [
        ("fresh", "2026-01-01T00:40:00Z"),
        ("stale", "2026-01-01T00:10:00Z"),
    ] {
        add(&store, id, DUE, T0, Some("tmux"), None).await;
        claim_to(&store, id, Some("waiting")).await;
        store
            .mark_scheduled_phase(id, Some("waiting"), "pasting", NOW)
            .await
            .unwrap();
        assert!(store
            .mark_scheduled_message_pasted(id, sent_at)
            .await
            .unwrap());
    }
    // A Rich Chat delivery has a sentTurnId and is never listed as "pasted".
    add(&store, "turn", DUE, T0, Some("json"), None).await;
    claim_to(&store, "turn", None).await;
    store
        .mark_scheduled_message_sent("turn", "t-1", "2026-01-01T00:41:00Z")
        .await
        .unwrap();

    let rows = store.list_recent_pasted(S, since, 3).await.unwrap();
    assert_eq!(
        rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        ["fresh"]
    );
    // The snapshot field uses the live clock: these 2026 rows are outside it.
    assert!(store
        .read_schedule_snapshot(S)
        .await
        .unwrap()
        .pasted
        .is_empty());
}

#[tokio::test]
async fn t9b_snapshot_pasted_uses_the_last_ten_minutes_and_caps_at_three() {
    let (_d, store) = open().await;
    let now: String = Connection::open_in_memory()
        .unwrap()
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now')", [], |r| {
            r.get(0)
        })
        .unwrap();
    for i in 0..5 {
        let id = format!("p{i}");
        add(&store, &id, DUE, T0, Some("tmux"), None).await;
        claim_to(&store, &id, Some("waiting")).await;
        store
            .mark_scheduled_phase(&id, Some("waiting"), "pasting", NOW)
            .await
            .unwrap();
        store
            .mark_scheduled_message_pasted(&id, &now)
            .await
            .unwrap();
    }
    add(&store, "old", DUE, T0, Some("tmux"), None).await;
    claim_to(&store, "old", Some("waiting")).await;
    store
        .mark_scheduled_phase("old", Some("waiting"), "pasting", NOW)
        .await
        .unwrap();
    store
        .mark_scheduled_message_pasted("old", T2)
        .await
        .unwrap();
    let snap = store.read_schedule_snapshot(S).await.unwrap();
    assert_eq!(snap.pasted.len(), 3);
    assert!(snap.pasted.iter().all(|r| r.id != "old"));
    assert!(snap.sent_turn_ids.is_empty());
}

#[tokio::test]
async fn t10_reassign_moves_waiting_rows_but_not_pasting_or_immediate_ones() {
    let (_d, store) = open().await;
    add(&store, "sched", FUTURE, T0, Some("tmux"), None).await;
    add(&store, "wait", DUE, T0, Some("tmux"), None).await;
    add(&store, "paste", DUE, T0, Some("tmux"), None).await;
    add(
        &store,
        "ipending",
        FUTURE,
        T0,
        Some("tmux"),
        Some("immediate"),
    )
    .await;
    add(&store, "iwait", DUE, T0, Some("tmux"), Some("immediate")).await;
    add(&store, "ifailed", DUE, T0, Some("tmux"), Some("immediate")).await;
    add(&store, "failed", DUE, T0, Some("tmux"), None).await;
    claim_to(&store, "wait", Some("waiting")).await;
    claim_to(&store, "paste", Some("pasting")).await;
    claim_to(&store, "iwait", Some("waiting")).await;
    claim_to(&store, "ifailed", Some("waiting")).await;
    claim_to(&store, "failed", Some("waiting")).await;
    store
        .mark_scheduled_message_failed("ifailed", "x", Some("archived"), NOW)
        .await
        .unwrap();
    store
        .mark_scheduled_message_failed("failed", "x", Some("error"), NOW)
        .await
        .unwrap();

    let moved = store
        .reassign_scheduled_messages(S, "sess-2", NOW)
        .await
        .unwrap();
    assert_eq!(moved, 3, "sched, wait, failed");

    let new_pending = store
        .list_pending_scheduled_messages("sess-2")
        .await
        .unwrap();
    let wait = new_pending.iter().find(|r| r.id == "wait").unwrap();
    assert!(
        wait.claimed_at.is_none() && wait.delivery_phase.is_none(),
        "cleared in the same UPDATE"
    );
    let mut ids: Vec<_> = new_pending.iter().map(|r| r.id.clone()).collect();
    ids.sort();
    assert_eq!(ids, ["sched", "wait"]);
    assert_eq!(
        store
            .list_failed_scheduled_messages("sess-2")
            .await
            .unwrap()
            .len(),
        1
    );

    let mut old: Vec<_> = store
        .list_pending_scheduled_messages(S)
        .await
        .unwrap()
        .into_iter()
        .map(|r| r.id)
        .collect();
    old.sort();
    assert_eq!(old, ["ipending", "iwait", "paste"]);
    let old_failed = store.list_failed_scheduled_messages(S).await.unwrap();
    assert_eq!(
        old_failed.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        ["ifailed"]
    );
}

#[tokio::test]
async fn t10b_failing_a_cancelled_row_reports_false_and_rearm_is_guarded() {
    let (_d, store) = open().await;
    add(&store, "gone", DUE, T0, Some("tmux"), None).await;
    claim_to(&store, "gone", Some("waiting")).await;
    store.cancel_scheduled_message("gone", S).await.unwrap();
    assert!(!store
        .mark_scheduled_message_failed("gone", "x", Some("error"), NOW)
        .await
        .unwrap());

    // rearm: a waiting schedule row goes back, an immediate or pasting row never does.
    add(&store, "w", DUE, T0, Some("tmux"), None).await;
    add(&store, "i", DUE, T0, Some("tmux"), Some("immediate")).await;
    add(&store, "p", DUE, T0, Some("tmux"), None).await;
    claim_to(&store, "w", Some("waiting")).await;
    claim_to(&store, "i", Some("waiting")).await;
    claim_to(&store, "p", Some("pasting")).await;
    assert!(store.rearm_scheduled_message("w", NOW).await.unwrap());
    assert!(
        !store.rearm_scheduled_message("w", NOW).await.unwrap(),
        "no longer held"
    );
    assert!(!store.rearm_scheduled_message("i", NOW).await.unwrap());
    assert!(!store.rearm_scheduled_message("p", NOW).await.unwrap());
}

#[tokio::test]
async fn t11_send_now_claim_sets_fire_at_now_and_a_restart_rearm_is_overdue() {
    let (_d, store) = open().await;
    add(
        &store,
        "later",
        "2099-01-01T00:00:00Z",
        T0,
        Some("tmux"),
        Some("schedule"),
    )
    .await;

    let claimed = store
        .claim_scheduled_message("later", S, NOW)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claimed.fire_at, NOW);
    let reread = store.get_scheduled_message("later").await.unwrap().unwrap();
    assert_eq!(reread.fire_at, NOW);

    assert!(store
        .mark_scheduled_phase("later", None, "waiting", NOW)
        .await
        .unwrap());
    let out = store
        .recover_orphaned_scheduled_messages(NOW)
        .await
        .unwrap();
    assert_eq!(out.rearmed, vec!["later".to_string()]);
    let row = store.get_scheduled_message("later").await.unwrap().unwrap();
    assert!(row.claimed_at.is_none());
    assert_eq!(row.fire_at, NOW);

    let due = store
        .claim_next_due_scheduled_message("2026-01-01T00:01:01Z", &[])
        .await
        .unwrap();
    assert_eq!(due.map(|r| r.id), Some("later".to_string()));
}
