#![allow(unused_imports, dead_code)]

use rusqlite::{params, OptionalExtension};
use vst_store::transcript::open_transcript_store;
use vst_store::transcript_search::{
    query_terms, SearchCursor, SearchError, SearchOutcome, SearchRequest, SearchScope,
};
use vst_types::{NormalizedEvent, NormalizedEventKind, NormalizedEventProvider, Role};

const SESSION_ID: &str = "test-session";

fn ev(kind: NormalizedEventKind, turn_id: Option<&str>, text: Option<&str>) -> NormalizedEvent {
    NormalizedEvent {
        id: nanoid::nanoid(),
        session_id: SESSION_ID.to_string(),
        ts: "2026-11-12T00:00:00.000Z".to_string(),
        provider: NormalizedEventProvider::Claude,
        kind,
        role: match kind {
            NormalizedEventKind::User => Some(Role::User),
            NormalizedEventKind::Text | NormalizedEventKind::Thinking => Some(Role::Assistant),
            _ => None,
        },
        text: text.map(|s| s.to_string()),
        tool_name: None,
        tool_id: None,
        tool_input: None,
        tool_result: None,
        usage: None,
        model: None,
        turn_id: turn_id.map(|s| s.to_string()),
        log_seq: None,
        attachments: None,
        mentions: None,
        edited: None,
        cancelled: None,
        superseded: None,
        agent_chat_id: None,
        blocks: None,
        tool_diffs: None,
        tool_locations: None,
        tool_kind: None,
        tool_status: None,
        mode_id: None,
        commands: None,
        subagent_id: None,
        subagent_name: None,
        subagent_state: None,
        silent: None,
        break_kind: None,
        from_provider: None,
        to_provider: None,
        carry_over: None,
        from_mode: None,
        to_mode: None,
        parent_tool_use_id: None,
        task_signal: None,
        review: None,
    }
}

mod nanoid {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    pub fn nanoid() -> String {
        format!("id-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
    }
}

#[test]
fn delta_run_is_one_document() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();

    let s0 = store.append(&mut ev(NormalizedEventKind::Text, Some("t1"), Some("ref")));
    store.append(&mut ev(
        NormalizedEventKind::Text,
        Some("t1"),
        Some("resh tok"),
    ));
    store.append(&mut ev(NormalizedEventKind::Text, Some("t1"), Some("en")));

    let outcome = store
        .search(&SearchRequest {
            q: "refresh token".to_string(),
            scope: SearchScope::All,
            after: None,
            limit: 10,
            snippets: false,
        })
        .unwrap();

    assert_eq!(outcome.total, 2);
    assert_eq!(outcome.hits.len(), 2);
    assert_eq!(outcome.hits[0].seq, s0);
    assert_eq!(outcome.hits[0].occurrence, 0);
    assert_eq!(outcome.hits[1].seq, s0);
    assert_eq!(outcome.hits[1].occurrence, 1);
}

#[test]
fn run_survives_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let s0 = {
        let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();
        let s0 = store.append(&mut ev(NormalizedEventKind::Text, Some("t1"), Some("ref")));
        store.append(&mut ev(
            NormalizedEventKind::Text,
            Some("t1"),
            Some("resh tok"),
        ));
        s0
    };

    let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();
    store.append(&mut ev(NormalizedEventKind::Text, Some("t1"), Some("en")));

    let outcome = store
        .search(&SearchRequest {
            q: "refresh token".to_string(),
            scope: SearchScope::All,
            after: None,
            limit: 10,
            snippets: false,
        })
        .unwrap();

    assert_eq!(outcome.total, 2);
    assert_eq!(outcome.hits[0].seq, s0);
    assert_eq!(outcome.hits[1].seq, s0);
}

#[test]
fn scope_filters_kinds() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();

    store.append(&mut ev(
        NormalizedEventKind::User,
        Some("t1"),
        Some("uniqueTerm user"),
    ));
    store.append(&mut ev(
        NormalizedEventKind::Text,
        Some("t1"),
        Some("uniqueTerm text"),
    ));
    store.append(&mut ev(
        NormalizedEventKind::Thinking,
        Some("t1"),
        Some("uniqueTerm thinking"),
    ));

    let mut tool_use = ev(NormalizedEventKind::ToolUse, Some("t1"), None);
    tool_use.tool_name = Some("my_tool".to_string());
    tool_use.tool_input = Some(serde_json::json!({
        "arg": "uniqueTerm input",
        "keyOnly": "other",
        "uniqueTermKey": "other"
    }));
    store.append(&mut tool_use);

    let mut tool_res = ev(NormalizedEventKind::ToolResult, Some("t1"), None);
    tool_res.tool_result = Some(vst_types::ToolResult {
        content: Some("uniqueTerm result".to_string()),
        is_error: None,
    });
    store.append(&mut tool_res);

    // Row with key only
    let mut key_only_row = ev(NormalizedEventKind::ToolUse, Some("t1"), None);
    key_only_row.tool_input = Some(serde_json::json!({"uniqueTerm": "val"}));
    store.append(&mut key_only_row);

    let msg_res = store
        .search(&SearchRequest {
            q: "uniqueTerm".to_string(),
            scope: SearchScope::Messages,
            after: None,
            limit: 10,
            snippets: false,
        })
        .unwrap();
    assert_eq!(msg_res.total, 2, "Messages returns user + text only");
    assert!(msg_res
        .hits
        .iter()
        .all(|h| h.kind == "user" || h.kind == "text"));

    let all_res = store
        .search(&SearchRequest {
            q: "uniqueTerm".to_string(),
            scope: SearchScope::All,
            after: None,
            limit: 10,
            snippets: false,
        })
        .unwrap();
    assert_eq!(
        all_res.total, 5,
        "All returns user, text, thinking, tool_use, tool_result"
    );

    let key_search = store
        .search(&SearchRequest {
            q: "uniqueTermKey".to_string(),
            scope: SearchScope::All,
            after: None,
            limit: 10,
            snippets: false,
        })
        .unwrap();
    assert_eq!(key_search.total, 0, "key-only term never matches");
}

#[test]
fn superseded_and_silent_never_match() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();

    let s0 = store.append(&mut ev(
        NormalizedEventKind::User,
        Some("t1"),
        Some("searchable text"),
    ));
    store.mark_superseded_from(s0);

    let mut silent_ev = ev(
        NormalizedEventKind::User,
        Some("t2"),
        Some("silent text here"),
    );
    silent_ev.silent = Some(true);
    store.append(&mut silent_ev);

    let res1 = store
        .search(&SearchRequest {
            q: "searchable".to_string(),
            scope: SearchScope::All,
            after: None,
            limit: 10,
            snippets: false,
        })
        .unwrap();
    assert_eq!(res1.total, 0);

    let res2 = store
        .search(&SearchRequest {
            q: "silent".to_string(),
            scope: SearchScope::All,
            after: None,
            limit: 10,
            snippets: false,
        })
        .unwrap();
    assert_eq!(res2.total, 0);
}

#[test]
fn cap_and_cursor() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();

    for i in 0..1200 {
        store.append(&mut ev(
            NormalizedEventKind::User,
            Some(&format!("t{i}")),
            Some("constantTargetTerm"),
        ));
    }

    let res1 = store
        .search(&SearchRequest {
            q: "constantTargetTerm".to_string(),
            scope: SearchScope::All,
            after: None,
            limit: 1000,
            snippets: false,
        })
        .unwrap();
    assert_eq!(res1.total, 1000);
    assert!(res1.total_capped);
    assert_eq!(res1.hits.len(), 1000);
    assert!(res1.next_cursor.is_some());

    let cursor = SearchCursor::parse(&res1.next_cursor.unwrap()).unwrap();
    let res2 = store
        .search(&SearchRequest {
            q: "constantTargetTerm".to_string(),
            scope: SearchScope::All,
            after: Some(cursor),
            limit: 1000,
            snippets: false,
        })
        .unwrap();
    assert_eq!(res2.total, 200);
    assert!(!res2.total_capped);
    assert_eq!(res2.hits.len(), 200);
    assert_eq!(res2.next_cursor, None);
}

#[test]
fn cursor_walks_three_pages_2100_documents() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();

    for i in 0..2100 {
        store.append(&mut ev(
            NormalizedEventKind::User,
            Some(&format!("t{i}")),
            Some("pagedTargetTerm"),
        ));
    }

    let mut cursor = None;
    let mut all_keys = std::collections::HashSet::new();

    // Page 1: returns 1000 items, capped = true, next_cursor Some
    let res1 = store
        .search(&SearchRequest {
            q: "pagedTargetTerm".to_string(),
            scope: SearchScope::All,
            after: cursor,
            limit: 1000,
            snippets: false,
        })
        .unwrap();
    assert_eq!(res1.total, 1000);
    assert!(res1.total_capped);
    assert_eq!(res1.hits.len(), 1000);
    assert!(res1.next_cursor.is_some());
    for hit in &res1.hits {
        assert!(all_keys.insert((hit.seq, hit.occurrence)));
    }
    cursor = res1
        .next_cursor
        .as_deref()
        .map(|c| SearchCursor::parse(c).unwrap());

    // Page 2: returns 1000 items, capped = true, next_cursor Some
    let res2 = store
        .search(&SearchRequest {
            q: "pagedTargetTerm".to_string(),
            scope: SearchScope::All,
            after: cursor,
            limit: 1000,
            snippets: false,
        })
        .unwrap();
    assert_eq!(res2.total, 1000);
    assert!(res2.total_capped);
    assert_eq!(res2.hits.len(), 1000);
    assert!(res2.next_cursor.is_some());
    for hit in &res2.hits {
        assert!(all_keys.insert((hit.seq, hit.occurrence)));
    }
    cursor = res2
        .next_cursor
        .as_deref()
        .map(|c| SearchCursor::parse(c).unwrap());

    // Page 3: returns 100 items, capped = false, next_cursor None
    let res3 = store
        .search(&SearchRequest {
            q: "pagedTargetTerm".to_string(),
            scope: SearchScope::All,
            after: cursor,
            limit: 1000,
            snippets: false,
        })
        .unwrap();
    assert_eq!(res3.total, 100);
    assert!(!res3.total_capped);
    assert_eq!(res3.hits.len(), 100);
    assert_eq!(res3.next_cursor, None);
    for hit in &res3.hits {
        assert!(all_keys.insert((hit.seq, hit.occurrence)));
    }

    assert_eq!(all_keys.len(), 2100);
}

#[test]
fn growing_run_found_after_cursor() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();

    let s0 = store.append(&mut ev(
        NormalizedEventKind::Text,
        Some("t1"),
        Some("first match here "),
    ));

    let res1 = store
        .search(&SearchRequest {
            q: "match".to_string(),
            scope: SearchScope::All,
            after: None,
            limit: 10,
            snippets: false,
        })
        .unwrap();
    assert_eq!(res1.total, 1);
    assert_eq!(res1.hits[0].occurrence, 0);

    store.append(&mut ev(
        NormalizedEventKind::Text,
        Some("t1"),
        Some("second "),
    ));
    store.append(&mut ev(
        NormalizedEventKind::Text,
        Some("t1"),
        Some("match now"),
    ));

    let cursor = SearchCursor {
        seq: s0,
        occurrence: 0,
    };
    let res2 = store
        .search(&SearchRequest {
            q: "match".to_string(),
            scope: SearchScope::All,
            after: Some(cursor),
            limit: 10,
            snippets: false,
        })
        .unwrap();
    assert_eq!(res2.total, 1);
    assert_eq!(res2.hits[0].seq, s0);
    assert_eq!(res2.hits[0].occurrence, 1);

    assert!(SearchCursor::parse(&format!("{s0}")).is_err());
}

#[test]
fn query_validation() {
    assert!(matches!(query_terms(""), Err(SearchError::QueryInvalid)));
    assert!(matches!(
        query_terms(&"a".repeat(201)),
        Err(SearchError::QueryInvalid)
    ));
    assert!(matches!(query_terms("ab"), Err(SearchError::QueryInvalid)));
    assert!(matches!(
        SearchCursor::parse("123"),
        Err(SearchError::QueryInvalid)
    ));
    assert!(matches!(
        SearchCursor::parse("abc:def"),
        Err(SearchError::QueryInvalid)
    ));
    assert!(matches!(
        SearchCursor::parse("-1:0"),
        Err(SearchError::QueryInvalid)
    ));

    assert!(matches!(
        query_terms("foo\0bar"),
        Err(SearchError::QueryInvalid)
    ));
    assert!(matches!(
        query_terms("foo\x01bar"),
        Err(SearchError::QueryInvalid)
    ));

    // Interior whitespace is normalised by the Terms rule (split on Unicode
    // whitespace), so a pasted tab/newline is a two-term query, not an error.
    assert_eq!(
        query_terms("foo\tbar").unwrap(),
        vec!["foo".to_string(), "bar".to_string()]
    );
    assert_eq!(
        query_terms("foo\nbar").unwrap(),
        vec!["foo".to_string(), "bar".to_string()]
    );

    let terms = query_terms("to be").unwrap();
    assert_eq!(terms, vec!["to be".to_string()]);
}

#[test]
fn backfill_indexes_old_rows() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("messages.db");

    {
        let mut conn = rusqlite::Connection::open(&db_path).unwrap();
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
            for i in 0..12000 {
                let text = if i % 1000 == 0 {
                    "targetOldKeyword"
                } else {
                    "hello world"
                };
                let e = ev(
                    NormalizedEventKind::User,
                    Some(&format!("t{i}")),
                    Some(text),
                );
                let payload = serde_json::to_string(&e).unwrap();
                stmt.execute(params![
                    SESSION_ID,
                    i,
                    "2026-11-12T00:00:00Z",
                    "user",
                    format!("t{i}"),
                    payload
                ])
                .unwrap();
            }
        }
        txn.commit().unwrap();
    }

    let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();

    let res_pre = store
        .search(&SearchRequest {
            q: "targetOldKeyword".to_string(),
            scope: SearchScope::All,
            after: None,
            limit: 100,
            snippets: false,
        })
        .unwrap();
    assert!(
        res_pre.backfilling,
        "backfilling must be true before backfill steps"
    );

    while !store.backfill_step().unwrap() {}

    let res_post = store
        .search(&SearchRequest {
            q: "targetOldKeyword".to_string(),
            scope: SearchScope::All,
            after: None,
            limit: 100,
            snippets: false,
        })
        .unwrap();
    assert!(
        !res_post.backfilling,
        "backfilling must be false after completion"
    );
    assert_eq!(res_post.total, 12, "all 12 old matches found");

    let raw_conn = rusqlite::Connection::open(dir.path().join("messages.db")).unwrap();
    let state_before: (i64, i64) = raw_conn
        .query_row(
            "SELECT live_from_seq, backfill_next_seq FROM message_fts_state WHERE session_id = ?1",
            params![SESSION_ID],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    drop(store);

    let mut store2 = open_transcript_store(dir.path(), SESSION_ID).unwrap();
    let state_after: (i64, i64) = raw_conn
        .query_row(
            "SELECT live_from_seq, backfill_next_seq FROM message_fts_state WHERE session_id = ?1",
            params![SESSION_ID],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(state_before, state_after);
    assert!(store2.backfill_step().unwrap());
}

#[test]
fn stale_index_rebuilds() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();
    store.append(&mut ev(
        NormalizedEventKind::User,
        Some("t1"),
        Some("staleTermKeyword"),
    ));

    let res_before = store
        .search(&SearchRequest {
            q: "staleTermKeyword".to_string(),
            scope: SearchScope::All,
            after: None,
            limit: 10,
            snippets: false,
        })
        .unwrap();
    assert_eq!(res_before.total, 1);

    let raw_conn = rusqlite::Connection::open(dir.path().join("messages.db")).unwrap();
    raw_conn
        .execute(
            "UPDATE message_fts_state SET stale = 1 WHERE session_id = ?1",
            params![SESSION_ID],
        )
        .unwrap();

    let _ = store
        .search(&SearchRequest {
            q: "staleTermKeyword".to_string(),
            scope: SearchScope::All,
            after: None,
            limit: 10,
            snippets: false,
        })
        .unwrap();

    while !store.backfill_step().unwrap() {}

    let res_after = store
        .search(&SearchRequest {
            q: "staleTermKeyword".to_string(),
            scope: SearchScope::All,
            after: None,
            limit: 10,
            snippets: false,
        })
        .unwrap();
    assert_eq!(res_after.total, res_before.total);
    assert_eq!(res_after.hits[0].seq, res_before.hits[0].seq);
}

#[test]
fn turn_index_and_count() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();

    let s_pre = store.append(&mut ev(
        NormalizedEventKind::Text,
        None,
        Some("targetWord before user"),
    ));

    store.append(&mut ev(NormalizedEventKind::User, Some("t1"), Some("q1")));
    let s_t1 = store.append(&mut ev(
        NormalizedEventKind::Text,
        Some("t1"),
        Some("targetWord in turn 1"),
    ));

    let s_auto = store.append(&mut ev(
        NormalizedEventKind::Text,
        Some("t_auto"),
        Some("targetWord in autonomous"),
    ));

    store.append(&mut ev(NormalizedEventKind::User, Some("t2"), Some("q2")));
    store.append(&mut ev(
        NormalizedEventKind::Text,
        Some("t2"),
        Some("other text"),
    ));

    store.append(&mut ev(NormalizedEventKind::User, Some("t3"), Some("q3")));
    let s_t3 = store.append(&mut ev(
        NormalizedEventKind::Text,
        Some("t3"),
        Some("targetWord in turn 3"),
    ));

    let res = store
        .search(&SearchRequest {
            q: "targetWord".to_string(),
            scope: SearchScope::All,
            after: None,
            limit: 10,
            snippets: false,
        })
        .unwrap();

    assert_eq!(res.turn_count, 3, "total user turns is 3");
    assert_eq!(res.hits.len(), 4);

    assert_eq!(res.hits[0].seq, s_pre);
    assert_eq!(
        res.hits[0].turn_index, 0,
        "before first user turn reports 0"
    );

    assert_eq!(res.hits[1].seq, s_t1);
    assert_eq!(res.hits[1].turn_index, 1, "turn 1 reports 1");

    assert_eq!(res.hits[2].seq, s_auto);
    assert_eq!(
        res.hits[2].turn_index, 1,
        "autonomous block after turn 1 reports 1"
    );

    assert_eq!(res.hits[3].seq, s_t3);
    assert_eq!(res.hits[3].turn_index, 3, "turn 3 reports 3");
}

#[test]
fn snippet_segments() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();
    let long_text = format!("{} matchedWord {}", "a ".repeat(100), "b ".repeat(100));
    store.append(&mut ev(
        NormalizedEventKind::Text,
        Some("t1"),
        Some(&long_text),
    ));

    let res = store
        .search(&SearchRequest {
            q: "matchedWord".to_string(),
            scope: SearchScope::All,
            after: None,
            limit: 10,
            snippets: true,
        })
        .unwrap();

    let snippet = res.hits[0].snippet.as_ref().unwrap();
    let total_chars: usize = snippet.iter().map(|(s, _)| s.chars().count()).sum();
    assert!(total_chars <= 160, "total chars <= 160");
    assert!(snippet.iter().any(|(s, hit)| *hit && s == "matchedWord"));
    assert!(snippet
        .iter()
        .all(|(s, hit)| if *hit { s == "matchedWord" } else { true }));
}

#[test]
fn backfill_step_is_one_chunk() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("messages.db");

    {
        let mut conn = rusqlite::Connection::open(&db_path).unwrap();
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
            for i in 0..12000 {
                let e = ev(
                    NormalizedEventKind::User,
                    Some(&format!("t{i}")),
                    Some("test"),
                );
                let payload = serde_json::to_string(&e).unwrap();
                stmt.execute(params![
                    SESSION_ID,
                    i,
                    "2026-11-12T00:00:00Z",
                    "user",
                    format!("t{i}"),
                    payload
                ])
                .unwrap();
            }
        }
        txn.commit().unwrap();
    }

    let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();

    let raw_conn = rusqlite::Connection::open(&db_path).unwrap();
    let step1 = store.backfill_step().unwrap();
    assert!(!step1);
    let seq1: i64 = raw_conn
        .query_row(
            "SELECT backfill_next_seq FROM message_fts_state WHERE session_id = ?1",
            params![SESSION_ID],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(seq1, 5000);

    let step2 = store.backfill_step().unwrap();
    assert!(!step2);
    let seq2: i64 = raw_conn
        .query_row(
            "SELECT backfill_next_seq FROM message_fts_state WHERE session_id = ?1",
            params![SESSION_ID],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(seq2, 10000);

    let step3 = store.backfill_step().unwrap();
    assert!(step3);
    let seq3: i64 = raw_conn
        .query_row(
            "SELECT backfill_next_seq FROM message_fts_state WHERE session_id = ?1",
            params![SESSION_ID],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(seq3, 12000);
}

#[test]
fn backfill_does_not_disturb_live_run() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("messages.db");

    {
        let mut conn = rusqlite::Connection::open(&db_path).unwrap();
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
            for i in 0..10 {
                let e = ev(
                    NormalizedEventKind::User,
                    Some(&format!("t{i}")),
                    Some("old"),
                );
                let payload = serde_json::to_string(&e).unwrap();
                stmt.execute(params![
                    SESSION_ID,
                    i,
                    "2026-11-12T00:00:00Z",
                    "user",
                    format!("t{i}"),
                    payload
                ])
                .unwrap();
            }
        }
        txn.commit().unwrap();
    }

    let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();
    let s0 = store.append(&mut ev(
        NormalizedEventKind::Text,
        Some("live_turn"),
        Some("inter"),
    ));

    // Call backfill_step
    store.backfill_step().unwrap();

    // Append next delta of same run
    store.append(&mut ev(
        NormalizedEventKind::Text,
        Some("live_turn"),
        Some("rupted"),
    ));

    let res1 = store
        .search(&SearchRequest {
            q: "interrupted".to_string(),
            scope: SearchScope::All,
            after: None,
            limit: 10,
            snippets: false,
        })
        .unwrap();
    assert_eq!(res1.total, 1);
    assert_eq!(res1.hits[0].seq, s0);

    // After stale = 1 + search, further delta is searchable once backfill_step completes
    let raw_conn = rusqlite::Connection::open(dir.path().join("messages.db")).unwrap();
    raw_conn
        .execute(
            "UPDATE message_fts_state SET stale = 1 WHERE session_id = ?1",
            params![SESSION_ID],
        )
        .unwrap();

    let _ = store
        .search(&SearchRequest {
            q: "interrupted".to_string(),
            scope: SearchScope::All,
            after: None,
            limit: 10,
            snippets: false,
        })
        .unwrap();

    store.append(&mut ev(
        NormalizedEventKind::Text,
        Some("live_turn"),
        Some("furtherText"),
    ));

    while !store.backfill_step().unwrap() {}

    let res_old = store
        .search(&SearchRequest {
            q: "interrupted".to_string(),
            scope: SearchScope::All,
            after: None,
            limit: 10,
            snippets: false,
        })
        .unwrap();
    assert_eq!(res_old.total, 1, "head is searchable after backfill");

    let res_new = store
        .search(&SearchRequest {
            q: "furtherText".to_string(),
            scope: SearchScope::All,
            after: None,
            limit: 10,
            snippets: false,
        })
        .unwrap();
    assert_eq!(
        res_new.total, 1,
        "further delta of that run is searchable once backfill completes"
    );
}

#[test]
fn stale_short_circuit_keeps_rows_searchable() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();

    store.append(&mut ev(
        NormalizedEventKind::User,
        Some("t1"),
        Some("alphaTerm"),
    ));

    // Drop the index table behind the store's back: the next append's index write
    // fails, which flags the index stale (Decision 2) and makes every later append
    // skip its index write instead of failing again.
    let raw_conn = rusqlite::Connection::open(dir.path().join("messages.db")).unwrap();
    raw_conn.execute("DROP TABLE message_fts", []).unwrap();

    store.append(&mut ev(
        NormalizedEventKind::User,
        Some("t2"),
        Some("betaTerm"),
    ));
    store.append(&mut ev(
        NormalizedEventKind::User,
        Some("t3"),
        Some("gammaTerm"),
    ));
    store.append(&mut ev(
        NormalizedEventKind::User,
        Some("t4"),
        Some("deltaTerm"),
    ));

    // Decision 2: a failed index write never loses the message row.
    assert_eq!(store.read_all().len(), 4, "all four rows are present");

    let stale: i64 = raw_conn
        .query_row(
            "SELECT stale FROM message_fts_state WHERE session_id = ?1",
            params![SESSION_ID],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(stale, 1, "the stale flag is persisted, not only in memory");

    // Recreate the index table the way the next store open would.
    vst_store::transcript_search::ensure_schema(&raw_conn, SESSION_ID).unwrap();

    let pre = store
        .search(&SearchRequest {
            q: "alphaTerm".to_string(),
            scope: SearchScope::All,
            after: None,
            limit: 10,
            snippets: false,
        })
        .unwrap();
    assert_eq!(pre.total, 0, "the stale rebuild clears the index");
    assert!(pre.backfilling, "the rebuild re-arms the backfill");

    while !store.backfill_step().unwrap() {}

    // Rows appended while the index was stale are re-covered by the rebuild.
    for (q, seq) in [
        ("alphaTerm", 0),
        ("betaTerm", 1),
        ("gammaTerm", 2),
        ("deltaTerm", 3),
    ] {
        let res = store
            .search(&SearchRequest {
                q: q.to_string(),
                scope: SearchScope::All,
                after: None,
                limit: 10,
                snippets: false,
            })
            .unwrap();
        assert_eq!(res.total, 1, "row {seq} is searchable for q={q}");
        assert_eq!(res.hits[0].seq, seq, "seq for q={q}");
    }
}

/// A DB that predates the index has no state table while the open-time trims
/// run; the stale flag they raise must still be persisted once the schema
/// exists, or rows appended in that process are never indexed.
#[test]
fn trimmed_pre_feature_db_is_persisted_stale() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();
        store.append(&mut ev(
            NormalizedEventKind::User,
            Some("t1"),
            Some("earlyTerm"),
        ));
        let mut oversized = ev(NormalizedEventKind::ToolResult, Some("t1"), None);
        oversized.tool_result = Some(vst_types::ToolResult {
            content: Some("x".repeat(vst_store::transcript::TOOL_RESULT_MAX_BYTES + 1)),
            is_error: None,
        });
        store.append(&mut oversized);
    }
    let raw_conn = rusqlite::Connection::open(dir.path().join("messages.db")).unwrap();
    raw_conn
        .execute_batch("DROP TABLE message_fts; DROP TABLE message_fts_state;")
        .unwrap();

    {
        let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();
        let stale: i64 = raw_conn
            .query_row(
                "SELECT stale FROM message_fts_state WHERE session_id = ?1",
                params![SESSION_ID],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stale, 1, "the capped row leaves the index persisted stale");
        store.append(&mut ev(
            NormalizedEventKind::User,
            Some("t2"),
            Some("lateTerm"),
        ));
    }

    let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();
    search_all(&mut store, "lateTerm");
    while !store.backfill_step().unwrap() {}
    for (q, seq) in [("earlyTerm", 0), ("lateTerm", 2)] {
        let res = search_all(&mut store, q);
        assert_eq!(res.total, 1, "q={q}");
        assert_eq!(res.hits[0].seq, seq, "q={q}");
    }
}

fn search_all(store: &mut vst_store::transcript::TranscriptStore, q: &str) -> SearchOutcome {
    store
        .search(&SearchRequest {
            q: q.to_string(),
            scope: SearchScope::All,
            after: None,
            limit: 1000,
            snippets: false,
        })
        .unwrap()
}

#[test]
fn rolled_back_batch_then_delta_is_indexed() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();
    store.append(&mut ev(
        NormalizedEventKind::User,
        Some("t1"),
        Some("question"),
    ));

    // Occupy the batch's second seq behind the store's back so its insert fails
    // after the first event already opened a text-run document in the same txn.
    let raw_conn = rusqlite::Connection::open(dir.path().join("messages.db")).unwrap();
    raw_conn
        .execute(
            "INSERT INTO message (session_id, seq, kind, payload) VALUES (?1, 2, 'text', '{}')",
            params![SESSION_ID],
        )
        .unwrap();
    let mut batch = vec![
        ev(
            NormalizedEventKind::Text,
            Some("t1"),
            Some("rolledBackText"),
        ),
        ev(NormalizedEventKind::Text, Some("t1"), Some("never")),
    ];
    assert!(store.append_batch(&mut batch).is_err());
    raw_conn
        .execute("DELETE FROM message WHERE seq = 2", [])
        .unwrap();

    // The next delta continues the same turn; it must start a fresh document
    // instead of appending to the rolled-back one.
    let seq = store.append(&mut ev(
        NormalizedEventKind::Text,
        Some("t1"),
        Some("survivingDelta"),
    ));
    assert_eq!(seq, 1);

    let hit = search_all(&mut store, "survivingDelta");
    assert_eq!(hit.total, 1);
    assert_eq!(hit.hits[0].seq, 1);
    assert_eq!(search_all(&mut store, "rolledBackText").total, 0);
}

fn stale_flag(dir: &std::path::Path) -> i64 {
    let raw = rusqlite::Connection::open(dir.join("messages.db")).unwrap();
    raw.query_row(
        "SELECT stale FROM message_fts_state WHERE session_id = ?1",
        params![SESSION_ID],
        |r| r.get(0),
    )
    .unwrap()
}

/// A tool_result row over the byte cap that has nothing to trim must not be
/// rewritten, so reopening never flags the index stale.
#[test]
fn untrimmable_oversized_row_does_not_stale_on_reopen() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();
        store.append(&mut ev(
            NormalizedEventKind::User,
            Some("t1"),
            Some("keepTerm"),
        ));
        let mut big = ev(
            NormalizedEventKind::ToolResult,
            Some("t1"),
            Some(&"x".repeat(vst_store::transcript::TOOL_RESULT_MAX_BYTES + 1)),
        );
        big.tool_result = Some(vst_types::ToolResult {
            content: Some("small".to_string()),
            is_error: None,
        });
        store.append(&mut big);
    }
    for _ in 0..2 {
        let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();
        assert_eq!(stale_flag(dir.path()), 0);
        search_all(&mut store, "keepTerm");
    }
    assert_eq!(stale_flag(dir.path()), 0);
}

/// Two connections stepping the same backfill must not index a chunk twice.
#[test]
fn two_connections_backfilling_agree() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut w = open_transcript_store(dir.path(), SESSION_ID).unwrap();
        for n in 0..2600 {
            w.append(&mut ev(
                NormalizedEventKind::User,
                Some(&format!("t{n}")),
                Some("sharedNeedle"),
            ));
        }
    }
    // Reset the cursor so the whole file needs backfilling.
    let raw = rusqlite::Connection::open(dir.path().join("messages.db")).unwrap();
    raw.execute_batch(
        "DELETE FROM message_fts;
         UPDATE message_fts_state SET live_from_seq = (SELECT MAX(seq) + 1 FROM message), backfill_next_seq = 0;",
    )
    .unwrap();
    let mut a = open_transcript_store(dir.path(), SESSION_ID).unwrap();
    let mut b = open_transcript_store(dir.path(), SESSION_ID).unwrap();
    let mut done = (false, false);
    for _ in 0..100 {
        done.0 = done.0 || a.backfill_step().unwrap();
        done.1 = done.1 || b.backfill_step().unwrap();
        if done == (true, true) {
            break;
        }
    }
    assert_eq!(done, (true, true));
    let docs: i64 = raw
        .query_row("SELECT COUNT(*) FROM message_fts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(docs, 2600, "each row indexed exactly once");
}

/// A complete, non-stale index must not need a write transaction: another
/// connection holding the write lock cannot block a search or backfill_step.
#[test]
fn complete_index_backfill_step_takes_no_write_lock() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();
    store.append(&mut ev(
        NormalizedEventKind::User,
        Some("t1"),
        Some("lockFreeNeedle"),
    ));
    let raw = rusqlite::Connection::open(dir.path().join("messages.db")).unwrap();
    raw.execute_batch("BEGIN IMMEDIATE").unwrap();
    assert!(store.backfill_step().unwrap());
    assert_eq!(search_all(&mut store, "lockFreeNeedle").total, 1);
    raw.execute_batch("ROLLBACK").unwrap();
}

/// A persisted `stale = 1` is rebuilt once. A second connection searching
/// afterwards sees a current index: no second rebuild, no reset cursor, no
/// lost or duplicated documents. (The narrower race, B passing `check_stale`
/// before A commits, hits the re-check in `rebuild_stale`; it needs a hook
/// between the two calls to force, so only this sequential outcome is pinned.)
#[test]
fn second_connection_after_stale_rebuild_sees_a_current_index() {
    let dir = tempfile::tempdir().unwrap();
    let mut a = open_transcript_store(dir.path(), SESSION_ID).unwrap();
    for n in 0..40 {
        a.append(&mut ev(
            NormalizedEventKind::User,
            Some(&format!("t{n}")),
            Some("staleRecheckNeedle"),
        ));
    }
    let mut b = open_transcript_store(dir.path(), SESSION_ID).unwrap();
    let raw = rusqlite::Connection::open(dir.path().join("messages.db")).unwrap();
    raw.execute("UPDATE message_fts_state SET stale = 1", [])
        .unwrap();

    // The rebuild drops the index and resets the cursor; backfill refills it.
    search_all(&mut a, "staleRecheckNeedle");
    while !a.backfill_step().unwrap() {}
    assert_eq!(search_all(&mut a, "staleRecheckNeedle").total, 40);
    assert_eq!(
        stale_flag(dir.path()),
        0,
        "A's rebuild clears the persisted flag"
    );
    let docs_after_a: i64 = raw
        .query_row("SELECT COUNT(*) FROM message_fts", [], |r| r.get(0))
        .unwrap();

    assert_eq!(search_all(&mut b, "staleRecheckNeedle").total, 40);
    assert_eq!(stale_flag(dir.path()), 0);
    let (docs_after_b, next): (i64, i64) = raw
        .query_row(
            "SELECT (SELECT COUNT(*) FROM message_fts), backfill_next_seq FROM message_fts_state",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(docs_after_b, docs_after_a, "B did not rebuild or duplicate");
    assert!(next > 0, "B did not reset the backfill cursor");
}

/// Rows written raw after the state row was seeded (an import or demo seed)
/// are never indexed live and sit past `live_from_seq`, so backfill skips them.
/// The search must notice, report `backfilling` instead of a confident empty
/// answer, and find them once the rebuilt index has caught up.
#[test]
fn raw_rows_past_live_boundary_self_heal() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();
    assert_eq!(search_all(&mut store, "rawNeedle").total, 0);
    // A few rows go through the live path first, as in a half-seeded session.
    store.append(&mut ev(NormalizedEventKind::User, Some("t"), Some("early")));

    let raw = rusqlite::Connection::open(dir.path().join("messages.db")).unwrap();
    for i in 100..140 {
        let text = if i == 103 { "rawNeedle here" } else { "hello" };
        let e = ev(
            NormalizedEventKind::User,
            Some(&format!("t{i}")),
            Some(text),
        );
        raw.execute(
            "INSERT INTO message (session_id, seq, ts, kind, turn_id, payload) VALUES (?1, ?2, ?3, 'user', ?4, ?5)",
            params![SESSION_ID, i, "2026-11-12T00:00:00Z", format!("t{i}"), serde_json::to_string(&e).unwrap()],
        )
        .unwrap();
    }

    let first = search_all(&mut store, "rawNeedle");
    assert!(
        first.backfilling,
        "a behind index must say so, not 'no results'"
    );
    while !store.backfill_step().unwrap() {}
    let done = search_all(&mut store, "rawNeedle");
    assert!(!done.backfilling);
    assert_eq!(done.total, 1);
    // The rebuild moved the boundary: another search must not rebuild again.
    assert_eq!(search_all(&mut store, "rawNeedle").total, 1);
}

fn insert_raw_users(dir: &std::path::Path, range: std::ops::Range<i64>, text: &str) {
    let raw = rusqlite::Connection::open(dir.join("messages.db")).unwrap();
    for i in range {
        let e = ev(
            NormalizedEventKind::User,
            Some(&format!("t{i}")),
            Some(text),
        );
        raw.execute(
            "INSERT INTO message (session_id, seq, ts, kind, turn_id, payload) VALUES (?1, ?2, ?3, 'user', ?4, ?5)",
            params![SESSION_ID, i, "2026-11-12T00:00:00Z", format!("t{i}"), serde_json::to_string(&e).unwrap()],
        )
        .unwrap();
    }
}

fn doc_count(dir: &std::path::Path) -> i64 {
    let raw = rusqlite::Connection::open(dir.join("messages.db")).unwrap();
    raw.query_row("SELECT COUNT(*) FROM message_fts", [], |r| r.get(0))
        .unwrap()
}

/// Raw-seed rows, then 60 live appends: the live document must not hide the
/// raw rows behind it (a newest-document watermark did).
#[test]
fn live_appends_after_raw_rows_still_self_heal() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();
    assert_eq!(search_all(&mut store, "rawNeedle").total, 0);
    insert_raw_users(dir.path(), 0..10, "hello");
    insert_raw_users(dir.path(), 10..11, "rawNeedle");
    insert_raw_users(dir.path(), 11..40, "hello");
    drop(store);
    let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();
    store.append(&mut ev(
        NormalizedEventKind::User,
        Some("live"),
        Some("liveOne"),
    ));
    let first = search_all(&mut store, "rawNeedle");
    assert!(first.backfilling, "behind index must report backfilling");
    while !store.backfill_step().unwrap() {}
    assert_eq!(search_all(&mut store, "rawNeedle").total, 1);
    assert_eq!(search_all(&mut store, "liveOne").total, 1);
}

/// 31 raw user rows are below the sample size and never trigger a rebuild; 32 do.
#[test]
fn behind_sample_boundary_31_vs_32() {
    for (n, expect_rebuild) in [(31i64, false), (32, true)] {
        let dir = tempfile::tempdir().unwrap();
        let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();
        assert_eq!(search_all(&mut store, "zzz").total, 0);
        insert_raw_users(dir.path(), 0..n, "boundaryNeedle");
        let out = search_all(&mut store, "boundaryNeedle");
        assert_eq!(out.backfilling, expect_rebuild, "n = {n}");
        if expect_rebuild {
            while !store.backfill_step().unwrap() {}
            assert_eq!(search_all(&mut store, "boundaryNeedle").total, n as usize);
        } else {
            assert_eq!(out.total, 0);
        }
    }
}

/// Silent/empty user rows have no document by design: they may cost one
/// rebuild, but never repeated rebuilds (the rebuild moves the boundary).
#[test]
fn silent_user_rows_do_not_rebuild_repeatedly() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();
    for n in 0..40 {
        store.append(&mut ev(
            NormalizedEventKind::User,
            Some(&format!("t{n}")),
            Some(""),
        ));
    }
    let _ = search_all(&mut store, "anything");
    while !store.backfill_step().unwrap() {}
    let before = doc_count(dir.path());
    for _ in 0..3 {
        let out = search_all(&mut store, "anything");
        assert!(!out.backfilling, "no repeated rebuild");
    }
    assert_eq!(doc_count(dir.path()), before);
    assert_eq!(stale_flag(dir.path()), 0);
    // Silent notice rows have no document by design and never count as behind.
    for n in 0..40 {
        let mut e = ev(
            NormalizedEventKind::User,
            Some(&format!("s{n}")),
            Some("notice"),
        );
        e.silent = Some(true);
        store.append(&mut e);
    }
    assert!(!search_all(&mut store, "anything").backfilling);
    assert_eq!(doc_count(dir.path()), before);
}

/// A long streamed reply is one document at its first row; the many delta rows
/// after it must not read as an index that is behind.
#[test]
fn streamed_text_run_does_not_look_behind() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();
    for _ in 0..60 {
        store.append(&mut ev(NormalizedEventKind::Text, Some("t"), Some("word ")));
    }
    assert_eq!(search_all(&mut store, "word").total, 60);
    assert_eq!(stale_flag(dir.path()), 0);
    assert!(!search_all(&mut store, "word").backfilling);
}
