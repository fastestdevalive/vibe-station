//! Wire-drift detector integration tests.
//!
//! Each fixture in `tests/fixtures/wire/*.json` is a captured sample of the
//! Node daemon's wire shape (or, where a live daemon was unavailable at author
//! time, a direct extraction from the TypeScript zod schemas / handler
//! response literals). For every fixture the test asserts
//! `deserialize(fixture) -> T -> serialize == fixture` as a `serde_json::Value`
//! — the port's byte-identical-JSON contract (arch doc F1, wire-compat
//! detector). If a `vst-types` change breaks a shape, this test fails.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use vst_types::rest::sessions::EnqueueChatResult;
use vst_types::rest::shared::{GlobalDraft, Mode, Project, Session, Worktree};
use vst_types::ws::{ClientMessage, ServerMessage, SessionCreatedSnapshot};

fn load_fixture(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/wire/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read fixture {name}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("fixture {name} is not valid JSON: {e}"))
}

/// Round-trip a wire fixture: deserialize to `T`, re-serialize, and assert the
/// re-serialized JSON equals the original fixture (as `Value`).
fn assert_roundtrip<T>(name: &str)
where
    T: for<'de> Deserialize<'de> + Serialize,
{
    let fixture = load_fixture(name);
    let deserialized: T = serde_json::from_value(fixture.clone())
        .unwrap_or_else(|e| panic!("deserialize {name}: {e}"));
    let reserialized =
        serde_json::to_value(&deserialized).unwrap_or_else(|e| panic!("reserialize {name}: {e}"));
    assert_eq!(reserialized, fixture, "wire drift in {name}");
}

#[test]
fn session_fixture_roundtrips() {
    assert_roundtrip::<Session>("session.json");
}

#[test]
fn global_draft_fixture_roundtrips() {
    assert_roundtrip::<GlobalDraft>("global-draft.json");
}

/// Regression test for a live-reproduced bug: `SessionCreatedSnapshot` used
/// to omit `sortOrder` (and several other fields) entirely, even though the
/// client's type for `session:created`'s `snapshot` field is the FULL
/// `Session` type (`web-ui/src/api/types.ts`'s `snapshot?: Session`) and TS's
/// real wire object is `serializeSession(...)`'s complete output — TS's
/// narrower `protocol.ts` zod schema was never actually enforced on the send
/// path, so it silently passed extra fields through, while Rust's
/// struct-based serialization cannot emit a field the struct doesn't
/// declare. `TabsStrip.tsx` sorts its local tab list by
/// `a.sortOrder ?? 0`, so a missing `sortOrder` defaulted new tabs to `0`,
/// sorting them before every real session and landing them at the far LEFT
/// of the tab strip instead of the right (next to the "+" button that
/// created them).
#[test]
fn session_created_snapshot_from_session_preserves_sort_order() {
    let value = load_fixture("session.json");
    let session: Session = serde_json::from_value(value).unwrap();
    assert_eq!(session.sort_order, 1.0, "fixture sanity check");

    let snapshot: SessionCreatedSnapshot = (&session).into();
    let json = serde_json::to_value(&snapshot).unwrap();
    assert_eq!(
        json.get("sortOrder").and_then(Value::as_f64),
        Some(1.0),
        "sortOrder must survive the Session -> SessionCreatedSnapshot conversion, \
         or a client sorting its local tab/session list by this field on a \
         session:created broadcast puts new items first instead of last"
    );
    // A few other fields from the same widening fix, spot-checked.
    assert_eq!(json.get("nameSource").and_then(Value::as_str), Some("auto"));
    assert!(json.get("pr").is_some_and(|v| !v.is_null()));
}

#[test]
fn worktree_fixture_roundtrips() {
    assert_roundtrip::<Worktree>("worktree.json");
}

#[test]
fn project_fixture_roundtrips() {
    assert_roundtrip::<Project>("project.json");
}

#[test]
fn mode_fixture_roundtrips() {
    assert_roundtrip::<Mode>("mode.json");
}

#[test]
fn server_message_session_created_roundtrips() {
    assert_roundtrip::<ServerMessage>("server-message-session-created.json");
}

#[test]
fn server_message_session_updated_roundtrips() {
    assert_roundtrip::<ServerMessage>("server-message-session-updated.json");
}

#[test]
fn server_message_session_state_roundtrips() {
    assert_roundtrip::<ServerMessage>("server-message-session-state.json");
}

#[test]
fn server_message_chat_replay_roundtrips() {
    assert_roundtrip::<ServerMessage>("server-message-chat-replay.json");
}

#[test]
fn client_message_session_open_roundtrips() {
    assert_roundtrip::<ClientMessage>("client-message-session-open.json");
}

/// `session:updated` omits unchanged optional fields (carries only what
/// changed) — an absent optional key must serialize back to an absent key.
#[test]
fn session_updated_omits_unchanged_optionals() {
    let msg = ServerMessage::SessionUpdated {
        session_id: "vs-141-a-5853aa1a".into(),
        pinned_at: None,
        channel: None,
        name: Some("renamed".into()),
        archived_at: None,
        sort_order: Some(2.0),
        pr: None,
        superseded_by: None,
        is_main: None,
        parent_session_id: None,
        worktree_id: None,
        draft_prompt: None,
        draft_config: None,
    };
    let value = serde_json::to_value(&msg).unwrap();
    let obj = value.as_object().unwrap();
    assert_eq!(obj.get("type").unwrap(), "session:updated");
    // unchanged optional fields must not appear
    assert!(!obj.contains_key("pinnedAt"));
    assert!(!obj.contains_key("channel"));
    assert!(!obj.contains_key("pr"));
    // changed fields appear
    assert_eq!(obj.get("name").unwrap(), "renamed");
    assert_eq!(obj.get("sortOrder").unwrap(), 2.0);
}

/// Id newtypes serialize as the bare string, not `{"0": "..."}`.
#[test]
fn id_newtypes_serialize_as_bare_strings() {
    let value = serde_json::to_value(&vst_types::SessionId("vs-141".into())).unwrap();
    assert_eq!(value, serde_json::json!("vs-141"));
}

/// `EnqueueChatResult` — a session chat 202 response.
#[test]
fn enqueue_chat_result_roundtrips() {
    let v = serde_json::json!({ "turnId": "turn-1", "queuePosition": 0 });
    let deserialized: EnqueueChatResult = serde_json::from_value(v.clone()).unwrap();
    assert_eq!(serde_json::to_value(&deserialized).unwrap(), v);
}
