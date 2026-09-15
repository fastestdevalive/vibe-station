//! Behavior contract for `sqliteTranscriptStore.ts` + `transcriptMigration.ts`
//! (part 01-storage). Ported 1:1 from `daemon/src/__tests__/transcriptStore.test.ts`.
//!
//! `TranscriptStore` is a synchronous, per-session handle (one `messages.db`
//! file per session). It is exercised synchronously here exactly as the TS
//! tests do; production async callers must wrap it in `spawn_blocking` (Gotcha
//! #4) — that wrapping belongs to the owning session runtime (part 04c), not
//! this storage crate.

use std::io::Write;
use vst_store::transcript::{
    open_transcript_store, transcript_db_path, ImportOutcome, NativeWatermark, TranscriptMeta,
};
use vst_types::{NormalizedEvent, NormalizedEventKind};

const SESSION_ID: &str = "sess-store-1";

fn ev(kind: NormalizedEventKind, extra: serde_json::Value) -> NormalizedEvent {
    let mut e: NormalizedEvent = serde_json::from_value(serde_json::json!({
        "id": format!("e-{}", std::process::id()),
        "sessionId": SESSION_ID,
        "ts": "2026-01-01T00:00:00Z",
        "provider": "claude",
        "kind": serde_json::to_value(&kind).unwrap(),
    }))
    .unwrap();
    if let Some(text) = extra.get("text") {
        e.text = text.as_str().map(str::to_string);
    }
    if let Some(turn_id) = extra.get("turnId") {
        e.turn_id = turn_id.as_str().map(str::to_string);
    }
    if let Some(role) = extra.get("role") {
        e.role = role.as_str().map(|r| {
            if r == "user" {
                vst_types::Role::User
            } else {
                vst_types::Role::Assistant
            }
        });
    }
    if let Some(model) = extra.get("model") {
        e.model = model.as_str().map(str::to_string);
    }
    if let Some(usage) = extra.get("usage") {
        e.usage = serde_json::from_value(usage.clone()).ok();
    }
    if let Some(tool_id) = extra.get("toolId") {
        e.tool_id = tool_id.as_str().map(str::to_string);
    }
    if let Some(tool_result) = extra.get("toolResult") {
        e.tool_result = serde_json::from_value(tool_result.clone()).ok();
    }
    if let Some(attachments) = extra.get("attachments") {
        e.attachments = serde_json::from_value(attachments.clone()).ok();
    }
    if let Some(agent_chat_id) = extra.get("agentChatId") {
        e.agent_chat_id = agent_chat_id.as_str().map(str::to_string);
    }
    e
}

fn usage(total: i64) -> serde_json::Value {
    serde_json::json!({
        "inputTokens": 5,
        "outputTokens": 5,
        "cacheReadTokens": 0,
        "cacheCreateTokens": 0,
        "totalTokens": total,
        "model": ""
    })
}

fn append_turn(store: &mut vst_store::transcript::TranscriptStore, turn_id: &str) -> i64 {
    let first = store.append(&mut ev(
        NormalizedEventKind::User,
        serde_json::json!({"role": "user", "text": format!("q {turn_id}"), "turnId": turn_id}),
    ));
    store.append(&mut ev(
        NormalizedEventKind::Text,
        serde_json::json!({"role": "assistant", "text": format!("a {turn_id}"), "turnId": turn_id}),
    ));
    store.append(&mut ev(
        NormalizedEventKind::Result,
        serde_json::json!({"turnId": turn_id}),
    ));
    first
}

#[test]
fn assigns_gap_free_monotonic_log_seq() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    let seqs = [
        store.append(&mut ev(
            NormalizedEventKind::User,
            serde_json::json!({"text": "a", "turnId": "t1"}),
        )),
        store.append(&mut ev(
            NormalizedEventKind::SessionInit,
            serde_json::json!({"turnId": "t1"}),
        )),
        store.append(&mut ev(
            NormalizedEventKind::Text,
            serde_json::json!({"text": "hi", "turnId": "t1"}),
        )),
    ];
    assert_eq!(seqs, [0, 1, 2]);
    let all = store.read_all();
    assert_eq!(
        all.iter().map(|e| e.log_seq).collect::<Vec<_>>(),
        vec![Some(0), Some(1), Some(2)]
    );
    assert_eq!(store.count(), 3);
}

#[test]
fn reseeds_next_from_max_after_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = transcript_db_path(dir.path());
    {
        let mut s = open_transcript_store(dir.path(), SESSION_ID);
        s.append(&mut ev(
            NormalizedEventKind::User,
            serde_json::json!({"text": "a", "turnId": "t1"}),
        ));
        s.append(&mut ev(
            NormalizedEventKind::Result,
            serde_json::json!({"turnId": "t1"}),
        ));
        let _ = path;
    }
    let mut s2 = open_transcript_store(dir.path(), SESSION_ID);
    let next = s2.append(&mut ev(
        NormalizedEventKind::User,
        serde_json::json!({"text": "b", "turnId": "t2"}),
    ));
    assert_eq!(next, 2);
    assert_eq!(
        s2.read_all().iter().map(|e| e.log_seq).collect::<Vec<_>>(),
        vec![Some(0), Some(1), Some(2)]
    );
}

#[test]
fn last_meta_returns_last_model_and_last_real_usage() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    store.append(&mut ev(
        NormalizedEventKind::SessionInit,
        serde_json::json!({"model": "claude-sonnet-4-5"}),
    ));
    store.append(&mut ev(
        NormalizedEventKind::Usage,
        serde_json::json!({"usage": usage(10)}),
    ));
    // A no-op turn reports 0 tokens — must NOT clobber the last real usage.
    store.append(&mut ev(
        NormalizedEventKind::Usage,
        serde_json::json!({"usage": usage(0)}),
    ));
    let meta: TranscriptMeta = store.last_meta();
    assert_eq!(meta.model.as_deref(), Some("claude-sonnet-4-5"));
    assert_eq!(meta.usage.unwrap().total_tokens, 10);
}

#[test]
fn tail_returns_last_n_whole_turns() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    let mut first_seqs = std::collections::HashMap::new();
    for i in 1..=25 {
        first_seqs.insert(format!("t{i}"), append_turn(&mut store, &format!("t{i}")));
    }
    let page = store.tail(20);
    assert_eq!(page.events.len(), 60);
    assert_eq!(page.oldest_seq, Some(first_seqs["t6"]));
    assert_eq!(page.events[0].turn_id.as_deref(), Some("t6"));
    assert_eq!(page.events[0].kind, NormalizedEventKind::User);
    assert!(page.has_more);
    assert!(page
        .events
        .iter()
        .any(|e| e.turn_id.as_deref() == Some("t25")));
    assert!(!page
        .events
        .iter()
        .any(|e| e.turn_id.as_deref() == Some("t5")));
}

#[test]
fn tail_with_fewer_than_n_turns_returns_everything() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    append_turn(&mut store, "t1");
    append_turn(&mut store, "t2");
    let page = store.tail(20);
    assert_eq!(page.events.len(), 6);
    assert_eq!(page.oldest_seq, Some(0));
    assert!(!page.has_more);
}

#[test]
fn page_before_is_turn_aligned_with_has_more() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    let mut first_seqs = std::collections::HashMap::new();
    for i in 1..=5 {
        first_seqs.insert(format!("t{i}"), append_turn(&mut store, &format!("t{i}")));
    }
    let tail = store.tail(2);
    assert_eq!(tail.oldest_seq, Some(first_seqs["t4"]));

    let page = store.page_before(tail.oldest_seq.unwrap(), 2);
    assert_eq!(page.events[0].turn_id.as_deref(), Some("t3"));
    assert_eq!(page.events[0].kind, NormalizedEventKind::User);
    assert_eq!(page.oldest_seq, Some(first_seqs["t3"]));
    assert!(page
        .events
        .iter()
        .all(|e| e.log_seq.unwrap_or(0) < tail.oldest_seq.unwrap()));
    assert!(page.has_more);
}

#[test]
fn since_returns_only_events_newer_than_cursor() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    for i in 1..=3 {
        append_turn(&mut store, &format!("t{i}"));
    }
    let page = store.since(5, None);
    assert_eq!(
        page.events
            .iter()
            .map(|e| e.log_seq.unwrap())
            .collect::<Vec<_>>(),
        vec![6, 7, 8]
    );
    assert_eq!(page.next_seq, Some(8));
    assert!(!page.has_more);
}

#[test]
fn since_is_bounded_by_limit_and_pages_forward() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    for i in 1..=5 {
        append_turn(&mut store, &format!("t{i}"));
    }
    let page = store.since(0, Some(3));
    assert_eq!(
        page.events
            .iter()
            .map(|e| e.log_seq.unwrap())
            .collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    assert_eq!(page.next_seq, Some(3));
    assert!(page.has_more);
    let page2 = store.since(page.next_seq.unwrap(), Some(3));
    assert_eq!(
        page2
            .events
            .iter()
            .map(|e| e.log_seq.unwrap())
            .collect::<Vec<_>>(),
        vec![4, 5, 6]
    );
    assert_eq!(page2.next_seq, Some(6));
    assert!(page2.has_more);
}

#[test]
fn last_meta_finds_model_older_than_tail_window() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    store.append(&mut ev(
        NormalizedEventKind::SessionInit,
        serde_json::json!({"model": "claude-opus-4", "turnId": "t1"}),
    ));
    store.append(&mut ev(
        NormalizedEventKind::Usage,
        serde_json::json!({"usage": usage(10), "turnId": "t1"}),
    ));
    store.append(&mut ev(
        NormalizedEventKind::Result,
        serde_json::json!({"turnId": "t1"}),
    ));
    for i in 2..=31 {
        store.append(&mut ev(
            NormalizedEventKind::User,
            serde_json::json!({"role": "user", "text": "x", "turnId": format!("t{i}")}),
        ));
        store.append(&mut ev(
            NormalizedEventKind::Text,
            serde_json::json!({"role": "assistant", "text": "y", "turnId": format!("t{i}")}),
        ));
        store.append(&mut ev(
            NormalizedEventKind::Result,
            serde_json::json!({"turnId": format!("t{i}")}),
        ));
    }
    let tail = store.tail(20);
    assert!(!tail
        .events
        .iter()
        .any(|e| e.model.as_deref() == Some("claude-opus-4")));
    let meta = store.last_meta();
    assert_eq!(meta.model.as_deref(), Some("claude-opus-4"));
    assert_eq!(meta.usage.unwrap().total_tokens, 10);
}

#[test]
fn mark_superseded_from_flags_and_hides_rows() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    let s1 = append_turn(&mut store, "t1");
    let s2 = append_turn(&mut store, "t2");
    append_turn(&mut store, "t3");
    assert_eq!(store.first_seq_of_turn("t2"), Some(s2));

    let superseded = store.mark_superseded_from(s2);
    let expected: std::collections::HashSet<String> =
        ["t2", "t3"].into_iter().map(String::from).collect();
    let actual: std::collections::HashSet<String> = superseded.into_iter().collect();
    assert_eq!(actual, expected);

    assert_eq!(store.count(), 3);
    let all = store.read_all();
    assert_eq!(
        all.iter()
            .map(|e| e.turn_id.as_deref().unwrap())
            .collect::<Vec<_>>(),
        vec!["t1", "t1", "t1"]
    );
    assert_eq!(store.first_seq_of_turn("t1"), Some(s1));
    assert_eq!(store.first_seq_of_turn("t2"), None);

    let tail = store.tail(20);
    assert!(tail
        .events
        .iter()
        .all(|e| e.turn_id.as_deref() == Some("t1")));
    assert!(!tail.has_more);
    assert!(!store
        .since(s1, None)
        .events
        .iter()
        .any(|e| matches!(e.turn_id.as_deref(), Some("t2") | Some("t3"))));
}

#[test]
fn mark_superseded_from_zero_empties_live_transcript() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    append_turn(&mut store, "t1");
    append_turn(&mut store, "t2");
    store.mark_superseded_from(0);
    assert_eq!(store.count(), 0);
    assert!(store.read_all().is_empty());
    assert!(store.tail(20).events.is_empty());
    let seq = store.append(&mut ev(
        NormalizedEventKind::User,
        serde_json::json!({"text": "new", "turnId": "t3"}),
    ));
    assert_eq!(seq, 6);
}

#[test]
fn oversized_tool_result_backfill_caps_live_and_superseded() {
    let dir = tempfile::tempdir().unwrap();
    let big_a = "A".repeat(20_000 + 100);
    let big_b = "B".repeat(20_000 + 200);
    {
        let mut s = open_transcript_store(dir.path(), SESSION_ID);
        s.append(&mut ev(
            NormalizedEventKind::User,
            serde_json::json!({"text": "q1", "turnId": "t1"}),
        ));
        s.append(&mut ev(
            NormalizedEventKind::ToolResult,
            serde_json::json!({"turnId": "t1", "toolId": "t1", "toolResult": {"content": big_a}}),
        ));
        let fork_seq = s.append(&mut ev(
            NormalizedEventKind::User,
            serde_json::json!({"text": "q2", "turnId": "t2"}),
        ));
        s.append(&mut ev(
            NormalizedEventKind::ToolResult,
            serde_json::json!({"turnId": "t2", "toolId": "t2", "toolResult": {"content": big_b}}),
        ));
        s.mark_superseded_from(fork_seq);
    }
    let s2 = open_transcript_store(dir.path(), SESSION_ID);
    let live = s2
        .read_all()
        .into_iter()
        .find(|e| e.kind == NormalizedEventKind::ToolResult)
        .unwrap();
    let content = live.tool_result.unwrap().content.unwrap();
    assert!(!content.contains(&big_a));
    assert!(content.contains("omitted"));

    // Reopen is idempotent.
    let s3 = open_transcript_store(dir.path(), SESSION_ID);
    let live3 = s3
        .read_all()
        .into_iter()
        .find(|e| e.kind == NormalizedEventKind::ToolResult)
        .unwrap();
    assert!(live3
        .tool_result
        .unwrap()
        .content
        .unwrap()
        .contains("omitted"));
}

#[test]
fn leaves_normal_size_tool_result_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let normal = "short read result";
    {
        let mut s = open_transcript_store(dir.path(), SESSION_ID);
        s.append(&mut ev(
            NormalizedEventKind::User,
            serde_json::json!({"text": "q1", "turnId": "t1"}),
        ));
        s.append(&mut ev(
            NormalizedEventKind::ToolResult,
            serde_json::json!({"turnId": "t1", "toolId": "t1", "toolResult": {"content": normal}}),
        ));
    }
    let s2 = open_transcript_store(dir.path(), SESSION_ID);
    let result = s2
        .read_all()
        .into_iter()
        .find(|e| e.kind == NormalizedEventKind::ToolResult)
        .unwrap();
    assert_eq!(result.tool_result.unwrap().content.as_deref(), Some(normal));
}

fn seed_legacy(data_dir: &std::path::Path) {
    let lines = [
        serde_json::json!({"id": "e0", "sessionId": SESSION_ID, "ts": "2026-01-01T00:00:00Z", "provider": "claude", "kind": "user", "role": "user", "text": "hello", "turnId": "t1"}),
        serde_json::json!({"id": "e1", "sessionId": SESSION_ID, "ts": "2026-01-01T00:00:01Z", "provider": "claude", "kind": "session_init", "turnId": "t1", "agentChatId": "chat-1"}),
        serde_json::json!({"id": "e2", "sessionId": SESSION_ID, "ts": "2026-01-01T00:00:02Z", "provider": "claude", "kind": "user", "role": "user", "text": "see this", "turnId": "t2", "attachments": [{"id": "up1", "name": "img.png", "path": "/data/up1/img.png", "size": 12, "mime": "image/png"}]}),
        serde_json::json!({"id": "e3", "sessionId": SESSION_ID, "ts": "2026-01-01T00:00:03Z", "provider": "claude", "kind": "result", "turnId": "t2", "usage": {"model": "claude-sonnet-4-5", "inputTokens": 10, "outputTokens": 5, "cacheReadTokens": 0, "cacheCreateTokens": 0, "totalTokens": 15}}),
    ];
    let mut body = String::new();
    for l in &lines {
        body.push_str(&l.to_string());
        body.push('\n');
    }
    body.push('\n'); // trailing blank line
    let mut f = std::fs::File::create(data_dir.join("messages.jsonl")).unwrap();
    f.write_all(body.as_bytes()).unwrap();
}

#[test]
fn imports_jsonl_losslessly_keeps_file() {
    let dir = tempfile::tempdir().unwrap();
    seed_legacy(dir.path());
    let store = open_transcript_store(dir.path(), SESSION_ID);
    let all = store.read_all();
    assert_eq!(all.len(), 4);
    assert_eq!(store.count(), 4);
    assert_eq!(
        all.iter().map(|e| e.log_seq).collect::<Vec<_>>(),
        vec![Some(0), Some(1), Some(2), Some(3)]
    );
    let with_attachment = all.iter().find(|e| e.id == "e2").unwrap();
    let atts = with_attachment.attachments.as_ref().unwrap();
    assert_eq!(atts.len(), 1);
    assert_eq!(atts[0].name, "img.png");
    assert_eq!(with_attachment.text.as_deref(), Some("see this"));
    assert_eq!(with_attachment.turn_id.as_deref(), Some("t2"));
    assert!(dir.path().join("messages.jsonl").exists());
    assert!(transcript_db_path(dir.path()).exists());
}

#[test]
fn jsonl_migration_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    seed_legacy(dir.path());
    {
        let s = open_transcript_store(dir.path(), SESSION_ID);
        assert_eq!(s.count(), 4);
    }
    let mut s2 = open_transcript_store(dir.path(), SESSION_ID);
    assert_eq!(s2.count(), 4);
    let seq = s2.append(&mut ev(
        NormalizedEventKind::User,
        serde_json::json!({"text": "new", "turnId": "t3"}),
    ));
    assert_eq!(seq, 4);
}

#[test]
fn import_transaction_dedups_and_persists_watermark() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    // Seed one turn t1 so a re-import of t1 dedups.
    append_turn(&mut store, "t1");
    store.append(&mut ev(
        NormalizedEventKind::Result,
        serde_json::json!({"turnId": "t1"}),
    ));

    let events = vec![
        ev(
            NormalizedEventKind::User,
            serde_json::json!({"text": "q t1", "turnId": "t1"}),
        ), // dup by turn id
        ev(
            NormalizedEventKind::User,
            serde_json::json!({"text": "fresh", "turnId": "t9"}),
        ),
        ev(
            NormalizedEventKind::Text,
            serde_json::json!({"role": "assistant", "text": "a", "turnId": "t9"}),
        ),
    ];
    let outcome: ImportOutcome = store.import_transaction(
        events,
        vst_store::transcript::ImportOptions {
            cli: "claude".into(),
            cursor: "cur-1".into(),
        },
    );
    assert_eq!(outcome.turns_skipped, 1);
    assert_eq!(outcome.turns_imported, 1);
    assert_eq!(outcome.imported, 2);
    assert_eq!(outcome.cursor, "cur-1");
    let wm: Option<NativeWatermark> = store.get_native_watermark();
    assert_eq!(wm.unwrap().cursor, "cur-1");
}
