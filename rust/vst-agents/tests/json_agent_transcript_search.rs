//! Integration tests for JSON agent session transcript search & backfill.

mod common;

use std::sync::Arc;
use std::time::Duration;

use rusqlite::params;
use vst_agents::json_agent_session::{JsonAgentSession, JsonAgentSessionOptions};
use vst_agents::paths::Paths;
use vst_store::transcript_search::{SearchRequest, SearchScope, BACKFILL_CHUNK_ROWS};
use vst_types::{Broadcaster, NormalizedEvent, NormalizedEventKind, NormalizedEventProvider};

const PROJECT_ID: &str = "p1";
const SESSION_ID: &str = "s-search-live";

fn populate_unindexed_db(db_path: &std::path::Path, session_id: &str, count: i64) {
    let mut conn = rusqlite::Connection::open(db_path).unwrap();
    conn.execute_batch(
        "CREATE TABLE message (
           session_id TEXT NOT NULL,
           seq INTEGER NOT NULL,
           ts TEXT,
           kind TEXT,
           turn_id TEXT,
           payload TEXT NOT NULL,
           superseded INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY (session_id, seq)
        );",
    )
    .unwrap();

    let txn = conn.transaction().unwrap();
    {
        let mut stmt = txn
            .prepare(
                "INSERT INTO message (session_id, seq, ts, kind, turn_id, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .unwrap();
        for i in 0..count {
            let text = if i == 500 {
                "find target here"
            } else {
                "noise token"
            };
            let turn_id = format!("t{i}");
            let payload = serde_json::json!({
                "id": format!("e-{i}"),
                "sessionId": session_id,
                "ts": "2026-01-01T00:00:00Z",
                "provider": "claude",
                "kind": "user",
                "text": text,
                "turnId": turn_id,
            })
            .to_string();
            stmt.execute(params![
                session_id,
                i,
                "2026-01-01T00:00:00Z",
                "user",
                turn_id,
                payload
            ])
            .unwrap();
        }
    }
    txn.commit().unwrap();
}

fn ev(seq: i64) -> NormalizedEvent {
    let mut e: NormalizedEvent = serde_json::from_value(serde_json::json!({
        "id": format!("e-new-{seq}"),
        "sessionId": SESSION_ID,
        "ts": "2026-01-01T00:00:00Z",
        "provider": "claude",
        "kind": serde_json::to_value(NormalizedEventKind::Text).unwrap(),
    }))
    .unwrap();
    e.role = Some(vst_types::Role::Assistant);
    e.text = Some(format!("live-chunk-{seq}"));
    e.turn_id = Some("t1".to_string());
    e
}

fn open_session(dir: &std::path::Path, session_id: &str) -> Arc<JsonAgentSession> {
    let store_handle =
        vst_store::StoreHandle::open(dir.join("vibe-station.db")).expect("open store");
    let (tx, _rx) = tokio::sync::broadcast::channel(64);
    let mut session_rec = common::make_session(session_id);
    session_rec.project_id = PROJECT_ID.into();
    let project = common::make_project(PROJECT_ID);

    Arc::new(JsonAgentSession::new(JsonAgentSessionOptions {
        project,
        worktree: None,
        session: session_rec,
        plugin: Arc::new(vst_agents::claude::create_claude_plugin()),
        daemon_port: 0,
        cli: NormalizedEventProvider::Claude,
        model: None,
        mode_id: None,
        mode_name: None,
        store_handle,
        broadcaster: Broadcaster(tx),
    }))
}

fn populated_session(dir: &std::path::Path, session_id: &str, rows: i64) -> Arc<JsonAgentSession> {
    let data_dir =
        Paths::with_home(dir.join(".vibe-station")).direct_session_data_dir(PROJECT_ID, session_id);
    std::fs::create_dir_all(&data_dir).unwrap();
    populate_unindexed_db(&data_dir.join("messages.db"), session_id, rows);
    open_session(dir, session_id)
}

fn search_req(q: &str) -> SearchRequest {
    SearchRequest {
        q: q.to_string(),
        scope: SearchScope::Messages,
        after: None,
        limit: 1000,
        snippets: false,
    }
}

/// Number of backfill chunks needed to index `rows` pre-existing rows.
fn chunks_for(rows: i64) -> i64 {
    (rows + BACKFILL_CHUNK_ROWS - 1) / BACKFILL_CHUNK_ROWS
}

/// With a zero time budget each search advances the backfill by exactly one chunk
/// and releases the store between calls, so live appends interleaved between
/// chunks are indexed live and the backfill neither drops nor double-indexes rows.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn backfill_advances_one_chunk_per_call_with_live_appends_between() {
    const ROWS: i64 = 40_000;
    let dir = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let session = populated_session(dir.path(), SESSION_ID, ROWS);
    let req = search_req("target");

    let mut persisted = 0i64;
    for call in 1..=chunks_for(ROWS) {
        let outcome = session
            .search_transcript_for_test(&req, Duration::ZERO, |_| {})
            .unwrap();
        let done = call == chunks_for(ROWS);
        assert_eq!(outcome.backfilling, !done, "after chunk {call}");
        if !done {
            session.persist_event_for_test(&ev(ROWS + 1 + persisted));
            persisted += 1;
        }
    }

    let outcome = session
        .search_transcript_for_test(&req, Duration::ZERO, |_| {})
        .unwrap();
    assert!(!outcome.backfilling);
    assert_eq!(outcome.total, 1);
    assert_eq!(outcome.hits[0].seq, 500);

    let live = session
        .search_transcript_for_test(&search_req("live-chunk"), Duration::ZERO, |_| {})
        .unwrap();
    assert_eq!(i64::try_from(live.total).unwrap(), persisted);
}

/// An unbounded budget finishes the whole backfill in one search call.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn backfill_completes_in_one_call_with_unbounded_budget() {
    let dir = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let session = populated_session(dir.path(), "s-fresh", 12_000);

    let outcome = session
        .search_transcript_for_test(&search_req("target"), Duration::MAX, |_| {})
        .unwrap();
    assert!(!outcome.backfilling);
    assert_eq!(outcome.total, 1);
    assert_eq!(outcome.hits[0].seq, 500);
}

/// The store lock is released between backfill chunks, so an append never waits
/// for a whole multi-chunk backfill.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn store_lock_is_free_between_backfill_chunks() {
    const ROWS: i64 = 12_000;
    let dir = tempfile::tempdir().unwrap();
    let _home = vst_agents::home::with_home(dir.path().to_path_buf());
    let session = populated_session(dir.path(), "s-lock", ROWS);

    let mut betweens = 0i64;
    let outcome = session
        .search_transcript_for_test(&search_req("target"), Duration::MAX, |store_lock_free| {
            assert!(store_lock_free, "store lock held between backfill chunks");
            betweens += 1;
        })
        .unwrap();
    assert_eq!(betweens, chunks_for(ROWS) - 1);
    assert!(!outcome.backfilling);
    assert_eq!(outcome.total, 1);
}
