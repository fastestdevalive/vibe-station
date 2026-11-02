//! Wire shape of the daemon-computed diffstat types (`vst-diffstat`).
//!
//! Mirrored by `web-ui/src/api/types.ts` in the same phase (AGENTS.md: a
//! `vst-types` REST/WS change updates the web-ui mirror in the same commit).

use serde_json::json;
use vst_types::events::ServerEvent;
use vst_types::rest::worktrees::{DiffStatEntry, DiffStatState, DiffStatsSnapshot};
use vst_types::ws::ServerMessage;

fn entry(state: DiffStatState, hint: Option<&str>) -> DiffStatEntry {
    DiffStatEntry {
        insertions: 12,
        deletions: 3,
        state,
        rev: 1_700_000_000_123,
        hint: hint.map(str::to_string),
    }
}

#[test]
fn every_diffstat_state_serialises_snake_case() {
    for (state, wire) in [
        (DiffStatState::Ok, "ok"),
        (DiffStatState::Unknown, "unknown"),
        (DiffStatState::Unavailable, "unavailable"),
        (DiffStatState::Broken, "broken"),
    ] {
        assert_eq!(serde_json::to_value(state).unwrap(), json!(wire));
        let back: DiffStatState = serde_json::from_value(json!(wire)).unwrap();
        assert_eq!(back, state);
    }
}

#[test]
fn diffstat_entry_is_camel_case_and_omits_a_missing_hint() {
    let value = serde_json::to_value(entry(DiffStatState::Ok, None)).unwrap();
    assert_eq!(
        value,
        json!({
            "insertions": 12,
            "deletions": 3,
            "state": "ok",
            "rev": 1_700_000_000_123_u64
        })
    );
    let back: DiffStatEntry = serde_json::from_value(value).unwrap();
    assert_eq!(back, entry(DiffStatState::Ok, None));

    let broken =
        serde_json::to_value(entry(DiffStatState::Broken, Some("git worktree repair"))).unwrap();
    assert_eq!(broken["state"], "broken");
    assert_eq!(broken["hint"], "git worktree repair");
}

#[test]
fn snapshot_is_a_camel_case_map_keyed_by_worktree_id() {
    let snapshot = DiffStatsSnapshot {
        stats: [("wt-1".to_string(), entry(DiffStatState::Unavailable, None))]
            .into_iter()
            .collect(),
    };
    let value = serde_json::to_value(&snapshot).unwrap();
    assert_eq!(
        value,
        json!({
            "stats": {
                "wt-1": {
                    "insertions": 12,
                    "deletions": 3,
                    "state": "unavailable",
                    "rev": 1_700_000_000_123_u64
                }
            }
        })
    );
    let back: DiffStatsSnapshot = serde_json::from_value(value).unwrap();
    assert_eq!(back, snapshot);
}

#[test]
fn empty_snapshot_is_an_empty_object() {
    let value = serde_json::to_value(DiffStatsSnapshot::default()).unwrap();
    assert_eq!(value, json!({ "stats": {} }));
}

#[test]
fn worktree_diffstat_event_tag_and_fields() {
    let event = ServerEvent::WorktreeDiffStat {
        worktree_id: "wt-1".into(),
        insertions: 12,
        deletions: 3,
        state: DiffStatState::Broken,
        rev: 9,
        hint: Some("git worktree repair".into()),
    };
    let value = serde_json::to_value(&event).unwrap();
    assert_eq!(
        value,
        json!({
            "type": "worktree:diffstat",
            "worktreeId": "wt-1",
            "insertions": 12,
            "deletions": 3,
            "state": "broken",
            "rev": 9,
            "hint": "git worktree repair"
        })
    );
    let back: ServerEvent = serde_json::from_value(value).unwrap();
    assert_eq!(back, event);
}

#[test]
fn worktree_diffstat_message_tag_and_fields() {
    let message = ServerMessage::WorktreeDiffStat {
        worktree_id: "wt-1".into(),
        insertions: 0,
        deletions: 0,
        state: DiffStatState::Unknown,
        rev: 1,
        hint: None,
    };
    let value = serde_json::to_value(&message).unwrap();
    assert_eq!(
        value,
        json!({
            "type": "worktree:diffstat",
            "worktreeId": "wt-1",
            "insertions": 0,
            "deletions": 0,
            "state": "unknown",
            "rev": 1
        }),
        "hint must be omitted when absent"
    );
    let back: ServerMessage = serde_json::from_value(value).unwrap();
    assert_eq!(back, message);
}
