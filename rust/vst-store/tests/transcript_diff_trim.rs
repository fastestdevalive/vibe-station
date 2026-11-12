use vst_store::transcript::{open_transcript_store, transcript_db_path, ImportOutcome};
use vst_types::{NormalizedEvent, NormalizedEventKind};

const SESSION_ID: &str = "test-session";

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
    if let Some(tool_id) = extra.get("toolId") {
        e.tool_id = tool_id.as_str().map(str::to_string);
    }
    e
}

fn opts(cursor: &str) -> vst_store::transcript::ImportOptions {
    vst_store::transcript::ImportOptions {
        cli: "claude".into(),
        cursor: cursor.into(),
    }
}

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
        let mut s = open_transcript_store(dir.path(), SESSION_ID).unwrap();
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
    let s2 = open_transcript_store(dir.path(), SESSION_ID).unwrap();
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
    let s3 = open_transcript_store(dir.path(), SESSION_ID).unwrap();
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
        let mut s = open_transcript_store(dir.path(), SESSION_ID).unwrap();
        let mut e = ev(
            NormalizedEventKind::ToolUse,
            serde_json::json!({"turnId": "t1", "toolId": "tu-1"}),
        );
        e.tool_diffs = Some(vec![small.clone(), write.clone()]);
        s.append(&mut e);
    }
    simulate_db_written_before_the_trim_migration(dir.path());
    let s2 = open_transcript_store(dir.path(), SESSION_ID).unwrap();
    let row = s2
        .read_all()
        .into_iter()
        .find(|e| e.tool_diffs.is_some())
        .unwrap();
    let diffs = row.tool_diffs.as_ref().unwrap();
    assert_eq!(diffs.len(), 2);
    assert_eq!(diffs[0].old_text.as_deref(), Some("a\nb"));
    assert_eq!(diffs[0].new_text, "a\nc");
    assert_eq!(diffs[1].old_text.as_deref(), Some(""));
    assert_eq!(diffs[1].new_text, write.new_text);
}

#[test]
fn diff_trim_backfill_runs_before_the_oversized_cap() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut s = open_transcript_store(dir.path(), SESSION_ID).unwrap();
        let mut e = tool_event(NormalizedEventKind::ToolResult, "tu-1");
        // Oversized result that triggers the 100 KiB cap, paired with a whole-file diff.
        e.text = Some("x".repeat(120 * 1024));
        s.append(&mut e);
    }
    simulate_db_written_before_the_trim_migration(dir.path());
    let s2 = open_transcript_store(dir.path(), SESSION_ID).unwrap();
    let row = s2
        .read_all()
        .into_iter()
        .find(|e| e.tool_diffs.is_some())
        .unwrap();
    let diffs = row.tool_diffs.as_ref().unwrap();
    // Trim ran -> hunks are short, not whole-file.
    assert_eq!(diffs.len(), 2);
    assert!(diffs.iter().all(|d| d.new_text.len() < 1024));
}

#[test]
fn diff_trim_backfill_survives_a_malformed_payload_row() {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut s = open_transcript_store(dir.path(), SESSION_ID).unwrap();
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
    let s = open_transcript_store(dir.path(), SESSION_ID).unwrap();
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
    let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();

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
