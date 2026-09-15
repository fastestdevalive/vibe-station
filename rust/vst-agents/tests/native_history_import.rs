//! Behavior contract for the at-rest native-history importers — ports
//! `daemon/src/__tests__/nativeHistoryImport.test.ts` P2.T1 (claude adapter),
//! P2.T2 (opencode adapter), and the P3 registry gate.
//!
//! P2.T3/T4/T5 and 1.T3/1.T5 exercise the transcript store's `importTransaction`
//! (already ported in vst-store) and are out of scope for this crate.

use std::path::Path;

use vst_agents::claude_import::{claude_native_store_path, create_claude_history_importer};
use vst_agents::native_history_importer::{
    get_native_history_importer, has_native_history_importer, NativeHistoryImporter,
    NativeImportRequest,
};
use vst_agents::opencode_import::{create_opencode_history_importer, opencode_native_store_path};

const SESSION_ID: &str = "sess-import-1";

fn req(agent_chat_id: &str, cwd: &str) -> NativeImportRequest {
    NativeImportRequest {
        session_id: SESSION_ID.into(),
        agent_chat_id: agent_chat_id.into(),
        cwd: cwd.into(),
        watermark: None,
    }
}

fn write_claude_store(dir: &Path, slug: &str, chat_id: &str, lines: &[serde_json::Value]) {
    let d = dir.join(slug);
    std::fs::create_dir_all(&d).unwrap();
    let content = lines
        .iter()
        .map(|l| serde_json::to_string(l).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(d.join(format!("{chat_id}.jsonl")), format!("{content}\n")).unwrap();
}

// ---------------------------------------------------------------------------
// P2.T1 — claude at-rest adapter golden
// ---------------------------------------------------------------------------
const CWD: &str = "/home/u/.wt/proj";
const CHAT_ID: &str = "cccccccc-1111-2222-3333-444444444444";

#[test]
fn claude_slug_matches_ts() {
    // slug = cwd with '/' then '.' replaced by '-'.
    assert_eq!(
        claude_native_store_path("/x/projects", CWD, CHAT_ID),
        "/x/projects/-home-u--wt-proj/cccccccc-1111-2222-3333-444444444444.jsonl"
    );
}

#[test]
fn claude_adapter_golden() {
    let tmp = tempfile::tempdir().unwrap();
    let projects = tmp.path().join("projects");
    std::fs::create_dir_all(&projects).unwrap();
    let big_base64 = "A".repeat(4096);
    let lines = vec![
        serde_json::json!({ "type": "system", "subtype": "init", "session_id": CHAT_ID, "model": "claude-sonnet-4-6" }),
        serde_json::json!({ "type": "mode", "mode": "acceptEdits" }),
        serde_json::json!({ "type": "ai-title", "title": "chat" }),
        serde_json::json!({ "type": "user", "uuid": "u1", "timestamp": "2026-07-18T00:00:00Z", "message": { "role": "user", "content": "Hello there" } }),
        serde_json::json!({ "type": "assistant", "timestamp": "2026-07-18T00:00:01Z", "message": { "model": "claude-sonnet-4-6", "content": [ { "type": "thinking", "thinking": "pondering" }, { "type": "text", "text": "Hi!" } ], "usage": { "input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 2, "cache_creation_input_tokens": 3 } } }),
        serde_json::json!({ "type": "assistant", "timestamp": "2026-07-18T00:00:02Z", "message": { "model": "claude-sonnet-4-6", "content": [ { "type": "tool_use", "id": "t1", "name": "Read", "input": { "path": "x" } } ] } }),
        serde_json::json!({ "type": "user", "timestamp": "2026-07-18T00:00:03Z", "message": { "role": "user", "content": [ { "type": "tool_result", "tool_use_id": "t1", "content": [ { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": big_base64 } } ] } ] } }),
        serde_json::json!({ "type": "user", "uuid": "meta1", "isMeta": true, "message": { "role": "user", "content": "caveat noise" } }),
        serde_json::json!({ "type": "user", "uuid": "u2", "timestamp": "2026-07-18T00:00:04Z", "message": { "role": "user", "content": [ { "type": "text", "text": "Second question" } ] } }),
        serde_json::json!({ "type": "assistant", "timestamp": "2026-07-18T00:00:05Z", "message": { "model": "claude-sonnet-4-6", "content": [ { "type": "text", "text": "Answer 2" } ], "usage": { "input_tokens": 4, "output_tokens": 1, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0 } } }),
    ];
    write_claude_store(&projects, "-home-u--wt-proj", CHAT_ID, &lines);

    let importer = create_claude_history_importer(Some(projects.display().to_string()));
    let r = importer.import(&req(CHAT_ID, CWD));

    let users: Vec<_> = r
        .events
        .iter()
        .filter(|e| e.kind == vst_types::NormalizedEventKind::User)
        .collect();
    assert_eq!(
        users
            .iter()
            .map(|e| e.text.as_deref().unwrap())
            .collect::<Vec<_>>(),
        ["Hello there", "Second question"]
    );
    assert_eq!(
        users
            .iter()
            .map(|e| e.turn_id.as_deref().unwrap())
            .collect::<Vec<_>>(),
        ["u1", "u2"]
    );

    let u1_kinds: Vec<_> = r
        .events
        .iter()
        .filter(|e| e.turn_id.as_deref() == Some("u1"))
        .map(|e| e.kind)
        .collect();
    assert_eq!(
        u1_kinds,
        vec![
            vst_types::NormalizedEventKind::User,
            vst_types::NormalizedEventKind::Thinking,
            vst_types::NormalizedEventKind::Text,
            vst_types::NormalizedEventKind::Usage,
            vst_types::NormalizedEventKind::ToolUse,
            vst_types::NormalizedEventKind::ToolResult,
        ]
    );

    let usage = r
        .events
        .iter()
        .find(|e| e.kind == vst_types::NormalizedEventKind::Usage)
        .unwrap();
    let u = usage.usage.as_ref().unwrap();
    assert_eq!(u.input_tokens, 10);
    assert_eq!(u.output_tokens, 5);
    assert_eq!(u.cache_read_tokens, 2);
    assert_eq!(u.cache_create_tokens, 3);
    assert_eq!(u.total_tokens, 20);
    assert_eq!(u.model, "claude-sonnet-4-6");

    let tool_result = r
        .events
        .iter()
        .find(|e| e.kind == vst_types::NormalizedEventKind::ToolResult)
        .unwrap();
    let content = tool_result
        .tool_result
        .as_ref()
        .unwrap()
        .content
        .clone()
        .unwrap();
    assert!(!content.contains("AAAA"));
    assert!(content.contains("stripped"));

    assert!(r.next_watermark.parse::<usize>().unwrap() > 0);
    assert!(r
        .events
        .iter()
        .all(|e| e.provider == vst_types::NormalizedEventProvider::Claude));
}

#[test]
fn claude_adapter_resumes_past_watermark() {
    let tmp = tempfile::tempdir().unwrap();
    let projects = tmp.path().join("projects");
    std::fs::create_dir_all(&projects).unwrap();
    let lines = vec![
        serde_json::json!({ "type": "user", "uuid": "u1", "message": { "role": "user", "content": "hello" } }),
    ];
    write_claude_store(&projects, "-home-u--wt-proj", CHAT_ID, &lines);

    let importer = create_claude_history_importer(Some(projects.display().to_string()));
    let first = importer.import(&req(CHAT_ID, CWD));
    let second = importer.import(&NativeImportRequest {
        watermark: Some(first.next_watermark.clone()),
        ..req(CHAT_ID, CWD)
    });
    assert!(second.events.is_empty());
    assert_eq!(second.next_watermark, first.next_watermark);
}

#[test]
fn claude_adapter_missing_store_empty() {
    let tmp = tempfile::tempdir().unwrap();
    let importer =
        create_claude_history_importer(Some(tmp.path().join("projects").display().to_string()));
    let r = importer.import(&req("nope", CWD));
    assert!(r.events.is_empty());
}

#[test]
fn claude_adapter_prompt_filtering_and_multi_block() {
    let tmp = tempfile::tempdir().unwrap();
    let projects = tmp.path().join("projects");
    std::fs::create_dir_all(&projects).unwrap();
    let lines = vec![
        serde_json::json!({ "type": "user", "uuid": "u1", "promptSource": "typed", "origin": { "kind": "human" }, "message": { "role": "user", "content": "typed prompt" } }),
        serde_json::json!({ "type": "user", "uuid": "u2", "promptSource": "sdk", "origin": { "kind": "human" }, "message": { "role": "user", "content": "sdk prompt" } }),
        serde_json::json!({ "type": "user", "uuid": "u3", "promptSource": "queued", "origin": { "kind": "human" }, "message": { "role": "user", "content": "queued prompt" } }),
        serde_json::json!({ "type": "user", "uuid": "x1", "promptSource": "system", "origin": { "kind": "task-notification" }, "message": { "role": "user", "content": "<task-notification>…" } }),
        serde_json::json!({ "type": "user", "uuid": "x2", "promptSource": "sdk", "origin": { "kind": "task-notification" }, "message": { "role": "user", "content": "<task-notification>…" } }),
        serde_json::json!({ "type": "user", "uuid": "u4", "promptSource": "sdk", "origin": { "kind": "human" }, "message": { "role": "user", "content": [ { "type": "text", "text": "# Injected system prompt" }, { "type": "text", "text": "the real message" } ] } }),
    ];
    write_claude_store(&projects, "-home-u--wt-proj", CHAT_ID, &lines);

    let importer = create_claude_history_importer(Some(projects.display().to_string()));
    let r = importer.import(&req(CHAT_ID, CWD));
    let texts: Vec<_> = r
        .events
        .iter()
        .filter(|e| e.kind == vst_types::NormalizedEventKind::User)
        .map(|e| e.text.clone().unwrap())
        .collect();
    assert_eq!(
        texts,
        [
            "typed prompt",
            "sdk prompt",
            "queued prompt",
            "the real message"
        ]
    );
}

#[test]
fn claude_adapter_reconstructs_edit_diffs() {
    let tmp = tempfile::tempdir().unwrap();
    let projects = tmp.path().join("projects");
    std::fs::create_dir_all(&projects).unwrap();
    let lines = vec![
        serde_json::json!({ "type": "user", "uuid": "u1", "origin": { "kind": "human" }, "message": { "role": "user", "content": "edit things" } }),
        serde_json::json!({ "type": "assistant", "message": { "content": [
            { "type": "tool_use", "id": "e1", "name": "Edit", "input": { "file_path": "/p/a.ts", "old_string": "a", "new_string": "b" } },
            { "type": "tool_use", "id": "e2", "name": "MultiEdit", "input": { "file_path": "/p/b.ts", "edits": [ { "old_string": "1", "new_string": "2" }, { "old_string": "3", "new_string": "4" } ] } },
            { "type": "tool_use", "id": "e3", "name": "Read", "input": { "file_path": "/p/c.ts" } },
        ] } }),
        serde_json::json!({ "type": "user", "message": { "role": "user", "content": [
            { "type": "tool_result", "tool_use_id": "e1", "content": "ok" },
            { "type": "tool_result", "tool_use_id": "e2", "content": "ok" },
            { "type": "tool_result", "tool_use_id": "e3", "content": "ok" },
        ] } }),
    ];
    write_claude_store(&projects, "-home-u--wt-proj", CHAT_ID, &lines);

    let importer = create_claude_history_importer(Some(projects.display().to_string()));
    let r = importer.import(&req(CHAT_ID, CWD));
    let by_id: std::collections::HashMap<_, _> = r
        .events
        .iter()
        .filter(|e| e.kind == vst_types::NormalizedEventKind::ToolResult)
        .map(|e| (e.tool_id.clone().unwrap(), e))
        .collect();
    let e1 = by_id["e1"].tool_diffs.clone().unwrap();
    assert_eq!(
        e1,
        vec![vst_types::ToolDiff {
            path: "/p/a.ts".into(),
            old_text: Some("a".into()),
            new_text: "b".into()
        }]
    );
    let e2 = by_id["e2"].tool_diffs.clone().unwrap();
    assert_eq!(
        e2,
        vec![
            vst_types::ToolDiff {
                path: "/p/b.ts".into(),
                old_text: Some("1".into()),
                new_text: "2".into()
            },
            vst_types::ToolDiff {
                path: "/p/b.ts".into(),
                old_text: Some("3".into()),
                new_text: "4".into()
            },
        ]
    );
    assert!(by_id["e3"].tool_diffs.is_none());
}

// ---------------------------------------------------------------------------
// P2.T2 — opencode at-rest adapter golden
// ---------------------------------------------------------------------------
const OC_CHAT_ID: &str = "ses_test000000000000000000000";

fn seed_opencode_db(db_path: &Path) {
    let conn = rusqlite::Connection::open(db_path).unwrap();
    conn.execute_batch(
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
         CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);",
    ).unwrap();
    conn.execute(
        "INSERT INTO message (id, session_id, time_created, data) VALUES (?1,?2,?3,?4)",
        rusqlite::params![
            "m1",
            OC_CHAT_ID,
            1000i64,
            serde_json::json!({ "role": "user", "time": { "created": 1000 } }).to_string()
        ],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?1,?2,?3,?4,?5)",
        rusqlite::params![
            "p1",
            "m1",
            OC_CHAT_ID,
            1000i64,
            serde_json::json!({ "type": "text", "text": "Say the word PINEAPPLE" }).to_string()
        ],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO message (id, session_id, time_created, data) VALUES (?1,?2,?3,?4)",
        rusqlite::params![
            "m2", OC_CHAT_ID, 2000i64,
            serde_json::json!({ "role": "assistant", "modelID": "big-pickle", "time": { "created": 2000 }, "tokens": { "input": 9, "output": 3, "cache": { "read": 1, "write": 2 } } }).to_string()
        ],
    ).unwrap();
    for (id, ts, data) in [
        (
            "p2",
            2001i64,
            serde_json::json!({ "type": "reasoning", "text": "thinking..." }),
        ),
        (
            "p3",
            2002i64,
            serde_json::json!({ "type": "text", "text": "PINEAPPLE" }),
        ),
        (
            "p4",
            2003i64,
            serde_json::json!({ "type": "tool", "tool": "glob", "callID": "c1", "state": { "status": "completed", "input": { "pattern": "*" }, "output": "match" } }),
        ),
    ] {
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?1,?2,?3,?4,?5)",
            rusqlite::params![id, "m2", OC_CHAT_ID, ts, data.to_string()],
        ).unwrap();
    }
    // A different session — must be filtered out.
    conn.execute(
        "INSERT INTO message (id, session_id, time_created, data) VALUES (?1,?2,?3,?4)",
        rusqlite::params![
            "m9",
            "ses_other",
            1500i64,
            serde_json::json!({ "role": "user", "time": { "created": 1500 } }).to_string()
        ],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?1,?2,?3,?4,?5)",
        rusqlite::params![
            "p9",
            "m9",
            "ses_other",
            1500i64,
            serde_json::json!({ "type": "text", "text": "other session" }).to_string()
        ],
    )
    .unwrap();
}

#[test]
fn opencode_adapter_golden() {
    let tmp = tempfile::tempdir().unwrap();
    let db_path = tmp.path().join("opencode.db");
    seed_opencode_db(&db_path);

    let importer = create_opencode_history_importer(Some(db_path.display().to_string()));
    let r = importer.import(&req(OC_CHAT_ID, "/whatever"));

    let kinds: Vec<_> = r.events.iter().map(|e| e.kind).collect();
    assert_eq!(
        kinds,
        vec![
            vst_types::NormalizedEventKind::User,
            vst_types::NormalizedEventKind::Thinking,
            vst_types::NormalizedEventKind::Text,
            vst_types::NormalizedEventKind::ToolUse,
            vst_types::NormalizedEventKind::ToolResult,
            vst_types::NormalizedEventKind::Usage,
        ]
    );

    let user = r
        .events
        .iter()
        .find(|e| e.kind == vst_types::NormalizedEventKind::User)
        .unwrap();
    assert_eq!(user.text.as_deref(), Some("Say the word PINEAPPLE"));
    assert_eq!(user.turn_id.as_deref(), Some("m1"));
    assert!(r
        .events
        .iter()
        .filter(|e| e.kind != vst_types::NormalizedEventKind::User)
        .all(|e| e.turn_id.as_deref() == Some("m1")));

    let usage = r
        .events
        .iter()
        .find(|e| e.kind == vst_types::NormalizedEventKind::Usage)
        .unwrap()
        .usage
        .as_ref()
        .unwrap();
    assert_eq!(usage.input_tokens, 9);
    assert_eq!(usage.output_tokens, 3);
    assert_eq!(usage.cache_read_tokens, 1);
    assert_eq!(usage.cache_create_tokens, 2);
    assert_eq!(usage.total_tokens, 15);
    assert_eq!(usage.model, "big-pickle");

    assert!(!r
        .events
        .iter()
        .any(|e| e.text.as_deref() == Some("other session")));
    assert_eq!(r.next_watermark, "2000");
    assert!(r
        .events
        .iter()
        .all(|e| e.provider == vst_types::NormalizedEventProvider::Opencode));
}

// ---------------------------------------------------------------------------
// Registry — P3 gate
// ---------------------------------------------------------------------------
#[test]
fn importer_registry_gate() {
    assert!(has_native_history_importer("claude"));
    assert!(has_native_history_importer("opencode"));
    assert!(!has_native_history_importer("cursor"));
    assert!(!has_native_history_importer("agy"));
    assert_eq!(
        get_native_history_importer("claude").unwrap().cli(),
        "claude"
    );
    assert!(get_native_history_importer("agy").is_none());
}

#[test]
fn opencode_store_path_default() {
    let p = opencode_native_store_path();
    assert!(p.ends_with(".local/share/opencode/opencode.db"));
}
