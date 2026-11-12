use vst_store::transcript::open_transcript_store;
use vst_store::transcript_search::{SearchOutcome, SearchRequest, SearchScope};
use vst_types::{NormalizedEvent, NormalizedEventKind, NormalizedEventProvider, Role};

const SESSION_ID: &str = "test-session";

mod nanoid {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    pub fn nanoid() -> String {
        format!("id-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
    }
}

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

fn ev_with_payload(kind: NormalizedEventKind, extra: serde_json::Value) -> NormalizedEvent {
    let mut e: NormalizedEvent = serde_json::from_value(serde_json::json!({
        "id": format!("e-{}", nanoid::nanoid()),
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
    e
}

fn append_turn(store: &mut vst_store::transcript::TranscriptStore, turn_id: &str) -> i64 {
    let first = store.append(&mut ev_with_payload(
        NormalizedEventKind::User,
        serde_json::json!({"role": "user", "text": format!("q {turn_id}"), "turnId": turn_id}),
    ));
    store.append(&mut ev_with_payload(
        NormalizedEventKind::Text,
        serde_json::json!({"role": "assistant", "text": format!("a {turn_id}"), "turnId": turn_id}),
    ));
    store.append(&mut ev_with_payload(
        NormalizedEventKind::Result,
        serde_json::json!({"turnId": turn_id}),
    ));
    first
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
fn page_around_is_turn_aligned() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();

    let mut turn_first_seqs = Vec::new();
    for i in 1..=40 {
        let first = append_turn(&mut store, &format!("t{i}"));
        turn_first_seqs.push(first);
    }

    let seq_in_turn_20 = turn_first_seqs[19]; // index 19 is turn 20
    let page = store.page_around(seq_in_turn_20, 15, usize::MAX).unwrap();

    assert!(page.has_more, "has_more must be true");
    assert_eq!(
        page.turns_before, 12,
        "turns_before must be 12 (turns 1..=12)"
    );

    let distinct_turns: Vec<String> = {
        let mut turns = Vec::new();
        for ev in &page.events {
            if let Some(ref t) = ev.turn_id {
                if !turns.contains(t) {
                    turns.push(t.clone());
                }
            }
        }
        turns
    };
    let expected_turns: Vec<String> = (13..=27).map(|i| format!("t{i}")).collect();
    assert_eq!(distinct_turns, expected_turns, "turns 13..=27 returned");

    // With max_bytes = 0: only turn 20 is returned
    let page_zero = store.page_around(seq_in_turn_20, 15, 0).unwrap();
    let zero_turns: Vec<String> = {
        let mut turns = Vec::new();
        for ev in &page_zero.events {
            if let Some(ref t) = ev.turn_id {
                if !turns.contains(t) {
                    turns.push(t.clone());
                }
            }
        }
        turns
    };
    assert_eq!(zero_turns, vec!["t20".to_string()]);
}

#[test]
fn page_around_propagates_db_errors() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();
    store.append(&mut ev(
        NormalizedEventKind::User,
        Some("t1"),
        Some("hello"),
    ));

    let raw_conn = rusqlite::Connection::open(dir.path().join("messages.db")).unwrap();
    raw_conn
        .execute("ALTER TABLE message RENAME TO message_gone", [])
        .unwrap();

    assert!(store.page_around(0, 15, usize::MAX).is_err());
    assert!(store.user_turns_before(1).is_err());
}

/// Legacy `user` rows without a `turn_id` are each their own turn, both for
/// window alignment and for user-turn numbering, and the legacy replies after
/// them stay in that turn, so `turnsBefore` plus the user turns a window shows
/// always equals a hit's `turnIndex`.
#[test]
fn null_turn_id_rows_keep_windows_and_turn_numbers_consistent() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();
    let rows = [
        (NormalizedEventKind::User, None, "alpha one"),
        (NormalizedEventKind::Text, None, "reply alpha"),
        (NormalizedEventKind::User, None, "bravo two"),
        (NormalizedEventKind::Text, None, "reply bravo"),
        (NormalizedEventKind::User, Some("t5"), "charlie three"),
        (NormalizedEventKind::Text, Some("t5"), "reply charlie"),
        (NormalizedEventKind::User, None, "delta four"),
        (NormalizedEventKind::Text, None, "reply delta"),
    ];
    for (kind, turn, text) in rows {
        store.append(&mut ev(kind, turn, Some(text)));
    }

    let outcome = search_all(&mut store, "reply");
    assert_eq!(outcome.turn_count, 4);
    let indices: Vec<(i64, i64)> = outcome.hits.iter().map(|h| (h.seq, h.turn_index)).collect();
    assert_eq!(indices, vec![(1, 1), (3, 2), (5, 3), (7, 4)]);

    // A one-turn window holds exactly one turn: the whole `t5` turn, or one
    // legacy turn.
    let one_turn = store.page_around(5, 1, usize::MAX).unwrap();
    assert_eq!(
        one_turn
            .events
            .iter()
            .map(|e| e.log_seq.unwrap())
            .collect::<Vec<_>>(),
        vec![4, 5]
    );
    assert_eq!(one_turn.turns_before, 2);

    let legacy_one = store.page_around(1, 1, usize::MAX).unwrap();
    assert_eq!(
        legacy_one
            .events
            .iter()
            .map(|e| e.log_seq.unwrap())
            .collect::<Vec<_>>(),
        vec![0, 1]
    );
    assert_eq!(legacy_one.turns_before, 0);

    // Numbering matches search: `turnsBefore` + user turns shown in window = hit's `turnIndex`.
    for hit in &outcome.hits {
        let page = store.page_around(hit.seq, 15, usize::MAX).unwrap();
        let user_turns_shown = i64::try_from(
            page.events
                .iter()
                .filter(|e| e.kind == NormalizedEventKind::User)
                .filter(|e| e.log_seq.unwrap() <= hit.seq)
                .count(),
        )
        .unwrap();
        assert_eq!(page.turns_before + user_turns_shown, hit.turn_index);
    }
}

/// Interleaved non-user rows without a `turn_id` (e.g. status, task_signal,
/// message_generated) belong to the turn around them: they neither count as a
/// window turn nor open a window inside a turn, away from its user prompt.
#[test]
fn null_turn_id_non_user_rows_stay_inside_their_turn() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_transcript_store(dir.path(), SESSION_ID).unwrap();
    let rows = [
        (NormalizedEventKind::Status, None, None),
        (NormalizedEventKind::User, None, Some("legacy one")),
        (NormalizedEventKind::Text, None, Some("reply legacy one")),
        (NormalizedEventKind::User, None, Some("legacy two")),
        (NormalizedEventKind::Text, None, Some("reply legacy two")),
        (NormalizedEventKind::User, Some("t6"), Some("modern three")),
        (NormalizedEventKind::Status, None, None),
        (
            NormalizedEventKind::Text,
            Some("t6"),
            Some("reply modern three"),
        ),
        (NormalizedEventKind::TaskSignal, None, None),
        (NormalizedEventKind::MessageGenerated, None, None),
        (
            NormalizedEventKind::Text,
            Some("t6"),
            Some("more modern three"),
        ),
        (NormalizedEventKind::User, Some("t12"), Some("modern four")),
        (NormalizedEventKind::TaskSignal, None, None),
        (
            NormalizedEventKind::Text,
            Some("t12"),
            Some("reply modern four"),
        ),
        (NormalizedEventKind::Status, None, None),
    ];
    for (kind, turn, text) in rows {
        store.append(&mut ev(kind, turn, text));
    }
    let seqs = |page: &vst_store::transcript::AroundPage| -> Vec<i64> {
        page.events.iter().filter_map(|e| e.log_seq).collect()
    };

    // A two-turn window around the middle of `t6` holds `t6` whole and `t12`,
    // with every interleaved status/task row; the leading status row is its own
    // turn ahead of the first user prompt.
    let mid = store.page_around(8, 2, usize::MAX).unwrap();
    assert_eq!(seqs(&mid), (5..=14).collect::<Vec<_>>());
    assert_eq!(mid.turns_before, 2);
    let lead = store.page_around(0, 1, usize::MAX).unwrap();
    assert_eq!(seqs(&lead), vec![0]);
    assert_eq!(store.page_around(2, 1, usize::MAX).unwrap().turns_before, 0);

    // A byte cap that fits only the centre turn starts at the user prompt, not
    // at a status row inside the turn.
    let capped = store.page_around(9, 15, 1).unwrap();
    assert_eq!(seqs(&capped), (5..=10).collect::<Vec<_>>());
    assert_eq!(capped.turns_before, 2);

    // Numbering: `turnsBefore` + user turns shown = each hit's `turnIndex`, and
    // a full window shows all four user turns.
    let outcome = search_all(&mut store, "reply");
    assert_eq!(outcome.turn_count, 4);
    let indices: Vec<(i64, i64)> = outcome.hits.iter().map(|h| (h.seq, h.turn_index)).collect();
    assert_eq!(indices, vec![(2, 1), (4, 2), (7, 3), (13, 4)]);
    let full = store.page_around(7, 15, usize::MAX).unwrap();
    assert_eq!(seqs(&full), (0..=14).collect::<Vec<_>>());
    for n in [1, 2, 15] {
        for hit in &outcome.hits {
            let page = store.page_around(hit.seq, n, usize::MAX).unwrap();
            assert!(seqs(&page).contains(&hit.seq), "n={n} seq={}", hit.seq);
            let user_turns_shown = i64::try_from(
                page.events
                    .iter()
                    .filter(|e| e.kind == NormalizedEventKind::User)
                    .filter(|e| e.log_seq.unwrap() <= hit.seq)
                    .count(),
            )
            .unwrap();
            assert_eq!(
                page.turns_before + user_turns_shown,
                hit.turn_index,
                "n={n} seq={}",
                hit.seq
            );
        }
    }
}
