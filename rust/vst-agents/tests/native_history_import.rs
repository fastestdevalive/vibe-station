//! Behavior contract for the at-rest native-history importers — ports
//! `daemon/src/__tests__/nativeHistoryImport.test.ts` P2.T1 (claude adapter),
//! P2.T2 (opencode adapter), and the P3 registry gate.
//!
//! P2.T3/T4/T5 and 1.T3/1.T5 exercise the transcript store's `importTransaction`
//! (already ported in vst-store) and are out of scope for this crate.

use std::path::{Path, PathBuf};

use vst_agents::claude_import::{claude_native_store_path, create_claude_history_importer};
use vst_agents::codex_import::create_codex_history_importer;
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
        serde_json::json!({ "type": "user", "uuid": "u4", "promptSource": "sdk", "origin": { "kind": "human" }, "message": { "role": "user", "content": [ { "type": "text", "text": "the real message" }, { "type": "text", "text": "# vibe-station Agent Skill\nYou are a coding agent." } ] } }),
        serde_json::json!({ "type": "user", "uuid": "u5", "promptSource": "sdk", "origin": { "kind": "human" }, "message": { "role": "user", "content": [ { "type": "text", "text": "# vibe-station Agent Skill\nYou are a coding agent." }, { "type": "text", "text": "the real message 2" } ] } }),
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
            "the real message",
            "the real message 2"
        ]
    );
}

#[test]
fn claude_first_block_used_for_user_text() {
    // (a) — the user's real prompt is the first text block that does NOT start
    // with the vst system-prompt marker, in BOTH block orders.
    let tmp = tempfile::tempdir().unwrap();
    let projects = tmp.path().join("projects");
    std::fs::create_dir_all(&projects).unwrap();
    let lines = vec![
        serde_json::json!({ "type": "user", "uuid": "a", "origin": { "kind": "human" }, "message": { "role": "user", "content": [ { "type": "text", "text": "# vibe-station Agent Skill\nYou are a coding agent." }, { "type": "text", "text": "the real prompt" } ] } }),
        serde_json::json!({ "type": "user", "uuid": "b", "origin": { "kind": "human" }, "message": { "role": "user", "content": [ { "type": "text", "text": "the real prompt 2" }, { "type": "text", "text": "# vibe-station Agent Skill\nYou are a coding agent." } ] } }),
    ];
    write_claude_store(&projects, "-home-u--wt-proj", CHAT_ID, &lines);

    let importer = create_claude_history_importer(Some(projects.display().to_string()));
    let r = importer.import(&req(CHAT_ID, CWD));
    let users: Vec<_> = r
        .events
        .iter()
        .filter(|e| e.kind == vst_types::NormalizedEventKind::User)
        .map(|e| e.text.clone().unwrap())
        .collect();
    assert_eq!(users, ["the real prompt", "the real prompt 2"]);
}

#[test]
fn claude_autonomous_lines_start_own_groups() {
    // (b) — task-notification / scheduled user lines start their OWN turn group
    // (a Status marker, no user event), evaluated before the isMeta/harness skips.
    let tmp = tempfile::tempdir().unwrap();
    let projects = tmp.path().join("projects");
    std::fs::create_dir_all(&projects).unwrap();
    let lines = vec![
        // Main prompt turn p1.
        serde_json::json!({ "type": "user", "uuid": "p1", "origin": { "kind": "human" }, "message": { "role": "user", "content": [ { "type": "text", "text": "build it" }, { "type": "text", "text": "# vibe-station Agent Skill\nYou are a coding agent." } ] } }),
        serde_json::json!({ "type": "assistant", "message": { "content": [ { "type": "tool_use", "id": "toolu_A", "name": "Read", "input": { "path": "a" } } ] } }),
        serde_json::json!({ "type": "user", "message": { "role": "user", "content": [ { "type": "tool_result", "tool_use_id": "toolu_A", "content": "ok" } ] } }),
        // Autonomous task-notification wake n1 (string content, origin.kind).
        serde_json::json!({ "type": "user", "uuid": "n1", "origin": { "kind": "task-notification" }, "message": { "role": "user", "content": "<task-notification>…" } }),
        serde_json::json!({ "type": "assistant", "message": { "content": [ { "type": "tool_use", "id": "toolu_B", "name": "Read", "input": { "path": "b" } } ] } }),
        // Autonomous scheduled wake n2 (isMeta + turnOrigin, array content).
        serde_json::json!({ "type": "user", "uuid": "n2", "isMeta": true, "turnOrigin": "scheduled", "message": { "role": "user", "content": [ { "type": "text", "text": "scheduled check" } ] } }),
        serde_json::json!({ "type": "assistant", "message": { "content": [ { "type": "tool_use", "id": "toolu_C", "name": "Read", "input": { "path": "c" } } ] } }),
        // Human status check q1.
        serde_json::json!({ "type": "user", "uuid": "q1", "origin": { "kind": "human" }, "message": { "role": "user", "content": "status?" } }),
        serde_json::json!({ "type": "assistant", "message": { "content": [ { "type": "text", "text": "all good" } ] } }),
        // Repeated "yes" prompts.
        serde_json::json!({ "type": "user", "uuid": "y1", "origin": { "kind": "human" }, "message": { "role": "user", "content": "yes" } }),
        serde_json::json!({ "type": "user", "uuid": "y2", "origin": { "kind": "human" }, "message": { "role": "user", "content": "yes" } }),
        // Compaction summary — yields nothing.
        serde_json::json!({ "type": "user", "uuid": "cs", "isCompactSummary": true, "message": { "role": "user", "content": [ { "type": "text", "text": "[compacted history]" } ] } }),
    ];
    write_claude_store(&projects, "-home-u--wt-proj", CHAT_ID, &lines);

    let importer = create_claude_history_importer(Some(projects.display().to_string()));
    let r = importer.import(&req(CHAT_ID, CWD));

    // Distinct non-null turn ids BEFORE the status check (q1): p1, n1, n2.
    let mut seen: Vec<String> = Vec::new();
    for e in &r.events {
        if e.turn_id.is_none() {
            continue;
        }
        if e.kind == vst_types::NormalizedEventKind::User && e.text.as_deref() == Some("status?") {
            break;
        }
        if let Some(t) = &e.turn_id {
            if !seen.contains(t) {
                seen.push(t.clone());
            }
        }
    }
    assert_eq!(seen, ["p1", "n1", "n2"]);

    // The autonomous groups start with a Status marker and hold the recovered
    // tool work; neither has a User event.
    let n1: Vec<_> = r
        .events
        .iter()
        .filter(|e| e.turn_id.as_deref() == Some("n1"))
        .collect();
    assert_eq!(n1[0].kind, vst_types::NormalizedEventKind::Status);
    assert_eq!(
        n1.iter()
            .filter(|e| e.kind == vst_types::NormalizedEventKind::ToolUse)
            .map(|e| e.tool_id.as_deref().unwrap())
            .collect::<Vec<_>>(),
        ["toolu_B"]
    );
    assert!(!n1
        .iter()
        .any(|e| e.kind == vst_types::NormalizedEventKind::User));

    let n2: Vec<_> = r
        .events
        .iter()
        .filter(|e| e.turn_id.as_deref() == Some("n2"))
        .collect();
    assert_eq!(n2[0].kind, vst_types::NormalizedEventKind::Status);
    assert_eq!(
        n2.iter()
            .filter(|e| e.kind == vst_types::NormalizedEventKind::ToolUse)
            .map(|e| e.tool_id.as_deref().unwrap())
            .collect::<Vec<_>>(),
        ["toolu_C"]
    );
    assert!(!n2
        .iter()
        .any(|e| e.kind == vst_types::NormalizedEventKind::User));

    // The main prompt turn uses the real prompt, not the system-prompt block.
    let p1_user = r
        .events
        .iter()
        .find(|e| {
            e.turn_id.as_deref() == Some("p1") && e.kind == vst_types::NormalizedEventKind::User
        })
        .unwrap();
    assert_eq!(p1_user.text.as_deref(), Some("build it"));

    // Repeated human "yes" prompts are both imported (their own groups).
    let yes: Vec<_> = r
        .events
        .iter()
        .filter(|e| e.kind == vst_types::NormalizedEventKind::User)
        .filter(|e| e.text.as_deref() == Some("yes"))
        .collect();
    assert_eq!(yes.len(), 2);

    // Compaction summary yields nothing.
    assert!(!r
        .events
        .iter()
        .any(|e| e.text.as_deref() == Some("[compacted history]")));
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
            { "type": "tool_use", "id": "e4", "name": "Write", "input": { "file_path": "/p/d.ts", "content": "new file content" } },
        ] } }),
        serde_json::json!({ "type": "user", "message": { "role": "user", "content": [
            { "type": "tool_result", "tool_use_id": "e1", "content": "ok" },
            { "type": "tool_result", "tool_use_id": "e2", "content": "ok" },
            { "type": "tool_result", "tool_use_id": "e3", "content": "ok" },
            { "type": "tool_result", "tool_use_id": "e4", "content": "ok" },
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
    // A Write tool call grows a full-file diff with oldText: "".
    let e4 = by_id["e4"].tool_diffs.clone().unwrap();
    assert_eq!(
        e4,
        vec![vst_types::ToolDiff {
            path: "/p/d.ts".into(),
            old_text: Some(String::new()),
            new_text: "new file content".into()
        }]
    );
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
// Codex (codex) at-rest adapter golden
// ---------------------------------------------------------------------------
const CODEX_CHAT_ID: &str = "01a0fe81-d235-7d23-a7f4-bc52ba3b91bf";
const CODEX_FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/codex/rollout-sample.jsonl"
);

/// Lay the fixture down under a store root as
/// `2026/10/02/rollout-2026-10-02T21-25-15-<chat_id>.jsonl`, the real codex
/// `YYYY/MM/DD/rollout-<ts>-<thread-uuid>.jsonl` layout.
fn write_codex_store(store_root: &Path) -> PathBuf {
    let d = store_root.join("2026").join("10").join("02");
    std::fs::create_dir_all(&d).unwrap();
    let content = std::fs::read_to_string(CODEX_FIXTURE).unwrap();
    let file = d.join(format!("rollout-2026-10-02T21-25-15-{CODEX_CHAT_ID}.jsonl"));
    std::fs::write(&file, content).unwrap();
    file
}

#[test]
fn codex_adapter_golden() {
    let tmp = tempfile::tempdir().unwrap();
    let store = tmp.path().join("store");
    std::fs::create_dir_all(&store).unwrap();
    write_codex_store(&store);

    let importer = create_codex_history_importer(Some(store.display().to_string()));
    let r = importer.import(&req(CODEX_CHAT_ID, "/whatever"));

    let kinds: Vec<_> = r.events.iter().map(|e| e.kind).collect();
    assert_eq!(
        kinds,
        vec![
            vst_types::NormalizedEventKind::User,
            vst_types::NormalizedEventKind::ToolUse,
            vst_types::NormalizedEventKind::ToolResult,
            vst_types::NormalizedEventKind::Usage,
            vst_types::NormalizedEventKind::Text,
            vst_types::NormalizedEventKind::Usage,
        ]
    );
    for e in &r.events {
        assert_eq!(
            e.turn_id.as_deref(),
            Some("01a0fe81-d240-7ac0-817c-e84ac3fc941a")
        );
        assert_eq!(e.provider, vst_types::NormalizedEventProvider::Codex);
    }
    assert_eq!(r.next_watermark, "19");
}

#[test]
fn codex_adapter_missing_store_echoes_watermark() {
    let tmp = tempfile::tempdir().unwrap();
    let store = tmp.path().join("does-not-exist");
    let importer = create_codex_history_importer(Some(store.display().to_string()));
    let r = importer.import(&NativeImportRequest {
        watermark: Some("7".into()),
        ..req(CODEX_CHAT_ID, "/whatever")
    });
    assert!(r.events.is_empty());
    assert_eq!(r.next_watermark, "7");
}

#[test]
fn codex_adapter_ignores_nonmatching_thread_file() {
    let tmp = tempfile::tempdir().unwrap();
    let store = tmp.path().join("store");
    std::fs::create_dir_all(&store).unwrap();
    write_codex_store(&store);
    let importer = create_codex_history_importer(Some(store.display().to_string()));
    // Different thread id -> no matching rollout file -> empty.
    let r = importer.import(&req("ffffffff-0000-0000-0000-000000000000", "/whatever"));
    assert!(r.events.is_empty());
    assert_eq!(r.next_watermark, "");
}

// ---------------------------------------------------------------------------
// Registry — P3 gate
// ---------------------------------------------------------------------------
#[test]
fn importer_registry_gate() {
    assert!(has_native_history_importer("claude"));
    assert!(has_native_history_importer("opencode"));
    assert!(has_native_history_importer("codex"));
    assert!(!has_native_history_importer("cursor"));
    assert!(!has_native_history_importer("agy"));
    assert_eq!(
        get_native_history_importer("claude").unwrap().cli(),
        "claude"
    );
    assert_eq!(get_native_history_importer("codex").unwrap().cli(), "codex");
    assert!(get_native_history_importer("agy").is_none());
}

#[test]
fn opencode_store_path_default() {
    let p = opencode_native_store_path();
    assert!(p.ends_with(".local/share/opencode/opencode.db"));
}

// ---------------------------------------------------------------------------
// 3.T6 — end-to-end: claude importer → transcript store
// ---------------------------------------------------------------------------

fn store_ev(
    kind: vst_types::NormalizedEventKind,
    extra: serde_json::Value,
    session_id: &str,
) -> vst_types::NormalizedEvent {
    let mut e: vst_types::NormalizedEvent = serde_json::from_value(serde_json::json!({
        "id": format!("e-{}", std::process::id()),
        "sessionId": session_id,
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
    if let Some(tool_id) = extra.get("toolId") {
        e.tool_id = tool_id.as_str().map(str::to_string);
    }
    e
}

/// End-to-end tty→json toggle: live log already holds turn-1 (prompt + toolu_A);
/// the importer parses the native fixture from watermark 0; the store must not
/// duplicate turn 1 (tool-id dedupe), import the recovered autonomous groups
/// (toolu_B/toolu_C) once, and not duplicate the status-check turns.
#[test]
fn end_to_end_tty_json_toggle_imports_once() {
    let tmp = tempfile::tempdir().unwrap();
    let projects = tmp.path().join("projects");
    std::fs::create_dir_all(&projects).unwrap();

    // Live log: turn-1 prompt-only, toolu_A (the same tool id the native turn 1 has).
    let mut store = vst_store::transcript::open_transcript_store(tmp.path(), SESSION_ID);
    store.append(&mut store_ev(
        vst_types::NormalizedEventKind::User,
        serde_json::json!({"text": "build it", "turnId": "live-1"}),
        SESSION_ID,
    ));
    store.append(&mut store_ev(
        vst_types::NormalizedEventKind::ToolUse,
        serde_json::json!({"toolId": "toolu_A", "turnId": "live-1"}),
        SESSION_ID,
    ));

    // Native fixture from watermark 0 (same shape as 3.9).
    let lines = vec![
        serde_json::json!({ "type": "user", "uuid": "p1", "origin": { "kind": "human" }, "message": { "role": "user", "content": [ { "type": "text", "text": "build it" }, { "type": "text", "text": "# vibe-station Agent Skill\nYou are a coding agent." } ] } }),
        serde_json::json!({ "type": "assistant", "message": { "content": [ { "type": "tool_use", "id": "toolu_A", "name": "Read", "input": { "path": "a" } } ] } }),
        serde_json::json!({ "type": "user", "uuid": "n1", "origin": { "kind": "task-notification" }, "message": { "role": "user", "content": "<task-notification>…" } }),
        serde_json::json!({ "type": "assistant", "message": { "content": [ { "type": "tool_use", "id": "toolu_B", "name": "Read", "input": { "path": "b" } } ] } }),
        serde_json::json!({ "type": "user", "uuid": "n2", "isMeta": true, "turnOrigin": "scheduled", "message": { "role": "user", "content": [ { "type": "text", "text": "scheduled check" } ] } }),
        serde_json::json!({ "type": "assistant", "message": { "content": [ { "type": "tool_use", "id": "toolu_C", "name": "Read", "input": { "path": "c" } } ] } }),
        serde_json::json!({ "type": "user", "uuid": "q1", "origin": { "kind": "human" }, "message": { "role": "user", "content": "status?" } }),
        serde_json::json!({ "type": "assistant", "message": { "content": [ { "type": "text", "text": "all good" } ] } }),
    ];
    write_claude_store(&projects, "-home-u--wt-proj", CHAT_ID, &lines);

    let importer = create_claude_history_importer(Some(projects.display().to_string()));
    let r = importer.import(&req(CHAT_ID, CWD));
    let outcome = store.import_transaction(
        r.events,
        vst_store::transcript::ImportOptions {
            cli: "claude".into(),
            cursor: r.next_watermark,
        },
    );

    // Re-importing the same native events is a no-op.
    let again = importer.import(&req(CHAT_ID, CWD));
    let outcome2 = store.import_transaction(
        again.events,
        vst_store::transcript::ImportOptions {
            cli: "claude".into(),
            cursor: again.next_watermark,
        },
    );
    assert_eq!(outcome2.imported, 0);

    // turn-1 (p1) skipped via tool-id dedupe; the autonomous groups (n1, n2) and
    // the status-check turn (q1) are all new and imported.
    assert_eq!(outcome.turns_imported, 3);
    assert_eq!(outcome.turns_skipped, 1);

    // The final log has toolu_A exactly once (the live one), toolu_B/toolu_C once.
    let all = store.read_all();
    let tool_ids: Vec<_> = all
        .iter()
        .filter(|e| e.kind == vst_types::NormalizedEventKind::ToolUse)
        .filter_map(|e| e.tool_id.clone())
        .collect();
    assert_eq!(tool_ids, ["toolu_A", "toolu_B", "toolu_C"]);
    // The status-check turn is present exactly once.
    let status_checks = all
        .iter()
        .filter(|e| e.kind == vst_types::NormalizedEventKind::User)
        .filter(|e| e.text.as_deref() == Some("status?"))
        .count();
    assert_eq!(status_checks, 1);
}
