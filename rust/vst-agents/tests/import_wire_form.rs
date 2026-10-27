//! Imported user rows must be stored in skill-grammar wire form (like live
//! rows), so a literal `\`, `{` or `{/x y}` in native history displays as the
//! original plain text instead of collapsing or rendering as a token.

use vst_agents::skill_tokens::{parse_skill_segments, SkillSegment};
use vst_types::{NormalizedEvent, NormalizedEventKind};

const RAW: &str = r"C:\temp {a} {/x y}";

/// The stored text must parse back to exactly one plain-text segment equal to
/// the original (no token, no collapsed escapes).
fn assert_round_trips(events: &[NormalizedEvent]) {
    let user: Vec<_> = events
        .iter()
        .filter(|e| e.kind == NormalizedEventKind::User)
        .collect();
    assert_eq!(user.len(), 1, "one user row: {events:?}");
    let stored = user[0].text.as_deref().unwrap();
    assert_ne!(stored, RAW, "must be escaped, not raw");
    assert_eq!(
        parse_skill_segments(stored),
        vec![SkillSegment::Text(RAW.to_string())]
    );
    // Assistant rows are untouched.
    for e in events
        .iter()
        .filter(|e| e.kind == NormalizedEventKind::Text)
    {
        assert_eq!(e.text.as_deref(), Some(RAW));
    }
}

#[test]
fn claude_user_rows_are_wire_form() {
    for content in [
        serde_json::json!(RAW),
        serde_json::json!([{ "type": "text", "text": RAW }]),
    ] {
        let lines = vec![
            serde_json::json!({
                "type": "user", "uuid": "u1", "timestamp": "2026-01-01T00:00:00.000Z",
                "message": { "role": "user", "content": content }
            })
            .to_string(),
            serde_json::json!({
                "type": "assistant", "uuid": "a1", "timestamp": "2026-01-01T00:00:01.000Z",
                "message": { "role": "assistant", "content": [{ "type": "text", "text": RAW }] }
            })
            .to_string(),
        ];
        let (events, _) = vst_agents::claude_import::parse_claude_native_history(&lines, "s", 0);
        assert_round_trips(&events);
    }
}

#[test]
fn codex_user_rows_are_wire_form() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rollout.jsonl");
    let lines = [
        serde_json::json!({"timestamp":"2026-10-02T21:25:15.971Z","ordinal":0,"type":"session_meta","payload":{"id":"x","cwd":"/tmp"}}),
        serde_json::json!({"timestamp":"2026-10-02T21:25:15.971Z","ordinal":1,"type":"event_msg","payload":{"type":"task_started","turn_id":"t1","root_turn_id":"t1"}}),
        serde_json::json!({"timestamp":"2026-10-02T21:25:17.443Z","ordinal":9,"type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"UserMessage","id":"i1","content":[{"type":"text","text":RAW,"text_elements":[]}]}}}),
        serde_json::json!({"timestamp":"2026-10-02T21:25:18.443Z","ordinal":10,"type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"AgentMessage","id":"i2","content":[{"type":"Text","text":RAW}]}}}),
        serde_json::json!({"timestamp":"2026-10-02T21:25:19.443Z","ordinal":11,"type":"event_msg","payload":{"type":"task_complete","turn_id":"t1"}}),
    ];
    let body: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    std::fs::write(&path, body.join("\n") + "\n").unwrap();
    let (events, _) = vst_agents::codex_import::import_codex_history(&path, "s", None);
    assert_round_trips(&events);
}

#[test]
fn opencode_user_rows_are_wire_form() {
    let dir = tempfile::tempdir().unwrap();
    let conn = rusqlite::Connection::open(dir.path().join("oc.db")).unwrap();
    conn.execute_batch(
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
         CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);",
    )
    .unwrap();
    let add = |mid: &str, t: i64, md: serde_json::Value, pid: &str, pd: serde_json::Value| {
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, data) VALUES (?1,'c',?2,?3)",
            rusqlite::params![mid, t, md.to_string()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?1,?2,'c',?3,?4)",
            rusqlite::params![pid, mid, t, pd.to_string()],
        )
        .unwrap();
    };
    add(
        "m1",
        1000,
        serde_json::json!({"role":"user","time":{"created":1000}}),
        "p1",
        serde_json::json!({"type":"text","text":RAW}),
    );
    add(
        "m2",
        2000,
        serde_json::json!({"role":"assistant","modelID":"m","time":{"created":2000}}),
        "p2",
        serde_json::json!({"type":"text","text":RAW}),
    );
    let (events, _) = vst_agents::opencode_import::import_opencode_history(&conn, "s", "c", None);
    assert_round_trips(&events);
}

#[test]
fn omp_user_rows_are_wire_form() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("omp.jsonl");
    let user = |id: &str, parent: serde_json::Value, text: &str| {
        serde_json::json!({"type":"message","id":id,"parentId":parent,"timestamp":"2026-10-22T08:55:48.319Z",
            "message":{"role":"user","content":[{"type":"text","text":text}],"attribution":"user"}})
    };
    let lines = [
        serde_json::json!({"type":"session","version":3,"id":"s","timestamp":"2026-10-22T08:55:48.187Z","cwd":"/w"}),
        user("u1", serde_json::Value::Null, RAW),
        serde_json::json!({"type":"message","id":"a1","parentId":"u1","timestamp":"2026-10-22T08:55:49.000Z",
            "message":{"role":"assistant","content":[{"type":"text","text":RAW}],"stopReason":"stop"}}),
        user("u2", serde_json::json!("a1"), "next"),
    ];
    let body: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    std::fs::write(&path, body.join("\n") + "\n").unwrap();
    let (events, _) = vst_agents::omp_import::import_omp_history(&path, "s", None);
    let first: Vec<_> = events
        .into_iter()
        .filter(|e| e.text.as_deref() != Some("next"))
        .collect();
    assert_round_trips(&first);
}
