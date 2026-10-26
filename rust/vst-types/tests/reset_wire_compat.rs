//! Wire compatibility (Phase 1, 1.T8): old bodies/rows still parse after the
//! carry-mode fields were added.

use vst_types::rest::sessions::{ResetBody, ResetResult};
use vst_types::{CarryOver, Command, NormalizedEvent, SessionBreakKind};

#[test]
fn old_reset_body_without_carry_fields_parses() {
    let body: ResetBody = serde_json::from_value(serde_json::json!({
        "handoff": true,
        "prompt": "go",
        "modeId": "m1",
        "channel": "json"
    }))
    .unwrap();
    assert_eq!(body.handoff, Some(true));
    assert_eq!(body.prompt.as_deref(), Some("go"));
    assert_eq!(body.mode_id.as_deref(), Some("m1"));
    assert_eq!(body.carry_over, None);
    assert_eq!(body.when_busy, None);
    assert_eq!(body.queued, None);
}

#[test]
fn new_reset_body_fields_round_trip() {
    let body: ResetBody = serde_json::from_value(serde_json::json!({
        "carryOver": "transcript",
        "whenBusy": "wait",
        "queued": "drop"
    }))
    .unwrap();
    assert_eq!(body.carry_over, Some(CarryOver::Transcript));
    assert_eq!(
        serde_json::to_value(&body).unwrap()["carryOver"],
        serde_json::json!("transcript")
    );
}

#[test]
fn old_reset_result_without_new_fields_parses_with_default_carry() {
    let result: ResetResult = serde_json::from_value(serde_json::json!({
        "ok": true,
        "archivedSessionId": "a",
        "newSessionId": "b"
    }))
    .unwrap();
    assert_eq!(result.carry_over, CarryOver::Nothing);
    assert_eq!(result.break_kind, None);
}

#[test]
fn old_session_break_row_without_new_fields_parses() {
    let ev: NormalizedEvent = serde_json::from_value(serde_json::json!({
        "id": "break-b",
        "sessionId": "b",
        "ts": "2026-01-01T00:00:00Z",
        "provider": "claude",
        "kind": "session_break",
        "turnId": "break-b",
        "breakKind": "switch",
        "fromProvider": "claude",
        "toProvider": "cursor"
    }))
    .unwrap();
    assert_eq!(ev.break_kind, Some(SessionBreakKind::Switch));
    assert_eq!(ev.carry_over, None);
    assert_eq!(ev.from_mode, None);
    assert_eq!(ev.to_mode, None);
}

#[test]
fn command_without_group_parses() {
    let cmd: Command = serde_json::from_value(serde_json::json!({
        "name": "review",
        "description": "Review the diff"
    }))
    .unwrap();
    assert_eq!(cmd.name, "review");
    assert_eq!(cmd.group, None);
}

#[test]
fn command_group_round_trips() {
    let cmd: Command = serde_json::from_value(serde_json::json!({
        "name": "review",
        "description": "Review the diff",
        "group": "skill"
    }))
    .unwrap();
    assert_eq!(
        serde_json::to_value(&cmd).unwrap()["group"],
        serde_json::json!("skill")
    );
}
