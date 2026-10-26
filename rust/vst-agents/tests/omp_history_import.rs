//! Behavior contract for the omp at-rest native-history importer (`omp_import.rs`).
//! Exercises the active-branch path walk, the complete-turn watermark rule, and
//! the tolerant two-pass parse against three fixtures: two real 18.12.6 captures
//! and a hand-built synthetic edge file (see `fixtures/omp/README.txt`).

use std::path::PathBuf;
use std::sync::Arc;

use vst_agents::json_agent_session::{JsonAgentSession, JsonAgentSessionOptions};
use vst_agents::native_history_importer::{
    NativeHistoryImporter, NativeImportRequest, NativeImportResult,
};
use vst_agents::omp_import::{
    import_omp_history, omp_current_cursor, omp_history_importer, OmpHistoryImporter,
};
use vst_store::transcript::open_transcript_store;
use vst_types::{NormalizedEvent, NormalizedEventKind, Role};

mod common;

const SESSION: &str = "sess-omp-1";
const TOOL_TURN: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/omp/session-18.12.6-tool-turn.jsonl"
);
const TWO_PLAIN: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/omp/session-18.12.6-two-plain-turns.jsonl"
);
const SYNTHETIC: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/omp/session-synthetic-edge.jsonl"
);

fn kinds(events: &[NormalizedEvent]) -> Vec<NormalizedEventKind> {
    events.iter().map(|e| e.kind).collect()
}

fn texts(events: &[NormalizedEvent]) -> Vec<&str> {
    events
        .iter()
        .map(|e| e.text.as_deref().unwrap_or(""))
        .collect()
}

// ---------------------------------------------------------------------------
// 1.T1 — tool-turn fixture golden
// ---------------------------------------------------------------------------

#[test]
fn tool_turn_golden_order_and_single_turn() {
    let (events, wm) = import_omp_history(std::path::Path::new(TOOL_TURN), SESSION, None);
    assert_eq!(
        kinds(&events),
        vec![
            NormalizedEventKind::User,
            NormalizedEventKind::ToolUse,
            NormalizedEventKind::Usage,
            NormalizedEventKind::ToolResult,
            NormalizedEventKind::ToolUse,
            NormalizedEventKind::Usage,
            NormalizedEventKind::ToolResult,
            NormalizedEventKind::Text,
            NormalizedEventKind::Usage,
        ]
    );
    // Tool names/ids in the right slots.
    let tool_uses: Vec<_> = events
        .iter()
        .filter(|e| e.kind == NormalizedEventKind::ToolUse)
        .collect();
    assert_eq!(tool_uses[0].tool_name.as_deref(), Some("read"));
    assert_eq!(
        tool_uses[0].tool_id.as_deref(),
        Some("call_317a4de79d4d4438a99804ef")
    );
    assert_eq!(tool_uses[1].tool_name.as_deref(), Some("write"));
    assert_eq!(
        tool_uses[1].tool_id.as_deref(),
        Some("call_d8387014c5f24f2296783e09")
    );
    // `"i"` (omp's injected intent arg) is stripped from tool_input.
    let read_input = tool_uses[0]
        .tool_input
        .as_ref()
        .unwrap()
        .as_object()
        .unwrap();
    assert!(!read_input.contains_key("i"));
    assert_eq!(
        read_input.get("path").and_then(|v| v.as_str()),
        Some("notes.txt")
    );
    let write_input = tool_uses[1]
        .tool_input
        .as_ref()
        .unwrap()
        .as_object()
        .unwrap();
    assert!(!write_input.contains_key("i"));
    assert_eq!(
        write_input.get("content").and_then(|v| v.as_str()),
        Some("done")
    );
    // Tool results carry the right content.
    let results: Vec<_> = events
        .iter()
        .filter(|e| e.kind == NormalizedEventKind::ToolResult)
        .collect();
    assert_eq!(
        results[0].tool_result.as_ref().unwrap().content.as_deref(),
        Some("alpha beta")
    );
    assert_eq!(
        results[1].tool_result.as_ref().unwrap().content.as_deref(),
        Some("Successfully wrote 4 bytes to out.txt")
    );
    // The final assistant text — `"\n\n"` lead blocks are skipped.
    let text = events
        .iter()
        .find(|e| e.kind == NormalizedEventKind::Text)
        .unwrap();
    assert_eq!(
        text.text.as_deref(),
        Some("notes.txt says: `alpha beta`.\n\nCreated out.txt containing `done`.")
    );
    // Every event shares one turn_id (the user entry id).
    let turn_ids: std::collections::HashSet<_> = events.iter().map(|e| e.turn_id.clone()).collect();
    assert_eq!(turn_ids.len(), 1);
    assert_eq!(turn_ids.iter().next().unwrap().as_deref(), Some("a1cd998f"));
    for e in &events {
        assert_eq!(e.session_id, SESSION);
        assert_eq!(e.provider, vst_types::NormalizedEventProvider::Omp);
    }
    // Usage numbers from the assistant messages.
    let usages: Vec<_> = events
        .iter()
        .filter(|e| e.kind == NormalizedEventKind::Usage)
        .collect();
    assert_eq!(usages.len(), 3);
    assert_eq!(usages[0].usage.as_ref().unwrap().input_tokens, 7589);
    assert_eq!(
        usages[0].usage.as_ref().unwrap().model,
        "deepseek-local/deepseek-v4-flash-0731"
    );
    // Watermark = last path entry (session_exit id) — not the last emitted event.
    assert_eq!(wm, "2cd1e10f");
}

// ---------------------------------------------------------------------------
// 1.T2 — two-plain-turns fixture
// ---------------------------------------------------------------------------

#[test]
fn two_plain_turns_distinct_ids_and_exact_text() {
    let (events, wm) = import_omp_history(std::path::Path::new(TWO_PLAIN), SESSION, None);
    assert_eq!(
        kinds(&events),
        vec![
            NormalizedEventKind::User,
            NormalizedEventKind::Text,
            NormalizedEventKind::Usage,
            NormalizedEventKind::User,
            NormalizedEventKind::Text,
            NormalizedEventKind::Usage,
        ]
    );
    let users: Vec<_> = events
        .iter()
        .filter(|e| e.kind == NormalizedEventKind::User)
        .collect();
    assert_eq!(users[0].text.as_deref(), Some("Say hi in one word."));
    assert_eq!(
        users[1].text.as_deref(),
        Some("Write the numbers one to five as words, comma separated, nothing else.")
    );
    // The assistant texts are exact.
    assert!(texts(&events).contains(&"Hi"));
    assert!(texts(&events).contains(&"one, two, three, four, five"));
    // Two DISTINCT turn ids = the two user entry ids.
    let turn_ids: Vec<_> = events
        .iter()
        .filter(|e| e.kind == NormalizedEventKind::User)
        .map(|e| e.turn_id.clone().unwrap())
        .collect();
    assert_eq!(
        turn_ids,
        vec!["dc339874".to_string(), "12dd5e33".to_string()]
    );
    // `session_exit` leaf is a no-op (no event), but drives the watermark.
    assert_eq!(wm, "1a418cbd");
    assert!(events.iter().all(|e| e.kind != NormalizedEventKind::Error));
}

// ---------------------------------------------------------------------------
// 1.T3 — synthetic edge fixture
// ---------------------------------------------------------------------------

#[test]
fn synthetic_edge_cases() {
    let (events, _wm) = import_omp_history(std::path::Path::new(SYNTHETIC), SESSION, None);
    let event_texts = texts(&events);
    let all_text: String = event_texts.join("|");

    // Thinking block emitted.
    assert!(events
        .iter()
        .any(|e| e.kind == NormalizedEventKind::Thinking));
    assert!(all_text.contains("let me think about this"));
    // String-content user message imported.
    assert!(all_text.contains("hello from a string user"));
    // attribution:"agent" user skipped (its text never appears).
    assert!(!all_text.contains("internal injected guidance"));
    // Abandoned sibling branch absent.
    assert!(!all_text.contains("abandoned sibling branch"));
    // Trailing off-branch model_usage is not on the path (never in output) and
    // does not become the leaf (its parent would fork).
    assert!(!all_text.contains("summary"));

    // Order of events.
    assert_eq!(
        kinds(&events),
        vec![
            NormalizedEventKind::User,     // u1 (string user)
            NormalizedEventKind::Thinking, // a1 thinking
            NormalizedEventKind::Text,     // a1 "I read the file."
            NormalizedEventKind::Usage,    // a1
            NormalizedEventKind::Text,     // a2 "follow up"
            NormalizedEventKind::Usage,    // a2
            NormalizedEventKind::User,     // u2
            NormalizedEventKind::Status,   // compaction
            NormalizedEventKind::User,     // u3
            NormalizedEventKind::Text,     // a3
            NormalizedEventKind::Usage,    // a3
        ]
    );

    // compaction → Status with turn_id = the compaction entry id.
    let status = events
        .iter()
        .find(|e| e.kind == NormalizedEventKind::Status)
        .unwrap();
    assert_eq!(status.text.as_deref(), Some("Conversation compacted"));
    assert_eq!(status.turn_id.as_deref(), Some("cp"));

    // Nothing before reset_boundary: the pre-reset turn (u0/a0) never appears.
    assert!(!all_text.contains("turn before reset"));
    assert!(!all_text.contains("pre-reset reply"));
    // Turn ids: u1's turn ids all equal u1; u2's user has u2; u3's user has u3.
    let u1_events: Vec<_> = events
        .iter()
        .filter(|e| e.turn_id.as_deref() == Some("u1"))
        .collect();
    assert!(u1_events
        .iter()
        .any(|e| e.kind == NormalizedEventKind::User));
    assert!(u1_events
        .iter()
        .any(|e| e.kind == NormalizedEventKind::Thinking));
}

// ---------------------------------------------------------------------------
// 1.T4 — watermark semantics
// ---------------------------------------------------------------------------

fn tmp_dir() -> PathBuf {
    // A counter, not just the clock: parallel tests can land on the same tick.
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let d = std::env::temp_dir().join(format!(
        "ompi-{}-{}-{:?}",
        std::process::id(),
        N.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn watermark_reimport_appended_turn_unknown_and_sibling() {
    let dir = tmp_dir();
    // Build an importable file with two complete turns; the first import emits
    // both and returns the LAST path entry as the watermark.
    let lines = [
        r#"{"type":"session","version":3,"id":"s","timestamp":"t"}"#,
        r#"{"type":"model_change","id":"m1","parentId":null,"timestamp":"t"}"#,
        r#"{"type":"message","id":"u1","parentId":"m1","timestamp":"t","message":{"role":"user","content":[{"type":"text","text":"one"}]}}"#,
        r#"{"type":"message","id":"a1","parentId":"u1","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"A1"}],"usage":{"totalTokens":5},"stopReason":"stop"}}"#,
        r#"{"type":"message","id":"u2","parentId":"a1","timestamp":"t","message":{"role":"user","content":[{"type":"text","text":"two"}]}}"#,
        r#"{"type":"message","id":"a2","parentId":"u2","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"A2"}],"usage":{"totalTokens":6},"stopReason":"stop"}}"#,
    ];
    let file = dir.join("2026-10-22T00-00-00-000Z_chat.jsonl");
    std::fs::write(&file, format!("{}\n", lines.join("\n"))).unwrap();

    let (e1, wm1) = import_omp_history(&file, SESSION, None);
    assert_eq!(
        e1.iter()
            .filter(|e| e.kind == NormalizedEventKind::User)
            .count(),
        2
    );
    // watermark = last path entry (a2's id).
    assert_eq!(wm1, "a2");

    // Re-import with that watermark → nothing new, watermark echoed.
    let (e2, wm2) = import_omp_history(&file, SESSION, Some(&wm1));
    assert!(e2.is_empty());
    assert_eq!(wm2, wm1);

    // Append a complete third turn → only that turn imported.
    let with_t3 = format!(
        "{}\n{}\n{}\n",
        lines.join("\n"),
        r#"{"type":"message","id":"u3","parentId":"a2","timestamp":"t","message":{"role":"user","content":[{"type":"text","text":"three"}]}}"#,
        r#"{"type":"message","id":"a3","parentId":"u3","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"A3"}],"usage":{"totalTokens":7},"stopReason":"stop"}}"#,
    );
    std::fs::write(&file, &with_t3).unwrap();

    let (e3, wm3) = import_omp_history(&file, SESSION, Some(&wm1));
    let users3: Vec<_> = e3
        .iter()
        .filter(|e| e.kind == NormalizedEventKind::User)
        .collect();
    assert_eq!(users3.len(), 1);
    assert_eq!(users3[0].text.as_deref(), Some("three"));
    assert_eq!(wm3, "a3");

    // Unknown id → full path re-emitted.
    let (e4, _) = import_omp_history(&file, SESSION, Some("no-such-id"));
    assert_eq!(
        e4.iter()
            .filter(|e| e.kind == NormalizedEventKind::User)
            .count(),
        3
    );

    // The same id found in a sibling-file copy (different name/chat id) starts
    // after that id → only later entries.
    let sibling = dir.join("2026-10-22T01-00-00-000Z_other.jsonl");
    std::fs::copy(&file, &sibling).unwrap();
    let (e5, _) = import_omp_history(&sibling, SESSION, Some("a2"));
    assert_eq!(
        e5.iter()
            .filter(|e| e.kind == NormalizedEventKind::User)
            .count(),
        1
    );
    assert_eq!(
        e5.iter()
            .find(|e| e.kind == NormalizedEventKind::User)
            .unwrap()
            .text
            .as_deref(),
        Some("three")
    );

    std::fs::remove_dir_all(&dir).unwrap();
}

// ---------------------------------------------------------------------------
// 1.T4b — in-flight (incomplete) turns
// ---------------------------------------------------------------------------

#[test]
fn in_flight_turn_held_then_completed_then_session_exit() {
    let dir = tmp_dir();
    let file = dir.join("2026-10-22T00-00-00-000Z_chat.jsonl");
    // T1 complete, then a half-done T2 (assistant toolCall, no result, no terminal stop).
    let t1 = [
        r#"{"type":"session","version":3,"id":"s","timestamp":"t"}"#,
        r#"{"type":"model_change","id":"m1","parentId":null,"timestamp":"t"}"#,
        r#"{"type":"message","id":"u1","parentId":"m1","timestamp":"t","message":{"role":"user","content":[{"type":"text","text":"first"}]}}"#,
        r#"{"type":"message","id":"a1","parentId":"u1","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"A1"}],"usage":{"totalTokens":5},"stopReason":"stop"}}"#,
        r#"{"type":"message","id":"u2","parentId":"a1","timestamp":"t","message":{"role":"user","content":[{"type":"text","text":"second"}]}}"#,
        r#"{"type":"message","id":"a2","parentId":"u2","timestamp":"t","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc1","name":"read","arguments":{"path":"x"}}],"stopReason":"toolUse"}}"#,
    ];
    std::fs::write(&file, format!("{}\n", t1.join("\n"))).unwrap();

    // First import: only T1 (T2 held), watermark = last entry before T2's user = a1.
    let (e1, wm1) = import_omp_history(&file, SESSION, None);
    assert_eq!(
        e1.iter()
            .filter(|e| e.kind == NormalizedEventKind::User)
            .count(),
        1
    );
    assert_eq!(wm1, "a1");

    // Re-import with wm1: nothing new (T2 still held), watermark echoed.
    let (e2, wm2) = import_omp_history(&file, SESSION, Some(&wm1));
    assert!(e2.is_empty());
    assert_eq!(wm2, wm1);

    // Complete T2: append the toolResult + terminal assistant message.
    let complete = [
        r#"{"type":"message","id":"tr1","parentId":"a2","timestamp":"t","message":{"role":"toolResult","toolCallId":"tc1","content":[{"type":"text","text":"RESULT"}],"isError":false}}"#,
        r#"{"type":"message","id":"a3","parentId":"tr1","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"A3"}],"usage":{"totalTokens":6},"stopReason":"stop"}}"#,
    ];
    let full = format!("{}\n{}\n", t1.join("\n"), complete.join("\n"));
    std::fs::write(&file, &full).unwrap();

    let (e3, wm3) = import_omp_history(&file, SESSION, Some(&wm1));
    // T2 now imports whole (User, ToolUse, ToolResult, Text, Usage).
    assert_eq!(
        kinds(&e3),
        vec![
            NormalizedEventKind::User,
            NormalizedEventKind::ToolUse,
            NormalizedEventKind::ToolResult,
            NormalizedEventKind::Text,
            NormalizedEventKind::Usage,
        ]
    );
    assert_eq!(wm3, "a3");

    // T2 (a new one) followed by a `session_exit` with a dangling toolCall →
    // imports the ToolUse with NO result (session_exit marks the turn complete).
    let dangling = [
        r#"{"type":"message","id":"u4","parentId":"a3","timestamp":"t","message":{"role":"user","content":[{"type":"text","text":"fourth"}]}}"#,
        r#"{"type":"message","id":"a4","parentId":"u4","timestamp":"t","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc2","name":"write","arguments":{"path":"y"}}],"stopReason":"toolUse"}}"#,
        r#"{"type":"custom","customType":"session_exit","data":{"reason":"kill","kind":"signal"},"id":"ex1","parentId":"a4","timestamp":"t"}"#,
    ];
    let full2 = format!("{}\n{}\n", full.trim_end(), dangling.join("\n"));
    std::fs::write(&file, format!("{}\n", full2.trim_end())).unwrap();

    let (e4, wm4) = import_omp_history(&file, SESSION, Some(&wm3));
    let kinds4 = kinds(&e4);
    assert_eq!(
        kinds4,
        vec![NormalizedEventKind::User, NormalizedEventKind::ToolUse]
    );
    // No ToolResult for the dangling tool call.
    assert!(!kinds4.contains(&NormalizedEventKind::ToolResult));
    let use4 = &e4[1];
    assert_eq!(use4.tool_name.as_deref(), Some("write"));
    assert_eq!(use4.tool_id.as_deref(), Some("tc2"));
    // session_exit is a no-op but still seals the watermark at its own id.
    assert_eq!(wm4, "ex1");

    std::fs::remove_dir_all(&dir).unwrap();
}

// ---------------------------------------------------------------------------
// 1.T5 — tolerance
// ---------------------------------------------------------------------------

#[test]
fn tolerant_of_truncated_padded_and_unknown() {
    let dir = tmp_dir();
    // Truncated final line (no trailing newline) is ignored; unknown entry/block
    // types skipped; a padded title slot tolerated.
    let tricky = [
        r#"{"type":"title","v":1,"title":"","pad":"                      "}"#,
        r#"{"type":"some_unknown_entry","id":"z1","parentId":null,"timestamp":"t"}"#,
        r#"{"type":"message","id":"u1","parentId":null,"timestamp":"t","message":{"role":"user","content":[{"type":"text","text":"ok"}]}}"#,
        r#"{"type":"message","id":"a1","parentId":"u1","timestamp":"t","message":{"role":"assistant","content":[{"type":"weird_block"},{"type":"text","text":"reply"}],"usage":{"totalTokens":4},"stopReason":"stop"}}"#,
        // a trailing PARTIAL barrier with no newline (omp mid-write) →
        // session_exit is dropped, so a1's stopReason still completes the turn;
        // the fragment itself is ignored.
        r#"{"type":"custom","customType":"session_exit","data":{"reason":"dispos"}"#,
    ];
    let file = dir.join("f.jsonl");
    // No trailing newline on the last line → truncated final fragment ignored.
    std::fs::write(&file, tricky.join("\n")).unwrap();

    let (events, wm) = import_omp_history(&file, SESSION, None);
    assert_eq!(
        kinds(&events),
        vec![
            NormalizedEventKind::User,
            NormalizedEventKind::Text,
            NormalizedEventKind::Usage,
        ]
    );
    assert_eq!(events[0].text.as_deref(), Some("ok"));
    // The truncated session_exit fragment is dropped, so the leaf is a1.
    assert_eq!(wm, "a1");

    // Missing file → empty + echoed watermark.
    let missing = dir.join("nope.jsonl");
    let (e, w) = import_omp_history(&missing, SESSION, Some("abc"));
    assert!(e.is_empty());
    assert_eq!(w, "abc");

    // File longer than the cap (sparse set_len) → empty + echoed watermark.
    let big = dir.join("big.jsonl");
    std::fs::write(&big, "").unwrap();
    let f = std::fs::OpenOptions::new().write(true).open(&big).unwrap();
    f.set_len(vst_agents::omp_import::OMP_IMPORT_MAX_BYTES + 1)
        .unwrap();
    drop(f);
    let (e, w) = import_omp_history(&big, SESSION, Some("wm"));
    assert!(e.is_empty());
    assert_eq!(w, "wm");

    // Oversize line is skipped (but a later valid line still imports).
    let oversize = dir.join("oversize.jsonl");
    let huge = "x".repeat(vst_agents::omp_import::OMP_IMPORT_MAX_LINE_BYTES + 1);
    let garbage = format!(
        r#"{{"type":"message","id":"garbage","parentId":"u1","timestamp":"t","message":{{"role":"assistant","content":"{huge}","stopReason":"stop"}}}}"#
    );
    let content = format!(
        "{}\n{}\n{}\n",
        r#"{"type":"message","id":"u1","parentId":null,"timestamp":"t","message":{"role":"user","content":[{"type":"text","text":"ok"}]}}"#,
        garbage,
        r#"{"type":"message","id":"a1","parentId":"u1","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"reply"}],"usage":{"totalTokens":4},"stopReason":"stop"}}"#,
    );
    std::fs::write(&oversize, content).unwrap();
    let (events, _) = import_omp_history(&oversize, SESSION, None);
    assert_eq!(
        kinds(&events),
        vec![
            NormalizedEventKind::User,
            NormalizedEventKind::Text,
            NormalizedEventKind::Usage
        ]
    );

    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn legacy_no_id_file_treated_linear() {
    let dir = tmp_dir();
    // Entries without id/parentId — legacy v1 walk treats file order as linear.
    let linear = [
        r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"legacy hi"}]}}"#,
        r#"{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"legacy reply"}],"stopReason":"stop"}}"#,
    ];
    let file = dir.join("legacy.jsonl");
    std::fs::write(&file, format!("{}\n", linear.join("\n"))).unwrap();
    let (events, _wm) = import_omp_history(&file, SESSION, None);
    // The legacy assistant carries no usage field, so no Usage event.
    assert_eq!(
        kinds(&events),
        vec![NormalizedEventKind::User, NormalizedEventKind::Text]
    );
    assert_eq!(events[1].text.as_deref(), Some("legacy reply"));
    std::fs::remove_dir_all(&dir).unwrap();
}

// ---------------------------------------------------------------------------
// 1.T6 — current_cursor
// ---------------------------------------------------------------------------

#[test]
fn current_cursor_is_the_leaf_id() {
    // Settled file: leaf = session_exit's id.
    assert_eq!(
        omp_current_cursor(std::path::Path::new(TOOL_TURN)),
        Some("2cd1e10f".to_string())
    );
    assert_eq!(
        omp_current_cursor(std::path::Path::new(TWO_PLAIN)),
        Some("1a418cbd".to_string())
    );
    // Missing file → None (seal is a no-op).
    assert_eq!(
        omp_current_cursor(std::path::Path::new("/nope/none.jsonl")),
        None
    );
}

#[test]
fn current_cursor_on_in_flight_file_matches_settled_import() {
    let dir = tmp_dir();
    // In-flight file: last assistant has a dangling toolCall (no result); the
    // settled leaf is still the last eligible path entry.
    let lines = [
        r#"{"type":"model_change","id":"m1","parentId":null,"timestamp":"t"}"#,
        r#"{"type":"message","id":"u1","parentId":"m1","timestamp":"t","message":{"role":"user","content":[{"type":"text","text":"go"}]}}"#,
        r#"{"type":"message","id":"a1","parentId":"u1","timestamp":"t","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc1","name":"read","arguments":{"path":"x"}}],"stopReason":"toolUse"}}"#,
    ];
    let file = dir.join("2026-10-22T00-00-00-000Z_chat.jsonl");
    std::fs::write(&file, format!("{}\n", lines.join("\n"))).unwrap();

    // Import holds the incomplete turn; current_cursor treats it as settled and
    // returns the leaf id (what the watermark would be if settled).
    let (events, wm) = import_omp_history(&file, SESSION, None);
    assert!(events.is_empty());
    assert_eq!(wm, "m1"); // held turn u1, last entry before it = m1
    assert_eq!(omp_current_cursor(&file), Some("a1".to_string()));
    std::fs::remove_dir_all(&dir).unwrap();
}

fn user_line(id: &str, parent: Option<&str>, text: &str) -> String {
    let parent = parent.map_or("null".to_string(), |p| format!("\"{p}\""));
    format!(
        r#"{{"type":"message","id":"{id}","parentId":{parent},"timestamp":"t","message":{{"role":"user","content":[{{"type":"text","text":"{text}"}}]}}}}"#
    )
}

fn assistant_line(id: &str, parent: &str, text: &str, extra: &str) -> String {
    format!(
        r#"{{"type":"message","id":"{id}","parentId":"{parent}","timestamp":"t",{extra}"message":{{"role":"assistant","content":[{{"type":"text","text":"{text}"}}],"stopReason":"stop"}}}}"#
    )
}

/// A long agentic session must import from its FIRST turn: the active-path walk
/// has no depth cap (a cap silently dropped the start of the conversation).
#[test]
fn long_session_imports_from_the_first_turn() {
    let dir = tmp_dir();
    let mut lines = Vec::new();
    let mut prev: Option<String> = None;
    for n in 0..3000 {
        let (u, a) = (format!("u{n}"), format!("a{n}"));
        lines.push(user_line(&u, prev.as_deref(), &format!("q{n}")));
        lines.push(assistant_line(&a, &u, &format!("r{n}"), ""));
        prev = Some(a);
    }
    let file = dir.join("2026-10-22T00-00-00-000Z_long.jsonl");
    std::fs::write(&file, format!("{}\n", lines.join("\n"))).unwrap();
    let (events, _) = import_omp_history(&file, SESSION, None);
    let users: Vec<&str> = events
        .iter()
        .filter(|e| e.kind == NormalizedEventKind::User)
        .filter_map(|e| e.text.as_deref())
        .collect();
    assert_eq!(users.len(), 3000, "6000 path entries must all be walked");
    assert_eq!(users[0], "q0");
    std::fs::remove_dir_all(&dir).unwrap();
}

/// After two `/clear`s only the turns after the LAST reset boundary import.
#[test]
fn last_reset_boundary_wins() {
    let dir = tmp_dir();
    let lines = [
        user_line("u1", None, "before-first-clear"),
        assistant_line("a1", "u1", "r1", ""),
        r#"{"type":"reset_boundary","id":"rb1","parentId":"a1","timestamp":"t"}"#.to_string(),
        user_line("u2", Some("rb1"), "between-clears"),
        assistant_line("a2", "u2", "r2", ""),
        r#"{"type":"reset_boundary","id":"rb2","parentId":"a2","timestamp":"t"}"#.to_string(),
        user_line("u3", Some("rb2"), "after-last-clear"),
        assistant_line("a3", "u3", "r3", ""),
    ];
    let file = dir.join("2026-10-22T00-00-00-000Z_rb.jsonl");
    std::fs::write(&file, format!("{}\n", lines.join("\n"))).unwrap();
    let (events, _) = import_omp_history(&file, SESSION, None);
    let users: Vec<&str> = events
        .iter()
        .filter(|e| e.kind == NormalizedEventKind::User)
        .filter_map(|e| e.text.as_deref())
        .collect();
    assert_eq!(users, vec!["after-last-clear"]);
    std::fs::remove_dir_all(&dir).unwrap();
}

/// omp stamps off-branch writes with the ACTIVE leaf; the importer follows that
/// (omp's own `resolveSessionLeafId`) instead of treating the stray entry as the leaf.
#[test]
fn active_leaf_id_beats_the_last_physical_entry() {
    let dir = tmp_dir();
    let lines = [
        user_line("u1", None, "hello"),
        assistant_line("a1", "u1", "active-reply", ""),
        // Written last, but on an abandoned branch; points back at the real leaf.
        assistant_line("x1", "u1", "abandoned-branch", r#""activeLeafId":"a1","#),
    ];
    let file = dir.join("2026-10-22T00-00-00-000Z_leaf.jsonl");
    std::fs::write(&file, format!("{}\n", lines.join("\n"))).unwrap();
    let (events, _) = import_omp_history(&file, SESSION, None);
    let replies = texts(&events);
    assert!(replies.contains(&"active-reply"), "{replies:?}");
    assert!(!replies.contains(&"abandoned-branch"), "{replies:?}");
    std::fs::remove_dir_all(&dir).unwrap();
}

// ---------------------------------------------------------------------------
// Importer struct + singleton
// ---------------------------------------------------------------------------

#[test]
fn omp_importer_struct_and_singleton() {
    let importer: &dyn NativeHistoryImporter = omp_history_importer();
    assert_eq!(importer.cli(), "omp");
    // The concrete struct matches.
    let concrete = OmpHistoryImporter;
    assert_eq!(concrete.cli(), "omp");
    // current_cursor default (trait) is None, omp overrides it.
    assert_eq!(
        concrete.current_cursor(&NativeImportRequest {
            session_id: SESSION.into(),
            agent_chat_id: "chat".into(),
            cwd: "/nowhere".into(),
            watermark: None,
        }),
        None // no conversation_file for /nowhere
    );
}

#[test]
fn omp_importer_import_resolves_conversation_file() {
    let dir = tmp_dir();
    // Private store layout: <cwd>/.vibe-station/omp-sessions/<session>/<ts>_<chat>.jsonl
    let session = "sess-omp-1";
    let store = dir.join(format!("cwd/.vibe-station/omp-sessions/{session}"));
    std::fs::create_dir_all(&store).unwrap();
    let file = store.join("2026-10-22T00-00-00-000Z_chat.jsonl");
    let lines = [
        r#"{"type":"model_change","id":"m1","parentId":null,"timestamp":"t"}"#,
        r#"{"type":"message","id":"u1","parentId":"m1","timestamp":"t","message":{"role":"user","content":[{"type":"text","text":"via file"}]}}"#,
        r#"{"type":"message","id":"a1","parentId":"u1","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"totalTokens":3},"stopReason":"stop"}}"#,
    ];
    std::fs::write(&file, format!("{}\n", lines.join("\n"))).unwrap();

    let importer = omp_history_importer();
    let r: NativeImportResult = importer.import(&NativeImportRequest {
        session_id: SESSION.into(),
        agent_chat_id: "chat".into(),
        cwd: dir.join("cwd").display().to_string(),
        watermark: None,
    });
    assert_eq!(
        r.events
            .iter()
            .find(|e| e.kind == NormalizedEventKind::User)
            .unwrap()
            .text
            .as_deref(),
        Some("via file")
    );
    assert_eq!(r.next_watermark, "a1");
    std::fs::remove_dir_all(&dir).unwrap();
}

// ---------------------------------------------------------------------------
// 3.4 — Decision 9: json→tty seal, then tty→json import emits only the terminal turn
// ---------------------------------------------------------------------------

/// A live-shaped user/tool `NormalizedEvent` for seeding the transcript store —
/// UUID turn ids, `raw_message`-style user text, a silent notice row, tool rows.
fn live_ev(
    kind: NormalizedEventKind,
    session_id: &str,
    text: Option<&str>,
    turn_id: &str,
    tool_id: Option<&str>,
) -> NormalizedEvent {
    let mut e: NormalizedEvent = serde_json::from_value(serde_json::json!({
        "id": format!("live-{}-{}", std::process::id(), turn_id),
        "sessionId": session_id,
        "ts": "2026-01-01T00:00:00Z",
        "provider": "omp",
        "kind": serde_json::to_value(&kind).unwrap(),
    }))
    .unwrap();
    e.turn_id = Some(turn_id.to_string());
    e.text = text.map(str::to_string);
    e.tool_id = tool_id.map(str::to_string);
    if kind == NormalizedEventKind::User {
        e.role = Some(Role::User);
    }
    e
}

/// 3.4 — Session runs Rich Chat (its turns live in the transcript store with
/// live-shaped rows: a UUID-turn-id user, a silent notice user, a tool row),
/// json→tty seals the watermark at the end of those turns, then a terminal turn
/// is appended; tty→json import emits ONLY the post-seal terminal turn — no
/// duplicate user rows (incl. the silent one).
#[tokio::test]
async fn seal_then_import_emits_only_post_seal_turn() {
    const SID: &str = "sess-seal-1";
    const CHAT: &str = "chat-991";

    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let _guard = vst_agents::home::with_home(home.clone());
    let cwd = tmp.path().join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();

    // (1) omp conversation file — FIRST only the Rich-Chat turns (the state at
    // json→tty seal time): user "write a file", a tool call + result, a silent
    // notice (attribution != user), user "make it pretty", assistant "done".
    let session_dir = cwd.join(".vibe-station/omp-sessions").join(SID);
    std::fs::create_dir_all(&session_dir).unwrap();
    let file = session_dir.join(format!("2026-10-22T00-00-00-000Z_{CHAT}.jsonl"));
    let rich_chat = [
        r#"{"type":"model_change","id":"m1","parentId":null,"timestamp":"t"}"#,
        r#"{"type":"message","id":"u1","parentId":"m1","timestamp":"t","message":{"role":"user","content":[{"type":"text","text":"write a file (sent)"}]}}"#,
        r#"{"type":"message","id":"a1","parentId":"u1","timestamp":"t","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc1","name":"write","arguments":{"path":"x"}}],"usage":{"totalTokens":5},"stopReason":"toolUse"}}"#,
        r#"{"type":"message","id":"tr1","parentId":"a1","timestamp":"t","message":{"role":"toolResult","toolCallId":"tc1","content":[{"type":"text","text":"ok"}],"isError":false}}"#,
        r#"{"type":"message","id":"u2","parentId":"tr1","timestamp":"t","message":{"role":"user","content":[{"type":"text","text":"<notice> scheduled task complete"}],"attribution":"agent"}}"#,
        r#"{"type":"message","id":"u3","parentId":"u2","timestamp":"t","message":{"role":"user","content":[{"type":"text","text":"make it pretty (sent)"}]}}"#,
        r#"{"type":"message","id":"a3","parentId":"u3","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"usage":{"totalTokens":6},"stopReason":"stop"}}"#,
    ];
    std::fs::write(&file, format!("{}\n", rich_chat.join("\n"))).unwrap();

    // (2) Pre-seed the LIVE store with live-shaped rows matching those Rich-Chat
    // turns: a UUID-turn-id user, a silent notice user row, and a tool row.
    let data_dir = home.join(".vibe-station/projects/p1/sessions").join(SID);
    let mut store = open_transcript_store(&data_dir, SID);
    store.append(&mut live_ev(
        NormalizedEventKind::User,
        SID,
        Some("write a file"),
        "11111111-2222-3333-4444-555555555555",
        None,
    ));
    store.append(&mut live_ev(
        NormalizedEventKind::ToolUse,
        SID,
        None,
        "11111111-2222-3333-4444-555555555555",
        Some("tc1"),
    ));
    let mut silent = live_ev(
        NormalizedEventKind::User,
        SID,
        Some("<notice> scheduled task complete"),
        "silent-notice-0001",
        None,
    );
    silent.silent = Some(true);
    store.append(&mut silent);
    store.append(&mut live_ev(
        NormalizedEventKind::User,
        SID,
        Some("make it pretty"),
        "66666666-7777-8888-9999-aaaaaaaaaaaa",
        None,
    ));
    let seeded_users = store
        .read_all()
        .iter()
        .filter(|e| e.kind == NormalizedEventKind::User)
        .count();
    store.close();

    // (3) Build a live JsonAgentSession (omp plugin, cwd = project checkout) and
    // seal at the current (Rich-Chat-only) end of the file — the json→tty step.
    let mut project = common::make_project("p1");
    project.absolute_path = cwd.display().to_string();
    let mut session_rec = common::make_session(SID);
    session_rec.agent_chat_id = Some(CHAT.to_string());
    let store_handle = vst_store::StoreHandle::open(tmp.path().join("test.db")).unwrap();
    let (tx, _rx) = tokio::sync::broadcast::channel(64);
    let session = JsonAgentSession::new(JsonAgentSessionOptions {
        project,
        worktree: None,
        session: session_rec,
        plugin: Arc::new(vst_agents::omp::create_omp_plugin()),
        daemon_port: 0,
        cli: vst_types::NormalizedEventProvider::Omp,
        model: None,
        mode_id: None,
        mode_name: None,
        store_handle,
        broadcaster: vst_types::Broadcaster(tx),
    });

    // The seal persists current_cursor = a3 (the settled Rich-Chat leaf), so the
    // terminal turn appended after it is the ONLY new content on tty→json.
    session.seal_native_watermark().await;

    // (4) The terminal (tty) phase appends a turn after the seal point.
    let terminal = [
        r#"{"type":"message","id":"u4","parentId":"a3","timestamp":"t","message":{"role":"user","content":[{"type":"text","text":"list the files"}]}}"#,
        r#"{"type":"message","id":"a4","parentId":"u4","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"three files"}],"usage":{"totalTokens":7},"stopReason":"stop"}}"#,
    ];
    std::fs::write(
        &file,
        format!("{}\n{}\n", rich_chat.join("\n"), terminal.join("\n")),
    )
    .unwrap();

    // (5) tty→json import: only the terminal turn (User + Text + Usage = 3).
    let outcome = session.import_native_history().await.expect("import");
    assert_eq!(outcome.turns_imported, 1, "only the terminal turn imports");
    assert_eq!(
        outcome.imported, 3,
        "User + Text + Usage for the terminal turn"
    );

    // No duplicate user rows — the pre-seed count grows by exactly 1 (the
    // terminal turn), and none of the Rich-Chat / silent rows are re-added.
    session.dispose();
    let store = open_transcript_store(&data_dir, SID);
    let all = store.read_all();
    let user_texts: Vec<Option<&str>> = all
        .iter()
        .filter(|e| e.kind == NormalizedEventKind::User)
        .map(|e| e.text.as_deref())
        .collect();
    assert_eq!(user_texts.len(), seeded_users + 1);
    assert_eq!(
        user_texts
            .iter()
            .filter(|t| **t == Some("list the files"))
            .count(),
        1
    );
    assert_eq!(
        user_texts
            .iter()
            .filter(|t| **t == Some("write a file"))
            .count(),
        1
    );
    assert_eq!(
        user_texts
            .iter()
            .filter(|t| **t == Some("make it pretty"))
            .count(),
        1
    );
    assert_eq!(
        user_texts
            .iter()
            .filter(|t| **t == Some("<notice> scheduled task complete"))
            .count(),
        1
    );
    // The watermark advanced to the terminal leaf.
    assert_eq!(
        store.get_native_watermark().map(|w| w.cursor),
        Some("a4".into())
    );
    store.close();
}
