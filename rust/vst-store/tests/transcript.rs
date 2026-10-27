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
    let page = store.tail(20, usize::MAX);
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
    let page = store.tail(20, usize::MAX);
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
    let tail = store.tail(2, usize::MAX);
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
    let tail = store.tail(20, usize::MAX);
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

    let tail = store.tail(20, usize::MAX);
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
    assert!(store.tail(20, usize::MAX).events.is_empty());
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

/// Regression test for the daemon-aborting bug: two callers opening the SAME
/// brand-new session's `messages.db` concurrently (live-reproduced as a
/// direct-agent session's `chat:open` racing its own auto-enqueued turn-1)
/// must not panic. Before the fix, both threads' `PRAGMA table_info`
/// idempotency check saw the `superseded` column missing (neither had
/// committed yet), both ran `ALTER TABLE ... ADD COLUMN`, the loser's
/// statement failed with `SqliteFailure` ("duplicate column name:
/// superseded"), and that error propagated through `TranscriptStore::new`'s
/// `?` into `open_transcript_store`'s `.expect()` — aborting the entire
/// daemon process, not just the one racing session.
///
/// This spawns many concurrent openers on one fresh path and asserts every
/// single one returns successfully. Caveat, checked by hand rather than
/// asserted here: this synchronous, in-process thread race does NOT
/// reliably reproduce the exact interleaving on its own — SQLite's
/// writer-serialization narrows the window far more than the real bug's
/// actual trigger (two independent `tokio` tasks, each with an `.await`
/// spanning a store-actor round trip, racing across a multithreaded
/// runtime and a live TCP/WS round trip). Verified by hand that this test
/// still passes 5/5 runs even with the fix reverted — so its value is as a
/// basic "concurrent first-open works at all" sanity check and a home for
/// a stronger repro if one is added later, not as proof the fix closes the
/// race. The fix itself (tolerate `duplicate column name` as "someone else
/// already added it") is correct by inspection: it matches the exact error
/// string captured from the live crash.
#[test]
fn concurrent_first_open_does_not_panic_on_superseded_column_race() {
    let dir = tempfile::tempdir().unwrap();
    let data_dir = std::sync::Arc::new(dir.path().to_path_buf());
    const THREAD_COUNT: usize = 8;
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(THREAD_COUNT));

    let handles: Vec<_> = (0..THREAD_COUNT)
        .map(|i| {
            let data_dir = data_dir.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                // Must not panic — this is the exact call path that used to
                // abort the process (`open_transcript_store`'s `.expect()`).
                let _store = open_transcript_store(&data_dir, &format!("race-session-{i}"));
            })
        })
        .collect();

    for h in handles {
        h.join()
            .expect("open_transcript_store must not panic under concurrent first-open");
    }
}

// ---------------------------------------------------------------------------
// Phase 3 — importer dedupe (Decision 4c): tool-id skip rule, watermark, gating
// ---------------------------------------------------------------------------

#[test]
fn import_skips_group_with_existing_tool_id_only() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    // Live log has toolu_A under a DIFFERENT turn id.
    store.append(&mut ev(
        NormalizedEventKind::User,
        serde_json::json!({"text": "q live", "turnId": "live"}),
    ));
    store.append(&mut ev(
        NormalizedEventKind::ToolUse,
        serde_json::json!({"toolId": "toolu_A", "turnId": "live"}),
    ));

    let events = vec![
        // Group t1 carries toolu_A (already in log) -> skipped even though t1 is new.
        ev(
            NormalizedEventKind::User,
            serde_json::json!({"text": "q t1", "turnId": "t1"}),
        ),
        ev(
            NormalizedEventKind::ToolUse,
            serde_json::json!({"toolId": "toolu_A", "turnId": "t1"}),
        ),
        // Group t2 has only toolu_B -> imported.
        ev(
            NormalizedEventKind::User,
            serde_json::json!({"text": "q t2", "turnId": "t2"}),
        ),
        ev(
            NormalizedEventKind::ToolUse,
            serde_json::json!({"toolId": "toolu_B", "turnId": "t2"}),
        ),
        // A human prompt with no tools and new text -> imported.
        ev(
            NormalizedEventKind::User,
            serde_json::json!({"text": "yes", "turnId": "y1"}),
        ),
    ];
    let outcome = store.import_transaction(
        events,
        vst_store::transcript::ImportOptions {
            cli: "claude".into(),
            cursor: "c".into(),
        },
    );
    assert_eq!(outcome.turns_imported, 2);
    assert_eq!(outcome.turns_skipped, 1);
}

#[test]
fn reimport_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    let events = vec![
        ev(
            NormalizedEventKind::User,
            serde_json::json!({"text": "q", "turnId": "n1"}),
        ),
        ev(
            NormalizedEventKind::ToolUse,
            serde_json::json!({"toolId": "toolu_B", "turnId": "n1"}),
        ),
    ];
    let opts = vst_store::transcript::ImportOptions {
        cli: "claude".into(),
        cursor: "c".into(),
    };
    let first = store.import_transaction(events.clone(), opts.clone());
    assert_eq!(first.turns_imported, 1);
    // Same native-uuid turn id (and tool id) already in the log -> skipped.
    let second = store.import_transaction(events.clone(), opts.clone());
    assert_eq!(second.turns_imported, 0);
}

fn opts(cursor: &str) -> vst_store::transcript::ImportOptions {
    vst_store::transcript::ImportOptions {
        cli: "claude".into(),
        cursor: cursor.into(),
    }
}

fn text_ev(text: &str, turn: &str) -> NormalizedEvent {
    ev(
        NormalizedEventKind::Text,
        serde_json::json!({"role": "assistant", "text": text, "turnId": turn}),
    )
}

/// Live `notif-*` turn: no user row, text streamed as several small rows.
fn seed_live_notif(store: &mut vst_store::transcript::TranscriptStore) {
    for chunk in ["Wake-up: ", "build ", "finished.\n"] {
        store.append(&mut text_ev(chunk, "notif-1"));
    }
}

#[test]
fn text_only_autonomous_group_matching_live_notif_turn_is_skipped() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    seed_live_notif(&mut store);
    let out = store.import_transaction(
        vec![text_ev("Wake-up: build finished.", "native-uuid")],
        opts("c"),
    );
    assert_eq!((out.turns_imported, out.turns_skipped), (0, 1));
}

#[test]
fn text_only_autonomous_group_with_new_text_is_imported_once() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    seed_live_notif(&mut store);
    let events = vec![text_ev("Something else happened.", "native-2")];
    let first = store.import_transaction(events.clone(), opts("c"));
    assert_eq!((first.turns_imported, first.turns_skipped), (1, 0));
    let second = store.import_transaction(events, opts("c"));
    assert_eq!((second.turns_imported, second.turns_skipped), (0, 1));
}

#[test]
fn reimport_of_mixed_log_adds_no_rows() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    let log = |sfx: &str| {
        vec![
            ev(
                NormalizedEventKind::User,
                serde_json::json!({"text": "do it", "turnId": format!("h1{sfx}")}),
            ),
            text_ev("ok", &format!("h1{sfx}")),
            ev(
                NormalizedEventKind::ToolUse,
                serde_json::json!({"toolId": "toolu_Z", "turnId": format!("a1{sfx}")}),
            ),
            text_ev("tool turn", &format!("a1{sfx}")),
            text_ev("wake-up text", &format!("a2{sfx}")),
        ]
    };
    let first = store.import_transaction(log(""), opts("c"));
    assert_eq!(first.turns_imported, 3);
    // Fresh turn ids: only the content rule (human + text-only) and the tool id
    // rule can recognise these as already present.
    let second = store.import_transaction(log("-again"), opts("c"));
    assert_eq!(
        (second.imported, second.turns_imported, second.turns_skipped),
        (0, 0, 3)
    );
}

#[test]
fn text_matching_group_with_new_tool_ids_is_imported() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    seed_live_notif(&mut store);
    let events = vec![
        text_ev("Wake-up: build finished.", "n1"),
        ev(
            NormalizedEventKind::ToolUse,
            serde_json::json!({"toolId": "toolu_new", "turnId": "n1"}),
        ),
    ];
    let out = store.import_transaction(events, opts("c"));
    assert_eq!((out.turns_imported, out.turns_skipped), (1, 0));
}

#[test]
fn identical_text_only_groups_in_one_import_dedupe() {
    // Content identity: two text-only autonomous groups with the same text are
    // the same turn as far as the log can tell, so only the first is imported.
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    let events = vec![text_ev("tick", "n1"), text_ev("tick", "n2")];
    let out = store.import_transaction(events, opts("c"));
    assert_eq!((out.turns_imported, out.turns_skipped), (1, 1));
}

#[test]
fn cancelled_live_user_row_does_not_suppress_terminal_prompt() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    let mut queued = ev(
        NormalizedEventKind::User,
        serde_json::json!({"text": "retry me", "turnId": "q1"}),
    );
    store.append(&mut queued);
    let mut cancelled = ev(
        NormalizedEventKind::User,
        serde_json::json!({"text": "retry me", "turnId": "q1"}),
    );
    cancelled.cancelled = Some(true);
    store.append(&mut cancelled);
    let events = vec![ev(
        NormalizedEventKind::User,
        serde_json::json!({"text": "retry me", "turnId": "native-1"}),
    )];
    let out = store.import_transaction(events, opts("c"));
    assert_eq!((out.turns_imported, out.turns_skipped), (1, 0));
}

#[test]
fn human_prompt_matching_existing_user_text_is_skipped_new_one_imported() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    store.append(&mut ev(
        NormalizedEventKind::User,
        serde_json::json!({"text": "hello", "turnId": "t0"}),
    ));
    let dup = vec![ev(
        NormalizedEventKind::User,
        serde_json::json!({"text": " hello ", "turnId": "t9"}),
    )];
    let out = store.import_transaction(dup, opts("c"));
    assert_eq!((out.turns_imported, out.turns_skipped), (0, 1));
    let fresh = vec![ev(
        NormalizedEventKind::User,
        serde_json::json!({"text": "brand new", "turnId": "t10"}),
    )];
    let out = store.import_transaction(fresh, opts("c"));
    assert_eq!((out.turns_imported, out.turns_skipped), (1, 0));
}

// ---------------------------------------------------------------------------
// Budgeted tail (Phase 1 — chat-load-byte-budget)
// ---------------------------------------------------------------------------

/// Append a turn with a `user` row carrying `text` plus a `result` row, and
/// return the turn's first seq. `text` controls the serialized payload size.
fn append_turn_with_text(
    store: &mut vst_store::transcript::TranscriptStore,
    turn_id: &str,
    text: &str,
) -> i64 {
    let first = store.append(&mut ev(
        NormalizedEventKind::User,
        serde_json::json!({"role": "user", "text": text, "turnId": turn_id}),
    ));
    store.append(&mut ev(
        NormalizedEventKind::Result,
        serde_json::json!({"turnId": turn_id}),
    ));
    first
}

// a budget that accommodates the whole candidate window is identical to
// the old unbudgeted behaviour (all N turns, correct cursor, positive bytes).
#[test]
fn tail_under_budget_is_identical_to_old_behaviour() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    let mut first_seqs = std::collections::HashMap::new();
    for i in 1..=5 {
        first_seqs.insert(
            format!("t{i}"),
            append_turn_with_text(&mut store, &format!("t{i}"), "a"),
        );
    }
    let page = store.tail(5, usize::MAX);
    assert_eq!(page.events.len(), 10, "five turns of two events each");
    assert_eq!(page.oldest_seq, Some(first_seqs["t1"]));
    assert!(!page.has_more);
    assert!(page.payload_bytes > 0);
    assert!(page.events.iter().all(|e| e.turn_id.is_some()));
}

// a budget that fits exactly the newest 2 of 5 turns returns those 2,
// sets `has_more`, and points `oldest_seq` at the included oldest turn.
#[test]
fn tail_budget_fits_two_of_five_turns() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    let mut first_seqs = std::collections::HashMap::new();
    for i in 1..=5 {
        first_seqs.insert(
            format!("t{i}"),
            append_turn_with_text(&mut store, &format!("t{i}"), "x"),
        );
    }
    // Measure the newest 2 turns' combined size, then request that as the budget.
    let two = store.tail(2, usize::MAX);
    let budget = two.payload_bytes;
    let page = store.tail(5, budget);
    let turn_ids: std::collections::BTreeSet<String> = page
        .events
        .iter()
        .filter_map(|e| e.turn_id.clone())
        .collect();
    assert_eq!(
        turn_ids,
        ["t4", "t5"].into_iter().map(String::from).collect()
    );
    assert_eq!(page.oldest_seq, Some(first_seqs["t4"]));
    assert!(page.has_more);
    assert_eq!(page.payload_bytes, two.payload_bytes);
}

// a newest turn larger than the budget is returned WHOLE (turn-aligned
// invariant), older turns are excluded, and `has_more` is set. Budget 0 behaves
// the same (newest turn only).
#[test]
fn oversize_newest_turn_is_returned_whole_older_excluded() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    append_turn_with_text(&mut store, "t1", "small");
    append_turn_with_text(&mut store, "t2", "small");
    append_turn_with_text(&mut store, "t3", &"雪".repeat(1000)); // newest, huge

    let page = store.tail(5, 100);
    assert_eq!(page.events.len(), 2);
    assert!(page
        .events
        .iter()
        .all(|e| e.turn_id.as_deref() == Some("t3")));
    assert!(page.has_more);

    let zero = store.tail(5, 0);
    assert_eq!(zero.events.len(), 2);
    assert!(zero
        .events
        .iter()
        .all(|e| e.turn_id.as_deref() == Some("t3")));
    assert!(zero.has_more);
}

// contiguity: the walk STOPS at the first turn that does not fit, so a
// small older turn sitting behind an oversize middle turn is NOT pulled in.
#[test]
fn tail_does_not_pull_older_turn_behind_oversize_middle() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    append_turn_with_text(&mut store, "t1", "small"); // oldest, small
    append_turn_with_text(&mut store, "t2", &"雪".repeat(1000)); // middle, huge
    append_turn_with_text(&mut store, "t3", "small"); // newest, small

    let page = store.tail(5, 200);
    assert_eq!(page.events.len(), 2);
    assert!(page
        .events
        .iter()
        .all(|e| e.turn_id.as_deref() == Some("t3")));
    assert!(!page
        .events
        .iter()
        .any(|e| e.turn_id.as_deref() == Some("t1")));
    assert!(page.has_more);
}

// `page_before` on a budgeted tail's `oldest_seq` returns the next older
// turn, so the client can still page earlier past a byte-truncated window.
#[test]
fn page_before_budgeted_tail_returns_next_older_turn() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    let mut first_seqs = std::collections::HashMap::new();
    for i in 1..=5 {
        first_seqs.insert(
            format!("t{i}"),
            append_turn_with_text(&mut store, &format!("t{i}"), "x"),
        );
    }
    let budget = store.tail(2, usize::MAX).payload_bytes;
    let tail = store.tail(5, budget);
    assert_eq!(tail.oldest_seq, Some(first_seqs["t4"]));

    let page = store.page_before(tail.oldest_seq.unwrap(), 2);
    assert_eq!(page.oldest_seq, Some(first_seqs["t3"]));
    assert!(page
        .events
        .iter()
        .any(|e| e.turn_id.as_deref() == Some("t3")));
    assert!(page.has_more);
}

// NULL turn_id rows count toward the SEQ RANGE they sit in (they form
// their own group in the turn walk), and an old NULL group cannot be used to
// smuggle an older turn past the budget.
#[test]
fn null_turn_rows_count_toward_their_seq_range_and_cannot_bypass_budget() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    append_turn_with_text(&mut store, "t1", "a"); // seq 0, 1
                                                  // A NULL turn_id row sits between t1 and t2 (seq 2) — its own group.
    store.append(&mut ev(
        NormalizedEventKind::Text,
        serde_json::json!({"role": "assistant", "text": "orphan", "turnId": serde_json::Value::Null}),
    ));
    append_turn_with_text(&mut store, "t2", "b"); // newest, seq 3, 4

    // Budget fits t2 + the NULL row but not t1: the NULL group is the oldest
    // included turn and t1 stays out.
    let budget = store.tail(2, usize::MAX).payload_bytes;
    let page = store.tail(5, budget);
    assert!(page.events.iter().any(|e| e.turn_id.is_none()));
    assert!(!page
        .events
        .iter()
        .any(|e| e.turn_id.as_deref() == Some("t1")));
    assert_eq!(page.oldest_seq, Some(2));
    assert!(page.has_more);
}

// interleaved turn ids are sized by SEQ RANGE (matching `page_from`);
// superseded rows are excluded from events AND bytes; multibyte (UTF-8)
// payloads are counted in bytes, not chars.
#[test]
fn tail_is_seq_aligned_and_counts_utf8_bytes_and_excludes_superseded() {
    // Interleaved turn ids: rows alternate, so the only reliable boundary is
    // the seq range; tail loads a contiguous seq window via `page_from`.
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    store.append(&mut ev(
        NormalizedEventKind::User,
        serde_json::json!({"role": "user", "text": "u1", "turnId": "t1"}),
    ));
    store.append(&mut ev(
        NormalizedEventKind::Text,
        serde_json::json!({"role": "assistant", "text": "a2", "turnId": "t2"}),
    ));
    store.append(&mut ev(
        NormalizedEventKind::User,
        serde_json::json!({"role": "user", "text": "u3", "turnId": "t1"}),
    ));
    store.append(&mut ev(
        NormalizedEventKind::Result,
        serde_json::json!({"turnId": "t2"}),
    ));
    let page = store.tail(2, usize::MAX);
    assert_eq!(
        page.events.len(),
        4,
        "both interleaved turns, contiguous by seq"
    );
    assert_eq!(page.oldest_seq, Some(0));
    assert!(!page.has_more);

    // Multibyte counted in bytes: 100 CJK chars = 300 UTF-8 bytes; the page's
    // payload_bytes must reflect the byte count, not a char count.
    let dir2 = tempfile::tempdir().unwrap();
    let mut s2 = open_transcript_store(dir2.path(), SESSION_ID);
    append_turn_with_text(&mut s2, "m", &"雪".repeat(100));
    let multibyte = s2.tail(1, usize::MAX);
    assert!(
        multibyte.payload_bytes >= 300,
        "multibyte payload counted in bytes, got {}",
        multibyte.payload_bytes
    );

    // Superseded rows excluded from both events and the byte total: a huge
    // NEWER turn is superseded (rows `seq >= fork`), leaving the small live
    // turn; the big turn's bytes must not be counted.
    let dir3 = tempfile::tempdir().unwrap();
    let mut s3 = open_transcript_store(dir3.path(), SESSION_ID);
    append_turn_with_text(&mut s3, "live", &"B".repeat(50)); // seq 0, 1
    let dead = append_turn_with_text(&mut s3, "dead", &"A".repeat(500)); // seq 2, 3
    s3.mark_superseded_from(dead);
    let live = s3.tail(5, usize::MAX);
    assert!(live
        .events
        .iter()
        .all(|e| e.turn_id.as_deref() == Some("live")));
    assert!(
        live.payload_bytes < 500,
        "superseded turn's bytes not counted, got {}",
        live.payload_bytes
    );
}

// Review follow-up — with a real budget, an interleaved turn's rows are sized
// by the seq range they sit in (not by turn_id), matching what `page_from` loads.
#[test]
fn tail_budget_attributes_interleaved_rows_by_seq_range() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    for (kind, turn) in [
        (NormalizedEventKind::User, "t1"),
        (NormalizedEventKind::Text, "t2"),
        (NormalizedEventKind::User, "t1"),
        (NormalizedEventKind::Result, "t2"),
    ] {
        store.append(&mut ev(
            kind,
            serde_json::json!({"role": "assistant", "text": "x", "turnId": turn}),
        ));
    }
    // t2 starts at seq 1 and owns seq 1..=3 (including t1's second row).
    let newest = store.tail(1, usize::MAX);
    assert_eq!(newest.events.len(), 3);
    let page = store.tail(2, newest.payload_bytes);
    assert_eq!(page.oldest_seq, Some(1));
    assert_eq!(page.events.len(), 3);
    assert!(page.has_more);
}

// Review follow-up — superseded rows must not count toward a turn's size.
#[test]
fn tail_budget_ignores_superseded_rows_when_sizing() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    append_turn_with_text(&mut store, "live", "b");
    let dead = append_turn_with_text(&mut store, "dead", &"A".repeat(5000));
    store.mark_superseded_from(dead);
    append_turn_with_text(&mut store, "new", "c");
    let all = store.tail(5, usize::MAX);
    assert!(all.payload_bytes < 5000);
    // A budget of exactly the live bytes keeps `live`; counting the dead rows
    // against it would push `live` out.
    let page = store.tail(5, all.payload_bytes);
    assert_eq!(page.events.len(), all.events.len());
    assert!(!page.has_more);
}

// ─── whole-file edit diff trim (one-time backfill) ──────────────────────────

/// A brand-new DB is marked as already-migrated on its first open, so a test
/// that appends rows with `append` (which bypasses the live trim) and then
/// reopens must first rewind the marker — exactly the state an upgraded daemon
/// finds: rows already on disk, marker still 0.
fn simulate_db_written_before_the_trim_migration(data_dir: &std::path::Path) {
    rusqlite::Connection::open(transcript_db_path(data_dir))
        .unwrap()
        .execute_batch("PRAGMA user_version = 0")
        .unwrap();
}

/// A 60-line file, each line padded so the whole file clears the trim threshold.
fn big_file(tag: &str) -> String {
    (1..=60)
        .map(|i| format!("{tag} line {i:03} ........................................\n"))
        .collect()
}

fn whole_file_diff() -> vst_types::ToolDiff {
    let old = big_file("before");
    let new = old
        .replace("before line 020 ", "after line 020  ")
        .replace("before line 050 ", "after line 050  ");
    vst_types::ToolDiff {
        path: "/big.ts".into(),
        old_text: Some(old),
        new_text: new,
        old_start: None,
        new_start: None,
    }
}

fn tool_event(kind: NormalizedEventKind, tool_id: &str) -> NormalizedEvent {
    let mut e = ev(kind, serde_json::json!({"turnId": "t1", "toolId": tool_id}));
    e.tool_diffs = Some(vec![whole_file_diff()]);
    e
}

#[test]
fn diff_trim_backfill_rewrites_whole_file_rows_on_both_row_kinds() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut s = open_transcript_store(dir.path(), SESSION_ID);
        s.append(&mut ev(
            NormalizedEventKind::User,
            serde_json::json!({"text": "q1", "turnId": "t1"}),
        ));
        // The same whole-file diff is stored twice: once on the tool_use, once
        // on the tool_result (normalize sets it on both).
        s.append(&mut tool_event(NormalizedEventKind::ToolUse, "tu-1"));
        s.append(&mut tool_event(NormalizedEventKind::ToolResult, "tu-1"));
    }

    simulate_db_written_before_the_trim_migration(dir.path());
    let s2 = open_transcript_store(dir.path(), SESSION_ID);
    let rows: Vec<_> = s2
        .read_all()
        .into_iter()
        .filter(|e| e.tool_diffs.is_some())
        .collect();
    assert_eq!(rows.len(), 2, "tool_use and tool_result rows both kept");
    for row in &rows {
        let diffs = row.tool_diffs.as_ref().unwrap();
        assert_eq!(diffs.len(), 2, "two changed regions => two hunks");
        assert_eq!(diffs[0].old_start, Some(17));
        assert_eq!(diffs[0].new_start, Some(17));
        assert_eq!(diffs[1].old_start, Some(47));
        assert_eq!(diffs[1].new_start, Some(47));
        assert!(diffs.iter().all(|d| d.new_text.len() < 1024));
        assert!(diffs[0].new_text.contains("after line 020"));
    }

    // One-shot marker + byte-identical second open: no re-diff, no rewrite.
    let db = transcript_db_path(dir.path());
    let version: i64 = rusqlite::Connection::open(&db)
        .unwrap()
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 1, "backfill marker set after the one-time pass");

    let before: Vec<String> = s2
        .read_all()
        .iter()
        .map(|e| serde_json::to_string(e).unwrap())
        .collect();
    let s3 = open_transcript_store(dir.path(), SESSION_ID);
    let after: Vec<String> = s3
        .read_all()
        .iter()
        .map(|e| serde_json::to_string(e).unwrap())
        .collect();
    assert_eq!(before, after, "reopen must not rewrite trimmed rows");
}

#[test]
fn diff_trim_backfill_leaves_small_and_write_diffs_alone() {
    let dir = tempfile::tempdir().unwrap();
    let small = vst_types::ToolDiff {
        path: "/a.ts".into(),
        old_text: Some("a\nb".into()),
        new_text: "a\nc".into(),
        old_start: None,
        new_start: None,
    };
    let write = vst_types::ToolDiff {
        path: "/new.ts".into(),
        old_text: Some(String::new()),
        new_text: big_file("brand new"),
        old_start: None,
        new_start: None,
    };
    {
        let mut s = open_transcript_store(dir.path(), SESSION_ID);
        s.append(&mut ev(
            NormalizedEventKind::User,
            serde_json::json!({"text": "q1", "turnId": "t1"}),
        ));
        let mut e = ev(
            NormalizedEventKind::ToolUse,
            serde_json::json!({"turnId": "t1", "toolId": "tu-1"}),
        );
        e.tool_diffs = Some(vec![small.clone(), write.clone()]);
        s.append(&mut e);
    }
    simulate_db_written_before_the_trim_migration(dir.path());
    let s2 = open_transcript_store(dir.path(), SESSION_ID);
    let row = s2
        .read_all()
        .into_iter()
        .find(|e| e.tool_diffs.is_some())
        .unwrap();
    assert_eq!(row.tool_diffs.unwrap(), vec![small, write]);
}

/// A 400-line file (~26 KB per side), so a whole-file diff trips the 20 KB
/// `tool_result` cap if the trim has not already shrunk it.
fn huge_file(tag: &str) -> String {
    (1..=400)
        .map(|i| format!("{tag} line {i:03} ................................................\n"))
        .collect()
}

/// The property the backfill comment says MUST hold: trim runs BEFORE the
/// oversized-diff cap. If the two blocks are ever reordered, the cap replaces
/// the whole file with `(diff omitted — N bytes)` and the hunks are gone.
#[test]
fn diff_trim_backfill_runs_before_the_oversized_cap() {
    let dir = tempfile::tempdir().unwrap();
    let old = huge_file("before");
    let new = old
        .replace("before line 100 ", "after line 100  ")
        .replace("before line 300 ", "after line 300  ");
    assert!(
        old.len() > vst_store::transcript::TOOL_RESULT_MAX_BYTES,
        "fixture must exceed the per-side cap"
    );
    {
        let mut s = open_transcript_store(dir.path(), SESSION_ID);
        let mut e = ev(
            NormalizedEventKind::ToolResult,
            serde_json::json!({"turnId": "t1", "toolId": "tu-huge"}),
        );
        e.tool_diffs = Some(vec![vst_types::ToolDiff {
            path: "/huge.ts".into(),
            old_text: Some(old),
            new_text: new,
            old_start: None,
            new_start: None,
        }]);
        s.append(&mut e);
    }

    simulate_db_written_before_the_trim_migration(dir.path());
    let s2 = open_transcript_store(dir.path(), SESSION_ID);
    let row = s2
        .read_all()
        .into_iter()
        .find(|e| e.tool_diffs.is_some())
        .unwrap();
    let diffs = row.tool_diffs.unwrap();

    assert_eq!(diffs.len(), 2, "two distant edits => two hunks");
    assert_eq!(diffs[0].old_start, Some(97));
    assert_eq!(diffs[0].new_start, Some(97));
    assert_eq!(diffs[1].old_start, Some(297));
    assert_eq!(diffs[1].new_start, Some(297));
    for d in &diffs {
        assert!(
            !d.new_text.contains("diff omitted"),
            "trim must beat the cap, not the other way round: {}",
            d.new_text
        );
        assert!(d.new_text.len() < 1024, "hunk-sized, not the whole file");
        assert!(d.new_text.contains("after line"));
    }
}

/// A malformed payload in a `tool_result` row must not abort the open (with
/// `panic = "abort"` that used to take down every session in the daemon,
/// because `json_extract` raises on non-JSON before serde ever sees the row).
#[test]
fn diff_trim_backfill_survives_a_malformed_payload_row() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut s = open_transcript_store(dir.path(), SESSION_ID);
        s.append(&mut ev(
            NormalizedEventKind::User,
            serde_json::json!({"text": "q1", "turnId": "t1"}),
        ));
    }
    let conn = rusqlite::Connection::open(transcript_db_path(dir.path())).unwrap();
    conn.execute(
        "INSERT INTO message (session_id, seq, ts, kind, turn_id, payload, superseded)
         VALUES (?1, 99, '2026-01-01T00:00:00Z', 'tool_result', 't1', 'not json', 0)",
        [SESSION_ID],
    )
    .unwrap();
    conn.execute_batch("PRAGMA user_version = 0").unwrap();
    drop(conn);

    // Must not panic / abort.
    let s = open_transcript_store(dir.path(), SESSION_ID);
    assert_eq!(
        s.read_all().len(),
        1,
        "the unparseable row is skipped on read, the valid one survives"
    );

    let version: i64 = rusqlite::Connection::open(transcript_db_path(dir.path()))
        .unwrap()
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 1, "the one-shot marker still advances");
}

/// `import_transaction` trims too (the import path bypasses the live normalize
/// trim), so a whole-file diff arriving from a native-history import is stored
/// as hunks.
#[test]
fn import_transaction_trims_a_whole_file_diff() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);

    let old = big_file("before");
    let new = old.replace("before line 020 ", "after line 020  ");
    let mut tool = ev(
        NormalizedEventKind::ToolUse,
        serde_json::json!({"turnId": "t-imp", "toolId": "tu-imp"}),
    );
    tool.tool_diffs = Some(vec![vst_types::ToolDiff {
        path: "/big.ts".into(),
        old_text: Some(old),
        new_text: new,
        old_start: None,
        new_start: None,
    }]);
    let events = vec![
        ev(
            NormalizedEventKind::User,
            serde_json::json!({"role": "user", "text": "edit it", "turnId": "t-imp"}),
        ),
        tool,
    ];

    let out: ImportOutcome = store.import_transaction(events, opts("c-imp"));
    assert_eq!(out.imported, 2);
    let rows = store.read_all();
    let imported = rows
        .iter()
        .find(|e| e.kind == NormalizedEventKind::ToolUse)
        .expect("tool row imported");
    let diffs = imported.tool_diffs.as_ref().expect("diffs kept");
    assert_eq!(diffs.len(), 1);
    assert_eq!(diffs[0].old_start, Some(17));
    assert_eq!(diffs[0].new_start, Some(17));
    assert!(diffs[0].new_text.contains("after line 020"));
    assert!(!diffs[0].new_text.contains("before line 001"));
}

// --- reset-keep-history-switch: append_batch + count_since_last_break ---

fn break_ev(seq_turn: &str) -> NormalizedEvent {
    serde_json::from_value(serde_json::json!({
        "id": format!("break-{seq_turn}"),
        "sessionId": SESSION_ID,
        "ts": "2026-01-02T00:00:00Z",
        "provider": "claude",
        "kind": "session_break",
        "breakKind": "switch",
        "fromProvider": "claude",
        "toProvider": "opencode",
        "turnId": format!("break-{seq_turn}"),
    }))
    .unwrap()
}

#[test]
fn append_batch_assigns_monotonic_seq_and_persists() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    let mut events = vec![
        ev(
            NormalizedEventKind::User,
            serde_json::json!({"text": "q", "turnId": "t1"}),
        ),
        ev(
            NormalizedEventKind::Text,
            serde_json::json!({"text": "a", "turnId": "t1"}),
        ),
    ];
    let n = store.append_batch(&mut events).unwrap();
    assert_eq!(n, 2);
    assert_eq!(events[0].log_seq, Some(0));
    assert_eq!(events[1].log_seq, Some(1));
    let all = store.read_all();
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].log_seq, Some(0));
    assert_eq!(all[1].log_seq, Some(1));

    // A second batch continues the sequence (monotonic across batches),
    // including when interleaved with a single `append`.
    let mut more = vec![
        ev(
            NormalizedEventKind::Text,
            serde_json::json!({"text": "b", "turnId": "t2"}),
        ),
        ev(
            NormalizedEventKind::Result,
            serde_json::json!({"turnId": "t2"}),
        ),
    ];
    store.append_batch(&mut more).unwrap();
    assert_eq!(more[0].log_seq, Some(2));
    assert_eq!(more[1].log_seq, Some(3));
    assert_eq!(store.count(), 4);
}

#[test]
fn append_batch_is_gap_free_and_reopens_contiguously() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    // Pre-persist one row so next_seq = 1.
    store.append(&mut ev(
        NormalizedEventKind::User,
        serde_json::json!({"text": "seed", "turnId": "t0"}),
    ));
    let mut batch = vec![
        ev(
            NormalizedEventKind::User,
            serde_json::json!({"text": "x", "turnId": "t1"}),
        ),
        ev(
            NormalizedEventKind::Text,
            serde_json::json!({"text": "y", "turnId": "t1"}),
        ),
    ];
    let n = store.append_batch(&mut batch).unwrap();
    assert_eq!(n, 2);
    // The whole batch wrote in one transaction -> no gap between seed (seq 0)
    // and the batch's first row (seq 1).
    assert_eq!(batch[0].log_seq, Some(1));
    assert_eq!(batch[1].log_seq, Some(2));
    // A following batch continues from the advanced cursor (seq 3).
    let mut after = vec![ev(
        NormalizedEventKind::User,
        serde_json::json!({"text": "z", "turnId": "t2"}),
    )];
    store.append_batch(&mut after).unwrap();
    assert_eq!(after[0].log_seq, Some(3));
    assert_eq!(store.count(), 4);

    // Reopen: next_seq reseeds from MAX, so the monotonic cursor is durable.
    drop(store);
    let reopened = open_transcript_store(dir.path(), SESSION_ID);
    assert_eq!(reopened.count(), 4);
    let seqs: Vec<i64> = reopened
        .read_all()
        .iter()
        .map(|e| e.log_seq.unwrap())
        .collect();
    assert_eq!(seqs, vec![0, 1, 2, 3]);
}

#[test]
fn count_since_last_break_no_break_counts_all() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    assert_eq!(store.count_since_last_break(), 0);
    store.append(&mut ev(
        NormalizedEventKind::User,
        serde_json::json!({"text": "q", "turnId": "t1"}),
    ));
    store.append(&mut ev(
        NormalizedEventKind::Text,
        serde_json::json!({"text": "a", "turnId": "t1"}),
    ));
    assert_eq!(store.count_since_last_break(), 2);
}

#[test]
fn count_since_last_break_with_middle_break() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    // two rows, break, two rows — only the after-break rows count.
    store.append(&mut ev(
        NormalizedEventKind::User,
        serde_json::json!({"text": "q1", "turnId": "t1"}),
    ));
    store.append(&mut ev(
        NormalizedEventKind::Text,
        serde_json::json!({"text": "a1", "turnId": "t1"}),
    ));
    store.append(&mut break_ev("mid"));
    store.append(&mut ev(
        NormalizedEventKind::User,
        serde_json::json!({"text": "q2", "turnId": "t2"}),
    ));
    store.append(&mut ev(
        NormalizedEventKind::Text,
        serde_json::json!({"text": "a2", "turnId": "t2"}),
    ));
    assert_eq!(store.count(), 5);
    assert_eq!(store.count_since_last_break(), 2);
}

#[test]
fn count_since_last_break_with_break_last() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    store.append(&mut ev(
        NormalizedEventKind::User,
        serde_json::json!({"text": "q", "turnId": "t1"}),
    ));
    store.append(&mut break_ev("last"));
    assert_eq!(store.count_since_last_break(), 0);
}

#[test]
fn read_last_returns_the_newest_rows_oldest_first() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID);
    for t in ["t1", "t2", "t3"] {
        append_turn(&mut store, t);
    }
    let last = store.read_last(4);
    assert_eq!(last.len(), 4);
    assert_eq!(
        last.iter().map(|e| e.log_seq).collect::<Vec<_>>(),
        vec![Some(5), Some(6), Some(7), Some(8)],
        "newest 4 rows, ascending"
    );
    assert_eq!(
        store.read_last(100).len(),
        9,
        "limit above count returns all"
    );
    assert!(store.read_last(0).is_empty());
}
