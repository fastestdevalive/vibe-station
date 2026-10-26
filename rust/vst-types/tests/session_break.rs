//! `session_break` wire-shape tests — camelCase round-trip and backward
//! compatibility with rows written before the fields existed.

use vst_types::{NormalizedEvent, NormalizedEventKind, SessionBreakKind};

/// A `session_break` event serializes to camelCase fields, including the new
/// `breakKind`/`fromProvider`/`toProvider` Option fields.
#[test]
fn session_break_event_camelcase_roundtrip() {
    let ev = NormalizedEvent {
        id: "break-new1".into(),
        session_id: "new1".into(),
        ts: "2026-10-22T10:00:00.000Z".into(),
        provider: vst_types::NormalizedEventProvider::Opencode,
        kind: NormalizedEventKind::SessionBreak,
        role: None,
        text: Some("handing off".into()),
        turn_id: Some("break-new1".into()),
        break_kind: Some(SessionBreakKind::Switch),
        from_provider: Some("claude".into()),
        to_provider: Some("opencode".into()),
        ..Default::default()
    };
    let v = serde_json::to_value(&ev).unwrap();
    let obj = v.as_object().unwrap();
    assert_eq!(obj.get("kind").unwrap(), "session_break");
    assert_eq!(obj.get("breakKind").unwrap(), "switch");
    assert_eq!(obj.get("fromProvider").unwrap(), "claude");
    assert_eq!(obj.get("toProvider").unwrap(), "opencode");
    // Optional fields must be absent, not null (skip_serializing_none).
    assert!(!obj.contains_key("usage"));
    assert!(!obj.contains_key("model"));

    let back: NormalizedEvent = serde_json::from_value(v).unwrap();
    assert_eq!(back, ev);
}

/// A `SessionBreakKind::Reset` serializes to `reset`.
#[test]
fn session_break_kind_reset_serializes_as_reset() {
    assert_eq!(
        serde_json::to_value(SessionBreakKind::Reset).unwrap(),
        serde_json::json!("reset")
    );
    assert_eq!(
        serde_json::from_value::<SessionBreakKind>(serde_json::json!("reset")).unwrap(),
        SessionBreakKind::Reset
    );
}

/// A pre-existing row without the new `breakKind`/`fromProvider`/`toProvider`
/// fields still deserializes (they are `Option`/absent under
/// `skip_serializing_none`).
#[test]
fn old_row_without_break_fields_parses() {
    let old = serde_json::json!({
        "id": "e1",
        "sessionId": "s1",
        "ts": "2026-10-22T09:00:00.000Z",
        "provider": "claude",
        "kind": "user",
        "role": "user",
        "text": "hello",
        "turnId": "t1"
    });
    let ev: NormalizedEvent = serde_json::from_value(old).unwrap();
    assert_eq!(ev.kind, NormalizedEventKind::User);
    assert!(ev.break_kind.is_none());
    assert!(ev.from_provider.is_none());
    assert!(ev.to_provider.is_none());
}
