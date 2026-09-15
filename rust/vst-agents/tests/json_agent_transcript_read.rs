//! Behavior contract for the no-live-session transcript-reading free
//! functions — ports `jsonAgent.ts`'s `readTranscriptFromDataDir` /
//! `readTailFromDataDir` / `readPageBeforeFromDataDir` / `readSinceFromDataDir`
//! / `readMetaFromDataDir` + `withDiskStore`.
//!
//! These read a session's transcript from disk via the per-session SQLite
//! store, WITHOUT a live `JsonAgentSession` (used for restart-durable meta and
//! reconnect deltas). They must return the empty fallback (and create nothing)
//! when neither the DB nor a legacy `messages.jsonl` exists.

mod common;

use vst_agents::json_agent_session::{
    read_meta_from_data_dir, read_page_before_from_data_dir, read_since_from_data_dir,
    read_tail_from_data_dir, read_transcript_from_data_dir,
};
use vst_store::transcript::{open_transcript_store, TranscriptStore};
use vst_types::{NormalizedEvent, NormalizedEventKind};

const SESSION_ID: &str = "sess-read-1";

fn ev(kind: NormalizedEventKind, text: &str, turn_id: &str) -> NormalizedEvent {
    let mut e: NormalizedEvent = serde_json::from_value(serde_json::json!({
        "id": format!("e-{}", std::process::id()),
        "sessionId": SESSION_ID,
        "ts": "2026-01-01T00:00:00Z",
        "provider": "claude",
        "kind": serde_json::to_value(&kind).unwrap(),
    }))
    .unwrap();
    if kind == NormalizedEventKind::User {
        e.role = Some(vst_types::Role::User);
    } else {
        e.role = Some(vst_types::Role::Assistant);
    }
    e.text = Some(text.to_string());
    e.turn_id = Some(turn_id.to_string());
    e
}

fn append_turn(store: &mut TranscriptStore, turn_id: &str) {
    store.append(&mut ev(
        NormalizedEventKind::User,
        &format!("q {turn_id}"),
        turn_id,
    ));
    store.append(&mut ev(
        NormalizedEventKind::Text,
        &format!("a {turn_id}"),
        turn_id,
    ));
    store.append(&mut ev(NormalizedEventKind::Result, "", turn_id));
}

/// With no DB and no legacy transcript, every reader returns its empty
/// fallback and creates nothing on disk.
#[test]
fn empty_dir_returns_fallbacks_and_creates_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let data_dir = dir.path().to_path_buf();

    let events = read_transcript_from_data_dir(&data_dir, SESSION_ID);
    assert!(events.is_empty());

    let tail = read_tail_from_data_dir(&data_dir, SESSION_ID, 5);
    assert!(tail.events.is_empty());
    assert!(!tail.has_more);

    let page = read_page_before_from_data_dir(&data_dir, SESSION_ID, 100, 5);
    assert!(page.events.is_empty());
    assert!(!page.has_more);

    let since = read_since_from_data_dir(&data_dir, SESSION_ID, 0);
    assert!(since.events.is_empty());
    assert!(!since.has_more);

    let meta = read_meta_from_data_dir(&data_dir, SESSION_ID);
    assert!(meta.model.is_none());
    assert!(meta.usage.is_none());

    // Nothing was created (no DB, no legacy transcript).
    assert!(!data_dir.join("messages.db").exists());
    assert!(!data_dir.join("messages.jsonl").exists());
}

/// `read_transcript_from_data_dir` returns the full stored transcript.
#[test]
fn read_transcript_returns_all_stored_events() {
    let dir = tempfile::tempdir().unwrap();
    let data_dir = dir.path().to_path_buf();
    let mut store = open_transcript_store(&data_dir, SESSION_ID);
    append_turn(&mut store, "t1");
    append_turn(&mut store, "t2");
    store.close();

    let events = read_transcript_from_data_dir(&data_dir, SESSION_ID);
    assert_eq!(events.len(), 6, "two turns of three events each");
    assert_eq!(events[0].turn_id.as_deref(), Some("t1"));
    assert_eq!(events[3].turn_id.as_deref(), Some("t2"));
}

/// `read_tail_from_data_dir` returns the last N whole turns.
#[test]
fn read_tail_returns_last_n_turns() {
    let dir = tempfile::tempdir().unwrap();
    let data_dir = dir.path().to_path_buf();
    let mut store = open_transcript_store(&data_dir, SESSION_ID);
    append_turn(&mut store, "t1");
    append_turn(&mut store, "t2");
    append_turn(&mut store, "t3");
    store.close();

    let tail = read_tail_from_data_dir(&data_dir, SESSION_ID, 2);
    // The tail must be turn-aligned: the last 2 whole turns = t2 + t3.
    let turn_ids: std::collections::BTreeSet<String> = tail
        .events
        .iter()
        .filter_map(|e| e.turn_id.clone())
        .collect();
    assert_eq!(turn_ids.len(), 2, "two distinct turns");
    assert!(
        turn_ids.contains("t2") && turn_ids.contains("t3"),
        "the last two turns, got {turn_ids:?}"
    );
    assert!(tail.has_more, "earlier turns exist");
}

/// `read_meta_from_data_dir` returns the last model + last real usage.
#[test]
fn read_meta_returns_last_model_and_real_usage() {
    let dir = tempfile::tempdir().unwrap();
    let data_dir = dir.path().to_path_buf();
    let mut store = open_transcript_store(&data_dir, SESSION_ID);
    let mut user = ev(NormalizedEventKind::User, "hi", "t1");
    user.model = Some("sonnet".to_string());
    store.append(&mut user);
    let mut usage = ev(NormalizedEventKind::Usage, "", "t1");
    usage.usage = Some(vst_types::UsageInfo {
        input_tokens: 5,
        output_tokens: 5,
        cache_read_tokens: 0,
        cache_create_tokens: 0,
        total_tokens: 10,
        context_window: None,
        cost_usd: None,
        model: String::new(),
    });
    store.append(&mut usage);
    store.close();

    let meta = read_meta_from_data_dir(&data_dir, SESSION_ID);
    assert_eq!(meta.model.as_deref(), Some("sonnet"));
    assert_eq!(meta.usage.as_ref().map(|u| u.total_tokens), Some(10));
}

/// `read_page_before_from_data_dir` and `read_since_from_data_dir` return
/// keyset pages off the store.
#[test]
fn page_before_and_since_return_keyset_pages() {
    let dir = tempfile::tempdir().unwrap();
    let data_dir = dir.path().to_path_buf();
    let mut store = open_transcript_store(&data_dir, SESSION_ID);
    append_turn(&mut store, "t1");
    append_turn(&mut store, "t2");
    store.close();

    // A backward page before a high seq is turn-aligned: with two whole turns
    // and limit 5 it returns both turns' events and reports no earlier data.
    let page = read_page_before_from_data_dir(&data_dir, SESSION_ID, 10_000, 5);
    assert_eq!(page.events.len(), 6, "both whole turns, turn-aligned");
    assert!(!page.has_more, "no events before the page");

    // A forward page since seq 0 is strict (> seq 0): the store is 0-based, so
    // the first event (seq 0) is excluded — 5 events remain.
    let since = read_since_from_data_dir(&data_dir, SESSION_ID, 0);
    assert_eq!(
        since.events.len(),
        5,
        "everything strictly newer than seq 0"
    );
    assert!(!since.has_more);
}
