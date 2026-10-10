//! Scheduled-send persistence: atomic claim, boot recovery, retry / dismiss.

use vst_store::StoreHandle;
use vst_types::{LifecycleState, ProjectRecord, SessionRecord, SessionType, WorktreeRecord};

fn session(id: &str, project_id: &str, worktree_id: Option<&str>) -> SessionRecord {
    SessionRecord {
        id: id.into(),
        worktree_id: worktree_id.map(|w| w.into()),
        project_id: project_id.into(),
        is_main: worktree_id.is_some(),
        sort_order: 0.0,
        r#type: SessionType::Agent,
        mode_id: Some("m".into()),
        mode_icon: None,
        name: None,
        name_source: None,
        tmux_name: format!("{id}-pane"),
        use_tmux: true,
        channel: None,
        lifecycle: vst_types::SessionLifecycle {
            state: LifecycleState::Idle,
            reason: None,
            last_transition_at: "2024-01-01T00:00:00.000Z".into(),
        },
        transcript_ref: None,
        agent_chat_id: None,
        acp_session_id: None,
        model_override: None,
        pinned_at: None,
        initial_prompt: None,
        archived_at: None,
        handoff_summary: None,
        draft_prompt: None,
        draft_config: None,
        parent_session_id: None,
        superseded_by: None,
        pr: None,
    }
}

fn project(id: &str, worktree_sessions: &[&str], direct_sessions: &[&str]) -> ProjectRecord {
    ProjectRecord {
        id: id.into(),
        absolute_path: format!("/fake/{id}"),
        prefix: id.chars().take(4).collect(),
        is_git: true,
        default_branch: Some("main".into()),
        created_at: "2024-01-01T00:00:00.000Z".into(),
        hidden: None,
        direct_sessions: direct_sessions
            .iter()
            .map(|s| session(s, id, None))
            .collect(),
        direct_session_seq: None,
        worktrees: if worktree_sessions.is_empty() {
            vec![]
        } else {
            vec![WorktreeRecord {
                id: format!("{id}-w1"),
                name: None,
                branch: "b".into(),
                branch_is_placeholder: None,
                base_branch: "main".into(),
                base_sha: "a".repeat(40),
                created_at: "2024-01-01T00:00:00.000Z".into(),
                pinned_at: None,
                hidden_at: None,
                sort_order: 0.0,
                terminal_seq: Some(0),
                agent_seq: Some(0),
                lsp_enabled: None,
                sessions: worktree_sessions
                    .iter()
                    .map(|s| session(s, id, Some(&format!("{id}-w1"))))
                    .collect(),
                open_files: vec![],
            }]
        },
        next_worktree_num: None,
        lsp_enabled: None,
        open_files: vec![],
    }
}

async fn store_with_session(dir: &std::path::Path) -> StoreHandle {
    let store = StoreHandle::open(dir.join("vibe-station.db")).unwrap();
    store
        .add_project(project("proj-1", &[], &["sess-1"]))
        .await
        .unwrap();
    store
}

async fn add(store: &StoreHandle, id: &str, fire_at: &str) {
    store
        .insert_scheduled_message(
            id,
            "sess-1",
            &format!("msg {id}"),
            None,
            fire_at,
            "2026-01-01T00:00:00Z",
        )
        .await
        .unwrap();
}

/// Claim every currently-due row, one at a time (what the poller does).
async fn claim_all_due(
    store: &StoreHandle,
    now: &str,
) -> Vec<vst_types::rest::sessions::ScheduledMessageRow> {
    let mut out = vec![];
    while let Some(row) = store
        .claim_next_due_scheduled_message(now, &[])
        .await
        .unwrap()
    {
        out.push(row);
    }
    out
}

const PAST: &str = "2026-01-01T00:00:10Z";
const NOW: &str = "2026-01-01T00:01:00Z";
const FUTURE: &str = "2026-01-01T01:00:00Z";

#[tokio::test]
async fn claim_returns_each_due_row_once_oldest_first() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_with_session(dir.path()).await;
    add(&store, "b", "2026-01-01T00:00:20Z").await;
    add(&store, "a", PAST).await;
    add(&store, "later", FUTURE).await;

    let first = store
        .claim_next_due_scheduled_message(NOW, &[])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first.id, "a");
    let rest = claim_all_due(&store, NOW).await;
    assert_eq!(
        rest.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        ["b"]
    );
    // Everything due is claimed; the future row is untouched.
    assert!(store
        .claim_next_due_scheduled_message(NOW, &[])
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn a_claimed_row_cannot_be_claimed_again_cancelled_or_edited() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_with_session(dir.path()).await;
    add(&store, "a", PAST).await;
    assert!(store
        .claim_scheduled_message("a", "sess-1", NOW)
        .await
        .unwrap()
        .is_some());

    // "send now" racing the poller (or vice versa) loses.
    assert!(store
        .claim_scheduled_message("a", "sess-1", NOW)
        .await
        .unwrap()
        .is_none());
    assert!(store
        .claim_next_due_scheduled_message(NOW, &[])
        .await
        .unwrap()
        .is_none());
    // In-flight delivery can no longer be cancelled or edited.
    assert!(!store.cancel_scheduled_message("a", "sess-1").await.unwrap());
    assert!(!store
        .reschedule_scheduled_message("a", "sess-1", "2030-01-01T00:00:00Z", NOW)
        .await
        .unwrap());
}

#[tokio::test]
async fn claim_checks_the_owning_session() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_with_session(dir.path()).await;
    add(&store, "a", FUTURE).await;
    assert!(store
        .claim_scheduled_message("a", "other-session", NOW)
        .await
        .unwrap()
        .is_none());
    assert!(store
        .claim_scheduled_message("a", "sess-1", NOW)
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn sent_rows_leave_pending_and_surface_their_turn_ids() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_with_session(dir.path()).await;
    add(&store, "a", PAST).await;
    claim_all_due(&store, NOW).await;
    store
        .mark_scheduled_message_sent("a", "turn-1", NOW)
        .await
        .unwrap();

    assert!(store
        .list_pending_scheduled_messages("sess-1")
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        store.list_sent_scheduled_turn_ids("sess-1").await.unwrap(),
        ["turn-1"]
    );
}

#[tokio::test]
async fn orphaned_claims_fail_visibly_on_boot_and_unclaimed_rows_survive() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_with_session(dir.path()).await;
    add(&store, "mid-delivery", PAST).await;
    add(&store, "overdue", "2026-01-01T00:00:30Z").await;
    add(&store, "future", FUTURE).await;
    // The daemon claimed one row, then died before marking it sent.
    store
        .claim_scheduled_message("mid-delivery", "sess-1", NOW)
        .await
        .unwrap();

    assert_eq!(
        store.fail_orphaned_scheduled_messages(NOW).await.unwrap(),
        1
    );

    let failed = store
        .list_failed_scheduled_messages("sess-1")
        .await
        .unwrap();
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0].id, "mid-delivery");
    assert!(failed[0]
        .failure_reason
        .as_deref()
        .unwrap()
        .contains("restarted"));
    // Rows that never started delivery are still pending and still fire —
    // an overdue one is delivered right after boot.
    let due = claim_all_due(&store, NOW).await;
    assert_eq!(
        due.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        ["overdue"]
    );
    // "overdue" is now in flight (not offered as pending); only "future" waits.
    let waiting = store
        .list_pending_scheduled_messages("sess-1")
        .await
        .unwrap();
    assert_eq!(
        waiting.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        ["future"]
    );
}

#[tokio::test]
async fn failed_rows_can_be_retried_or_dismissed_only_by_their_session() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_with_session(dir.path()).await;
    add(&store, "a", PAST).await;
    add(&store, "b", PAST).await;
    claim_all_due(&store, NOW).await;
    store
        .mark_scheduled_message_failed("a", "boom", NOW)
        .await
        .unwrap();
    store
        .mark_scheduled_message_failed("b", "boom", NOW)
        .await
        .unwrap();

    // Wrong session / non-failed ids are no-ops.
    assert!(!store
        .retry_failed_scheduled_message("a", "other", NOW)
        .await
        .unwrap());
    assert!(!store
        .dismiss_failed_scheduled_message("a", "other")
        .await
        .unwrap());

    assert!(store
        .retry_failed_scheduled_message("a", "sess-1", NOW)
        .await
        .unwrap());
    assert!(store
        .dismiss_failed_scheduled_message("b", "sess-1")
        .await
        .unwrap());
    assert!(store
        .list_failed_scheduled_messages("sess-1")
        .await
        .unwrap()
        .is_empty());

    // The retried row is claimable again, immediately, with its failure cleared.
    let again = claim_all_due(&store, NOW).await;
    assert_eq!(again.len(), 1);
    assert_eq!(again[0].id, "a");
    assert!(again[0].failure_reason.is_none());
    // Not failed any more, so it can't be dismissed/retried a second time.
    assert!(!store
        .dismiss_failed_scheduled_message("a", "sess-1")
        .await
        .unwrap());
}

#[tokio::test]
async fn sent_turn_ids_are_capped_newest_first() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_with_session(dir.path()).await;
    for i in 0..205u32 {
        let id = format!("m{i:03}");
        add(&store, &id, PAST).await;
        store
            .claim_scheduled_message(&id, "sess-1", NOW)
            .await
            .unwrap();
        store
            .mark_scheduled_message_sent(
                &id,
                &format!("t{i:03}"),
                &format!("2026-01-01T00:{:02}:{:02}Z", 2 + i / 60, i % 60),
            )
            .await
            .unwrap();
    }
    let ids = store.list_sent_scheduled_turn_ids("sess-1").await.unwrap();
    assert_eq!(ids.len(), 200);
    assert_eq!(ids[0], "t204", "newest first");
    // The rows themselves are pruned too, not just hidden from the query.
    let conn = rusqlite::Connection::open(dir.path().join("vibe-station.db")).unwrap();
    let sent: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM scheduled_messages WHERE status = 'sent'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(sent, 200);
}

#[tokio::test]
async fn reset_moves_undelivered_rows_to_the_replacement_session_but_not_in_flight_or_sent() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store
        .add_project(project("proj-1", &[], &["sess-1", "sess-2"]))
        .await
        .unwrap();
    for id in ["pending", "failed", "in-flight", "sent"] {
        add(&store, id, FUTURE).await;
    }
    store
        .claim_scheduled_message("failed", "sess-1", NOW)
        .await
        .unwrap();
    store
        .mark_scheduled_message_failed("failed", "boom", NOW)
        .await
        .unwrap();
    store
        .claim_scheduled_message("sent", "sess-1", NOW)
        .await
        .unwrap();
    store
        .mark_scheduled_message_sent("sent", "t1", NOW)
        .await
        .unwrap();
    store
        .claim_scheduled_message("in-flight", "sess-1", NOW)
        .await
        .unwrap();

    assert_eq!(
        store
            .reassign_scheduled_messages("sess-1", "sess-2", NOW)
            .await
            .unwrap(),
        2
    );

    let moved_pending = store
        .list_pending_scheduled_messages("sess-2")
        .await
        .unwrap();
    assert_eq!(
        moved_pending
            .iter()
            .map(|r| r.id.as_str())
            .collect::<Vec<_>>(),
        ["pending"]
    );
    let moved_failed = store
        .list_failed_scheduled_messages("sess-2")
        .await
        .unwrap();
    assert_eq!(
        moved_failed
            .iter()
            .map(|r| r.id.as_str())
            .collect::<Vec<_>>(),
        ["failed"]
    );
    // The in-flight row (still owned by its delivery) and the sent one stay put,
    // and an in-flight row is not offered as an actionable pending message.
    assert!(store
        .list_pending_scheduled_messages("sess-1")
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        store.list_sent_scheduled_turn_ids("sess-1").await.unwrap(),
        ["t1"]
    );
}

#[tokio::test]
async fn only_a_claimed_row_can_be_marked_sent_or_failed() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_with_session(dir.path()).await;
    add(&store, "a", FUTURE).await;
    // Unclaimed: neither transition applies (e.g. a late write after boot recovery).
    store
        .mark_scheduled_message_sent("a", "t1", NOW)
        .await
        .unwrap();
    store
        .mark_scheduled_message_failed("a", "boom", NOW)
        .await
        .unwrap();
    assert_eq!(
        store
            .list_pending_scheduled_messages("sess-1")
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(store
        .list_sent_scheduled_turn_ids("sess-1")
        .await
        .unwrap()
        .is_empty());
    assert!(store
        .list_failed_scheduled_messages("sess-1")
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn pending_list_is_capped() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_with_session(dir.path()).await;
    for i in 0..(vst_store::MAX_PENDING_SCHEDULED + 5) {
        add(&store, &format!("m{i:03}"), FUTURE).await;
    }
    let pending = store
        .list_pending_scheduled_messages("sess-1")
        .await
        .unwrap();
    assert_eq!(pending.len(), vst_store::MAX_PENDING_SCHEDULED as usize);
}

/// Regression: every project save deletes and re-inserts the project's
/// sessions, which (via the old `ON DELETE CASCADE` FK) wiped all pending
/// scheduled messages — adding ANY session, renaming one, etc. lost them.
#[tokio::test]
async fn saving_the_project_does_not_wipe_scheduled_messages() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_with_session(dir.path()).await;
    add(&store, "a", FUTURE).await;
    add(&store, "b", PAST).await;
    store
        .claim_scheduled_message("b", "sess-1", NOW)
        .await
        .unwrap();
    store
        .mark_scheduled_message_sent("b", "t1", NOW)
        .await
        .unwrap();

    // Any mutation re-saves the whole project (sessions deleted + re-inserted).
    store
        .mutate_project("proj-1", |p| {
            p.direct_sessions.push(session("sess-new", "proj-1", None));
            Ok(p.clone())
        })
        .await
        .unwrap();

    let pending = store
        .list_pending_scheduled_messages("sess-1")
        .await
        .unwrap();
    assert_eq!(
        pending.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        ["a"]
    );
    assert_eq!(
        store.list_sent_scheduled_turn_ids("sess-1").await.unwrap(),
        ["t1"]
    );
}

#[tokio::test]
async fn rows_of_deleted_sessions_are_purged_but_live_ones_kept() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_with_session(dir.path()).await;
    add(&store, "live", FUTURE).await;
    store
        .insert_scheduled_message("ghost", "deleted-session", "x", None, FUTURE, NOW)
        .await
        .unwrap();
    assert_eq!(
        store
            .purge_scheduled_messages_for_missing_sessions()
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .list_pending_scheduled_messages("sess-1")
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(store
        .list_pending_scheduled_messages("deleted-session")
        .await
        .unwrap()
        .is_empty());
}

/// A database created by an early dev build (table WITH the cascading FK, and
/// without `claimedAt`) is rebuilt on open with its rows intact.
#[test]
fn a_table_with_the_old_cascading_fk_is_rebuilt_keeping_its_rows() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    vst_store::schema::ensure_schema(&conn).unwrap();
    conn.execute_batch(
        "
        DROP TABLE scheduled_messages;
        CREATE TABLE scheduled_messages (
          id TEXT PRIMARY KEY,
          sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          message TEXT NOT NULL, attachments TEXT, fireAt TEXT NOT NULL,
          createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','sent','cancelled','failed')),
          sentAt TEXT, sentTurnId TEXT, failureReason TEXT
        );
        PRAGMA foreign_keys = OFF;
        INSERT INTO scheduled_messages (id, sessionId, message, fireAt, createdAt, updatedAt)
          VALUES ('keep', 'sess-x', 'hello', '2030-01-01T00:00:00Z', 'n', 'n');
        PRAGMA foreign_keys = ON;
        ",
    )
    .unwrap();

    vst_store::schema::ensure_schema(&conn).unwrap();

    let sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name = 'scheduled_messages'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!sql.contains("REFERENCES"), "FK must be gone: {sql}");
    assert!(sql.contains("claimedAt"));
    let msg: String = conn
        .query_row(
            "SELECT message FROM scheduled_messages WHERE id = 'keep'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(msg, "hello");
    // Idempotent: a second open is a no-op.
    vst_store::schema::ensure_schema(&conn).unwrap();
}

#[tokio::test]
async fn cancel_deletes_the_row_and_reschedule_changes_only_the_time() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_with_session(dir.path()).await;
    add(&store, "a", FUTURE).await;
    add(&store, "b", FUTURE).await;

    assert!(store
        .reschedule_scheduled_message("a", "sess-1", "2030-01-01T00:00:00Z", NOW)
        .await
        .unwrap());
    let a = store
        .list_pending_scheduled_messages("sess-1")
        .await
        .unwrap();
    assert_eq!(
        a.iter().find(|r| r.id == "a").unwrap().fire_at,
        "2030-01-01T00:00:00Z"
    );
    assert_eq!(
        a.iter().find(|r| r.id == "a").unwrap().message,
        "msg a",
        "text untouched"
    );

    assert!(store.cancel_scheduled_message("b", "sess-1").await.unwrap());
    assert!(
        !store.cancel_scheduled_message("b", "sess-1").await.unwrap(),
        "already gone"
    );
    assert_eq!(
        store
            .list_pending_scheduled_messages("sess-1")
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn deleting_a_session_removes_all_its_scheduled_rows() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_with_session(dir.path()).await;
    add(&store, "a", FUTURE).await;
    add(&store, "b", PAST).await;
    store
        .claim_next_due_scheduled_message(NOW, &[])
        .await
        .unwrap();
    store
        .mark_scheduled_message_failed("b", "boom", NOW)
        .await
        .unwrap();
    store
        .insert_scheduled_message("other", "another-session", "x", None, FUTURE, NOW)
        .await
        .unwrap();

    assert_eq!(
        store
            .delete_scheduled_messages_for_session("sess-1")
            .await
            .unwrap(),
        2
    );
    assert!(store
        .list_pending_scheduled_messages("sess-1")
        .await
        .unwrap()
        .is_empty());
    assert!(store
        .list_failed_scheduled_messages("sess-1")
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        store
            .list_pending_scheduled_messages("another-session")
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn due_rows_of_excluded_sessions_are_skipped_not_lost() {
    let dir = tempfile::tempdir().unwrap();
    let store = StoreHandle::open(dir.path().join("vibe-station.db")).unwrap();
    store
        .add_project(project("proj-1", &[], &["sess-1", "sess-2"]))
        .await
        .unwrap();
    for (id, sess) in [
        ("wedged-a", "sess-1"),
        ("wedged-b", "sess-1"),
        ("healthy", "sess-2"),
    ] {
        store
            .insert_scheduled_message(id, sess, "m", None, PAST, NOW)
            .await
            .unwrap();
    }
    // sess-1's agent is wedged: its rows are skipped, the healthy session still delivers.
    let wedged = vec!["sess-1".to_string()];
    let row = store
        .claim_next_due_scheduled_message(NOW, &wedged)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.id, "healthy");
    assert!(store
        .claim_next_due_scheduled_message(NOW, &wedged)
        .await
        .unwrap()
        .is_none());
    // Once the cooldown is over the skipped rows are still there, still in order.
    let after = claim_all_due(&store, NOW).await;
    assert_eq!(
        after.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        ["wedged-a", "wedged-b"]
    );
}

#[tokio::test]
async fn the_snapshot_returns_pending_failed_and_sent_together() {
    let dir = tempfile::tempdir().unwrap();
    let store = store_with_session(dir.path()).await;
    add(&store, "pending", FUTURE).await;
    add(&store, "failed", PAST).await;
    add(&store, "sent", PAST).await;
    add(&store, "in-flight", PAST).await;
    store
        .claim_scheduled_message("failed", "sess-1", NOW)
        .await
        .unwrap();
    store
        .mark_scheduled_message_failed("failed", "boom", NOW)
        .await
        .unwrap();
    store
        .claim_scheduled_message("sent", "sess-1", NOW)
        .await
        .unwrap();
    store
        .mark_scheduled_message_sent("sent", "t7", NOW)
        .await
        .unwrap();
    store
        .claim_scheduled_message("in-flight", "sess-1", NOW)
        .await
        .unwrap();

    let snap = store.read_schedule_snapshot("sess-1").await.unwrap();
    assert_eq!(
        snap.pending
            .iter()
            .map(|r| r.id.as_str())
            .collect::<Vec<_>>(),
        ["pending"]
    );
    assert_eq!(
        snap.failed
            .iter()
            .map(|r| r.id.as_str())
            .collect::<Vec<_>>(),
        ["failed"]
    );
    assert_eq!(snap.sent_turn_ids, ["t7"]);
    // Another session sees none of it.
    let other = store.read_schedule_snapshot("other").await.unwrap();
    assert!(other.pending.is_empty() && other.failed.is_empty() && other.sent_turn_ids.is_empty());
}
