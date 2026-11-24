//! Per-store facts only: other tests in this binary open stores in parallel, so
//! the global gauge is never asserted here (see `store_budget` unit tests).

use std::time::Duration;
use vst_store::store_budget::StoreBudget;
use vst_store::transcript::{
    open_transcript_store, open_transcript_store_with_budget, transcript_db_path,
};

const SID: &str = "budget-session";

#[test]
fn busy_timeout_is_set_on_the_connection() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_transcript_store(dir.path(), SID).unwrap();
    assert_eq!(store.busy_timeout_ms_for_test(), 2000);
}

#[test]
fn drop_and_close_both_release_the_permit() {
    let budget = StoreBudget::new(4, Duration::from_millis(10));
    let dir = tempfile::tempdir().unwrap();
    let a = open_transcript_store_with_budget(dir.path(), SID, &budget).unwrap();
    let b = open_transcript_store_with_budget(dir.path(), SID, &budget).unwrap();
    assert_eq!(budget.open_count(), 2);
    drop(a);
    assert_eq!(budget.open_count(), 1);
    b.close();
    assert_eq!(budget.open_count(), 0);
}

#[test]
fn a_failed_open_releases_its_permit() {
    let budget = StoreBudget::new(4, Duration::from_millis(10));
    let dir = tempfile::tempdir().unwrap();
    // A directory where the db file should be makes the open fail.
    std::fs::create_dir(transcript_db_path(dir.path())).unwrap();
    assert!(open_transcript_store_with_budget(dir.path(), SID, &budget).is_err());
    assert_eq!(budget.open_count(), 0);
}

#[test]
fn reopen_does_not_rerun_the_oversized_backfill() {
    let dir = tempfile::tempdir().unwrap();
    open_transcript_store(dir.path(), SID).unwrap().close();
    let big = serde_json::json!({
        "id": "e", "sessionId": SID, "ts": "2026-01-01T00:00:00Z", "provider": "claude",
        "kind": "tool_result", "text": "x".repeat(300_000), "logSeq": 0
    })
    .to_string();
    rusqlite::Connection::open(transcript_db_path(dir.path()))
        .unwrap()
        .execute(
            "INSERT INTO message (session_id, seq, ts, kind, turn_id, payload) VALUES (?1, 0, NULL, 'tool_result', NULL, ?2)",
            rusqlite::params![SID, big],
        )
        .unwrap();
    open_transcript_store(dir.path(), SID).unwrap().close();
    let len: i64 = rusqlite::Connection::open(transcript_db_path(dir.path()))
        .unwrap()
        .query_row(
            "SELECT LENGTH(payload) FROM message WHERE seq = 0",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(len, big.len() as i64);
}
