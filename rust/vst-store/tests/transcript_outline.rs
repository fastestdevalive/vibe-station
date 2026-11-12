use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use vst_store::transcript::{open_transcript_store, TranscriptStore};
use vst_store::transcript_outline::{
    outline_label, OutlineSummary, OutlineTurn, OutlineWindow, OUTLINE_LABEL_MAX_CHARS,
};
use vst_types::{AcpToolKind, NormalizedEvent, NormalizedEventKind, ToolResult};

const SESSION_ID: &str = "test-session";
const TS: &str = "2026-01-01T00:00:00.000Z";

static COUNTER: AtomicU64 = AtomicU64::new(1);

fn base(kind: NormalizedEventKind, turn: Option<&str>) -> NormalizedEvent {
    NormalizedEvent {
        id: format!("id-{}", COUNTER.fetch_add(1, Ordering::Relaxed)),
        session_id: SESSION_ID.to_string(),
        ts: TS.to_string(),
        kind,
        turn_id: turn.map(str::to_string),
        ..NormalizedEvent::default()
    }
}

fn user(turn: Option<&str>, text: &str) -> NormalizedEvent {
    NormalizedEvent {
        text: Some(text.to_string()),
        ..base(NormalizedEventKind::User, turn)
    }
}

fn silent_user(turn: Option<&str>, text: &str) -> NormalizedEvent {
    NormalizedEvent {
        silent: Some(true),
        ..user(turn, text)
    }
}

fn text(turn: Option<&str>, body: &str) -> NormalizedEvent {
    NormalizedEvent {
        text: Some(body.to_string()),
        ..base(NormalizedEventKind::Text, turn)
    }
}

fn tool_use(
    turn: Option<&str>,
    tool_id: &str,
    name: &str,
    kind: Option<AcpToolKind>,
) -> NormalizedEvent {
    NormalizedEvent {
        tool_id: Some(tool_id.to_string()),
        tool_name: Some(name.to_string()),
        tool_kind: kind,
        ..base(NormalizedEventKind::ToolUse, turn)
    }
}

fn tool_result(turn: Option<&str>, tool_id: &str, is_error: bool) -> NormalizedEvent {
    NormalizedEvent {
        tool_id: Some(tool_id.to_string()),
        tool_result: Some(ToolResult {
            content: None,
            is_error: Some(is_error),
        }),
        ..base(NormalizedEventKind::ToolResult, turn)
    }
}

fn error_row(turn: Option<&str>) -> NormalizedEvent {
    NormalizedEvent {
        text: Some("boom".to_string()),
        ..base(NormalizedEventKind::Error, turn)
    }
}

fn nested(ev: NormalizedEvent) -> NormalizedEvent {
    NormalizedEvent {
        parent_tool_use_id: Some("parent-call".to_string()),
        ..ev
    }
}

/// One turn: its user prompt followed by one reply row.
fn turn(turn_id: &str, prompt: &str) -> Vec<NormalizedEvent> {
    vec![user(Some(turn_id), prompt), text(Some(turn_id), "reply")]
}

/// Turns with a tool call each, for bucket arithmetic.
fn tool_turns(count: usize) -> Vec<NormalizedEvent> {
    (0..count)
        .flat_map(|n| {
            let id = format!("t{n}");
            vec![
                user(Some(&id), &format!("prompt {n}")),
                tool_use(Some(&id), &format!("c{n}"), "Read", None),
            ]
        })
        .collect()
}

fn append_all(store: &mut TranscriptStore, events: Vec<NormalizedEvent>) -> Vec<i64> {
    events
        .into_iter()
        .map(|mut ev| store.append(&mut ev))
        .collect()
}

fn open(dir: &Path) -> TranscriptStore {
    open_transcript_store(dir, SESSION_ID).unwrap()
}

fn catch_up(store: &mut TranscriptStore) {
    for _ in 0..100 {
        if store.catch_up_step().unwrap() {
            return;
        }
    }
    panic!("catch-up did not finish");
}

fn summary(store: &TranscriptStore) -> OutlineSummary {
    store.outline_summary().unwrap().expect("outline enabled")
}

fn window(store: &TranscriptStore, from: i64, limit: usize) -> OutlineWindow {
    store
        .outline_window(from, limit)
        .unwrap()
        .expect("outline enabled")
}

/// Every turn, read through the window API in pages of 100.
fn all_turns(store: &TranscriptStore) -> Vec<OutlineTurn> {
    let total = summary(store).total_turns;
    let mut turns = Vec::new();
    let mut from = 0;
    while from < total {
        let page = window(store, from, 100);
        assert!(!page.turns.is_empty(), "window {from} empty before total");
        from += page.turns.len() as i64;
        turns.extend(page.turns);
    }
    turns
}

fn sample_events() -> Vec<NormalizedEvent> {
    let mut events = Vec::new();
    events.extend(turn("t1", "first prompt"));
    events.push(tool_use(Some("t1"), "a", "Read", None));
    events.push(tool_result(Some("t1"), "a", false));
    events.push(tool_use(Some("t1"), "b", "Edit", Some(AcpToolKind::Edit)));
    events.push(tool_result(Some("t1"), "b", true));
    events.push(error_row(Some("t1")));
    events.push(nested(tool_use(
        Some("t1"),
        "n",
        "Edit",
        Some(AcpToolKind::Edit),
    )));
    events.push(silent_user(Some("s"), "hidden"));
    events.extend(turn("t2", "second prompt"));
    events.push(user(Some("t1"), "repeated key prompt"));
    events.push(tool_use(Some("t2"), "c", "write_file", None));
    events.push(user(None, "legacy prompt"));
    events.push(tool_use(None, "d", "Bash", None));
    events
}

fn built(events: Vec<NormalizedEvent>) -> (tempfile::TempDir, TranscriptStore) {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(dir.path());
    append_all(&mut store, events);
    catch_up(&mut store);
    (dir, store)
}

#[test]
fn live_apply_matches_catch_up_build() {
    let live_dir = tempfile::tempdir().unwrap();
    let mut live = open(live_dir.path());
    catch_up(&mut live);
    append_all(&mut live, sample_events());

    let (_built_dir, fresh) = built(sample_events());

    assert_eq!(summary(&live), summary(&fresh));
    assert_eq!(all_turns(&live), all_turns(&fresh));
    assert_eq!(all_turns(&live).len(), 3);
}

#[test]
fn counts_follow_the_turn_rules() {
    let (_dir, store) = built(sample_events());
    let turns = all_turns(&store);
    let keys: Vec<&str> = turns.iter().map(|t| t.turn_key.as_str()).collect();
    assert_eq!(keys[0], "t1");
    assert_eq!(keys[1], "t2");
    assert!(
        keys[2].starts_with("seq:"),
        "legacy row keyed by seq: {keys:?}"
    );

    let t1 = &turns[0];
    assert_eq!((t1.tools, t1.edits, t1.errors), (2, 1, 2));
    assert_eq!(t1.label, "first prompt");
    assert!(t1.ts.is_some());
    let t2 = &turns[1];
    assert_eq!((t2.tools, t2.edits, t2.errors), (1, 1, 0));
    let legacy = &turns[2];
    assert_eq!((legacy.tools, legacy.edits, legacy.errors), (1, 0, 0));
    assert_eq!(legacy.label, "legacy prompt");
}

#[test]
fn duplicate_turn_key_does_not_move_the_tail() {
    let mut events = turn("t1", "one");
    events.extend(turn("t2", "two"));
    events.push(user(Some("t1"), "again"));
    events.push(tool_use(None, "x", "Read", None));
    let (_dir, store) = built(events);
    let turns = all_turns(&store);
    assert_eq!(summary(&store).total_turns, 2);
    assert_eq!((turns[0].tools, turns[1].tools), (0, 1));
}

#[test]
fn nested_and_silent_rows_do_not_count() {
    let mut events = turn("t1", "one");
    events.push(nested(tool_use(Some("t1"), "n", "Read", None)));
    events.push(nested(error_row(Some("t1"))));
    events.push(silent_user(Some("t9"), "hidden"));
    let (_dir, store) = built(events);
    let turns = all_turns(&store);
    assert_eq!(turns.len(), 1);
    assert_eq!((turns[0].tools, turns[0].errors), (0, 0));
}

#[test]
fn resumes_mid_turn_after_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let mut live = open(dir.path());
    catch_up(&mut live);
    append_all(
        &mut live,
        vec![
            user(Some("t1"), "prompt"),
            tool_use(Some("t1"), "a", "Read", None),
            tool_result(Some("t1"), "a", false),
        ],
    );
    drop(live);

    let mut reopened = open(dir.path());
    catch_up(&mut reopened);
    append_all(
        &mut reopened,
        vec![
            tool_result(Some("t1"), "a", false),
            tool_use(Some("t1"), "b", "Read", None),
        ],
    );

    let (_built_dir, fresh) = built(vec![
        user(Some("t1"), "prompt"),
        tool_use(Some("t1"), "a", "Read", None),
        tool_result(Some("t1"), "a", false),
        tool_result(Some("t1"), "a", false),
        tool_use(Some("t1"), "b", "Read", None),
    ]);
    assert_eq!(all_turns(&reopened), all_turns(&fresh));
    assert_eq!(all_turns(&reopened)[0].tools, 2);
}

#[test]
fn resumes_a_turn_split_across_chunks() {
    let mut events = vec![user(Some("big"), "big prompt")];
    events.extend((0..6000).map(|n| tool_use(Some("big"), &format!("k{n}"), "Read", None)));
    let dir = tempfile::tempdir().unwrap();
    let mut first = open(dir.path());
    append_all(&mut first, events);
    assert!(
        !first.catch_up_step().unwrap(),
        "one chunk cannot finish 6001 rows"
    );
    drop(first);

    let mut resumed = open(dir.path());
    catch_up(&mut resumed);
    let turns = all_turns(&resumed);
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].tools, 6000);
}

#[test]
fn fork_drops_superseded_turns_and_bumps_revision() {
    let mut events = turn("t1", "first");
    events.push(tool_use(Some("t1"), "a", "Read", None));
    events.extend(turn("t2", "second"));
    events.push(tool_use(Some("t2"), "b", "Edit", Some(AcpToolKind::Edit)));
    events.extend(turn("t3", "third"));
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(dir.path());
    append_all(&mut store, events);
    catch_up(&mut store);
    let before = summary(&store);
    let t2_seq = all_turns(&store)[1].seq;

    let mut superseded = store.mark_superseded_from(t2_seq);
    superseded.sort();
    assert_eq!(superseded, ["t2", "t3"]);
    assert!(!summary(&store).ready, "not ready until the rebuild lands");
    catch_up(&mut store);

    let after = summary(&store);
    assert_eq!(after.total_turns, 1);
    assert_eq!(after.revision, before.revision + 1);
    let (_fresh_dir, fresh) = built(vec![
        user(Some("t1"), "first"),
        text(Some("t1"), "reply"),
        tool_use(Some("t1"), "a", "Read", None),
    ]);
    assert_eq!(all_turns(&store), all_turns(&fresh));

    append_all(&mut store, turn("t4", "after fork"));
    assert_eq!(summary(&store).total_turns, 2);
}

#[test]
fn rollback_then_rebuild_equals_a_fresh_build() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(dir.path());
    catch_up(&mut store);
    append_all(&mut store, turn("t1", "kept"));

    let raw = rusqlite::Connection::open(dir.path().join("messages.db")).unwrap();
    raw.execute_batch(
        "CREATE TRIGGER abort_marked BEFORE INSERT ON message
         WHEN NEW.payload LIKE '%BOOM%' BEGIN SELECT RAISE(ABORT, 'boom'); END;",
    )
    .unwrap();
    let batch = vec![
        user(Some("t2"), "BOOM"),
        tool_use(Some("t2"), "x", "Read", None),
    ];
    assert!(store.append_batch(&mut batch.clone()).is_err());
    assert!(
        !summary(&store).ready,
        "a rolled-back batch drops the index"
    );
    raw.execute_batch("DROP TRIGGER abort_marked").unwrap();
    drop(raw);

    store.append_batch(&mut turn("t2", "BOOM later")).unwrap();
    catch_up(&mut store);

    let (_fresh_dir, fresh) = built([turn("t1", "kept"), turn("t2", "BOOM later")].concat());
    assert_eq!(all_turns(&store), all_turns(&fresh));
    assert_eq!(all_turns(&store).len(), 2);
}

#[test]
fn apply_failure_keeps_the_message_row() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(dir.path());
    catch_up(&mut store);
    append_all(&mut store, turn("t1", "one"));

    let raw = rusqlite::Connection::open(dir.path().join("messages.db")).unwrap();
    raw.execute_batch(
        "CREATE TRIGGER refuse_turn BEFORE INSERT ON turn_outline
         WHEN NEW.label = 'FAIL' BEGIN SELECT RAISE(ABORT, 'refused'); END;",
    )
    .unwrap();
    append_all(&mut store, turn("t2", "FAIL"));
    raw.execute_batch("DROP TRIGGER refuse_turn").unwrap();
    drop(raw);

    assert_eq!(store.count(), 4, "the message rows are all persisted");
    assert!(
        !summary(&store).ready,
        "the index is dropped after a failed apply"
    );
    catch_up(&mut store);
    let (_fresh_dir, fresh) = built([turn("t1", "one"), turn("t2", "FAIL")].concat());
    assert_eq!(all_turns(&store), all_turns(&fresh));
    assert_eq!(all_turns(&store).len(), 2);
}

#[test]
fn version_wipe_rebuilds_and_bumps_revision() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(dir.path());
    append_all(&mut store, [turn("t1", "a"), turn("t2", "b")].concat());
    catch_up(&mut store);
    let before = summary(&store);
    drop(store);

    let raw = rusqlite::Connection::open(dir.path().join("messages.db")).unwrap();
    raw.execute("UPDATE turn_outline_state SET version = 0", [])
        .unwrap();
    drop(raw);

    let mut reopened = open(dir.path());
    catch_up(&mut reopened);
    let after = summary(&reopened);
    assert_eq!(after.revision, before.revision + 1);
    assert_eq!(after.total_turns, 2);
    assert_eq!(all_turns(&reopened).len(), 2);
}

#[test]
fn resume_skips_the_scan_when_the_index_is_current() {
    let mut events = Vec::new();
    for n in 0..2600 {
        events.extend(turn(&format!("t{n}"), &format!("prompt {n}")));
    }
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(dir.path());
    append_all(&mut store, events);
    catch_up(&mut store);
    drop(store);

    let mut reopened = open(dir.path());
    assert!(
        reopened.catch_up_step().unwrap(),
        "a current index resumes at its last turn in one step (5200 rows would need two)"
    );
    assert_eq!(summary(&reopened).total_turns, 2600);
}

#[test]
fn two_writers_catching_up_one_file_agree() {
    let mut events = Vec::new();
    for n in 0..2600 {
        events.extend(turn(&format!("t{n}"), &format!("prompt {n}")));
    }
    let dir = tempfile::tempdir().unwrap();
    let mut writer = open(dir.path());
    append_all(&mut writer, events.clone());
    let mut a = open(dir.path());
    let mut b = open(dir.path());

    let mut done = (false, false);
    for _ in 0..100 {
        done.0 = done.0 || a.catch_up_step().unwrap();
        done.1 = done.1 || b.catch_up_step().unwrap();
        if done == (true, true) {
            break;
        }
    }
    assert_eq!(done, (true, true));

    let (_fresh_dir, fresh) = built(events);
    assert_eq!(all_turns(&a), all_turns(&fresh));
    assert_eq!(all_turns(&b), all_turns(&fresh));
    assert_eq!(summary(&a), summary(&fresh));
}

#[test]
fn summary_buckets_sum_to_totals_and_cross_1000_turns() {
    let (_dir, store) = built(tool_turns(1001));
    let s = summary(&store);
    assert_eq!(s.total_turns, 1001);
    assert_eq!(s.bucket_size, 2);
    assert_eq!(s.tools.len(), 501);
    assert_eq!(s.tools.iter().map(|&n| u64::from(n)).sum::<u64>(), 1001);
    assert_eq!(s.tools[0], 2);
    assert_eq!(s.edits.iter().sum::<u32>(), 0);
    assert_eq!(s.errors.iter().sum::<u32>(), 0);
    assert_eq!(s.edits.len(), s.tools.len());
    assert_eq!(s.errors.len(), s.tools.len());
}

#[test]
fn summary_is_per_turn_up_to_1000_turns() {
    let (_dir, store) = built(tool_turns(1000));
    let s = summary(&store);
    assert_eq!(s.bucket_size, 1);
    assert_eq!(s.tools, vec![1; 1000]);
}

#[test]
fn window_bounds_and_clamping() {
    let events: Vec<NormalizedEvent> = (0..5)
        .flat_map(|n| turn(&format!("t{n}"), &format!("prompt {n}")))
        .collect();
    let (_dir, store) = built(events);

    let all = window(&store, 0, 40);
    assert!(all.ready);
    assert_eq!(all.total_turns, 5);
    assert_eq!(all.turns.len(), 5);

    let middle = window(&store, 3, 2);
    assert_eq!(middle.from, 3);
    let keys: Vec<&str> = middle.turns.iter().map(|t| t.turn_key.as_str()).collect();
    assert_eq!(keys, ["t3", "t4"]);

    assert!(window(&store, 5, 40).turns.is_empty());
    assert!(window(&store, 100, 1).turns.is_empty());
    assert_eq!(window(&store, 0, 0).turns.len(), 1, "limit clamps up to 1");
    assert_eq!(
        window(&store, 0, 500).turns.len(),
        5,
        "limit clamps down to 100"
    );
}

#[test]
fn empty_store_is_ready_with_no_turns() {
    let (_dir, store) = built(Vec::new());
    let s = summary(&store);
    assert!(s.ready);
    assert_eq!(s.total_turns, 0);
    assert_eq!(s.bucket_size, 1);
    assert!(s.tools.is_empty());
    assert!(window(&store, 0, 40).turns.is_empty());
}

#[test]
fn unbuilt_index_is_not_ready() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(dir.path());
    append_all(&mut store, turn("t1", "one"));
    let s = summary(&store);
    assert!(!s.ready);
    assert_eq!(s.total_turns, 0);
    let w = window(&store, 0, 40);
    assert!(!w.ready);
    assert!(w.turns.is_empty());
}

#[test]
fn label_is_sanitized_first_line_capped_at_80_chars() {
    assert_eq!(
        outline_label("\n\n  hello\u{1b}[31m world  \nsecond"),
        "hello[31m world"
    );
    assert_eq!(
        outline_label(&"x".repeat(200)).chars().count(),
        OUTLINE_LABEL_MAX_CHARS
    );
    assert_eq!(outline_label("a\u{202E}b"), "a<U+202E>b");
    assert_eq!(outline_label(""), "");
}

fn superseded_count(dir: &Path) -> i64 {
    rusqlite::Connection::open(dir.join("messages.db"))
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM message WHERE superseded = 1",
            [],
            |r| r.get(0),
        )
        .unwrap()
}

#[test]
fn fork_with_the_outline_disabled_still_supersedes() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(dir.path());
    let seqs = append_all(&mut store, [turn("t1", "a"), turn("t2", "b")].concat());
    drop(store);

    let raw = rusqlite::Connection::open(dir.path().join("messages.db")).unwrap();
    // A view in place of the state table makes ensure_schema fail, which disables the outline.
    raw.execute_batch(
        "DROP TABLE turn_outline; DROP TABLE turn_outline_state;
         CREATE VIEW turn_outline_state AS SELECT 1 AS x;",
    )
    .unwrap();
    drop(raw);

    let mut store = open(dir.path());
    assert!(
        store.outline_summary().unwrap().is_none(),
        "outline disabled"
    );
    let superseded = store.mark_superseded_from(seqs[2]);
    assert_eq!(superseded, ["t2"]);
    assert_eq!(superseded_count(dir.path()), 2);
}

#[test]
fn fork_with_a_missing_outline_table_still_supersedes() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(dir.path());
    let seqs = append_all(&mut store, [turn("t1", "a"), turn("t2", "b")].concat());
    catch_up(&mut store);

    let raw = rusqlite::Connection::open(dir.path().join("messages.db")).unwrap();
    raw.execute_batch("DROP TABLE turn_outline").unwrap();
    drop(raw);

    let superseded = store.mark_superseded_from(seqs[2]);
    assert_eq!(superseded, ["t2"]);
    assert_eq!(superseded_count(dir.path()), 2);
    assert!(
        store.outline_summary().unwrap().is_none(),
        "the outline is disabled for this open"
    );
}

#[test]
fn a_current_index_performs_no_payload_scan() {
    let mut events = turn("t1", "one");
    events.push(tool_use(Some("t1"), "a", "Read", None));
    events.push(tool_use(Some("t1"), "b", "Read", None));
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(dir.path());
    append_all(&mut store, events);
    catch_up(&mut store);
    let before = all_turns(&store);
    drop(store);

    // A rebuild of the last turn would recount these rows as zero tools.
    let raw = rusqlite::Connection::open(dir.path().join("messages.db")).unwrap();
    raw.execute(
        "UPDATE message SET payload = 'not json' WHERE kind IN ('tool_use', 'tool_result')",
        [],
    )
    .unwrap();
    drop(raw);

    let mut reopened = open(dir.path());
    assert!(reopened.catch_up_step().unwrap());
    assert_eq!(
        all_turns(&reopened),
        before,
        "counts untouched, nothing read"
    );
}

#[test]
fn live_apply_after_a_lazy_rebuild_equals_a_full_catch_up() {
    let mut first = turn("t1", "one");
    first.push(tool_use(Some("t1"), "a", "Read", None));
    first.push(tool_use(Some("t1"), "b", "Edit", Some(AcpToolKind::Edit)));
    let dir = tempfile::tempdir().unwrap();
    let mut store = open(dir.path());
    append_all(&mut store, first.clone());
    catch_up(&mut store);
    drop(store);

    let more = vec![
        tool_use(Some("t1"), "c", "Write", None),
        tool_result(Some("t1"), "a", true),
        error_row(Some("t1")),
    ];
    let mut reopened = open(dir.path());
    assert!(reopened.catch_up_step().unwrap());
    append_all(&mut reopened, more.clone());
    let live = all_turns(&reopened);

    let (_fresh_dir, fresh) = built([first, more].concat());
    assert_eq!(live, all_turns(&fresh));
    assert_eq!(live[0].tools, 3);
}
