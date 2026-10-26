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

use vst_types::limits::LimitsSnapshot;
use vst_types::rest::modes::SupportedCli;
use vst_types::rest::sessions::{EnqueueChatResult, ScheduleSnapshotDto};
use vst_types::rest::shared::{GlobalDraft, Mode, Project, Session, Worktree};
use vst_types::rest::update::UpdateStatus;
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
fn session_created_snapshot_from_session_preserves_parent_session_id() {
    let value = load_fixture("session.json");
    let mut session: Session = serde_json::from_value(value).unwrap();
    session.parent_session_id = Some("parent-sess-123".to_string());

    let snapshot: SessionCreatedSnapshot = (&session).into();
    let json = serde_json::to_value(&snapshot).unwrap();
    assert_eq!(
        json.get("parentSessionId").and_then(Value::as_str),
        Some("parent-sess-123"),
        "parentSessionId must survive the Session -> SessionCreatedSnapshot conversion, \
         or live clients will store parentSessionId: undefined and fail to render subagents in SubagentRow"
    );
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
        mode_id: None,
        mode_icon: None,
    };
    let value = serde_json::to_value(&msg).unwrap();
    let obj = value.as_object().unwrap();
    assert_eq!(obj.get("type").unwrap(), "session:updated");
    // unchanged optional fields must not appear
    assert!(!obj.contains_key("pinnedAt"));
    assert!(!obj.contains_key("channel"));
    assert!(!obj.contains_key("pr"));
    assert!(!obj.contains_key("modeId"));
    assert!(!obj.contains_key("modeIcon"));
    // changed fields appear
    assert_eq!(obj.get("name").unwrap(), "renamed");
    assert_eq!(obj.get("sortOrder").unwrap(), 2.0);
    assert!(!obj.contains_key("parentSessionId"));
}

#[test]
fn session_updated_pinned_at_is_tri_state() {
    let mk = |pinned_at: Option<Option<String>>| ServerMessage::SessionUpdated {
        session_id: "s".into(),
        pinned_at,
        channel: None,
        name: None,
        archived_at: None,
        sort_order: None,
        pr: None,
        superseded_by: None,
        is_main: None,
        parent_session_id: None,
        worktree_id: None,
        draft_prompt: None,
        draft_config: None,
        mode_id: None,
        mode_icon: None,
    };
    let v = serde_json::to_value(mk(Some(None))).unwrap();
    assert_eq!(v.get("pinnedAt"), Some(&serde_json::Value::Null));
    let v = serde_json::to_value(mk(None)).unwrap();
    assert!(!v.as_object().unwrap().contains_key("pinnedAt"));
    let v = serde_json::to_value(mk(Some(Some("t".into())))).unwrap();
    assert_eq!(v.get("pinnedAt").unwrap(), "t");
}

#[test]
fn session_updated_mode_icon_is_tri_state() {
    let mk = |mode_icon: Option<Option<String>>| ServerMessage::SessionUpdated {
        session_id: "s".into(),
        pinned_at: None,
        channel: None,
        name: None,
        archived_at: None,
        sort_order: None,
        pr: None,
        superseded_by: None,
        is_main: None,
        parent_session_id: None,
        worktree_id: None,
        draft_prompt: None,
        draft_config: None,
        mode_id: None,
        mode_icon,
    };
    let v = serde_json::to_value(mk(Some(None))).unwrap();
    assert_eq!(v.get("modeIcon"), Some(&serde_json::Value::Null));
    let v = serde_json::to_value(mk(None)).unwrap();
    assert!(!v.as_object().unwrap().contains_key("modeIcon"));
    let v = serde_json::to_value(mk(Some(Some("star".into())))).unwrap();
    assert_eq!(v.get("modeIcon").unwrap(), "star");
}

#[test]
fn session_updated_mode_id_serialized() {
    let msg = ServerMessage::SessionUpdated {
        session_id: "s".into(),
        pinned_at: None,
        channel: None,
        name: None,
        archived_at: None,
        sort_order: None,
        pr: None,
        superseded_by: None,
        is_main: None,
        parent_session_id: None,
        worktree_id: None,
        draft_prompt: None,
        draft_config: None,
        mode_id: Some("mode-123".into()),
        mode_icon: None,
    };
    let v = serde_json::to_value(&msg).unwrap();
    assert_eq!(v.get("modeId").unwrap(), "mode-123");
}

#[test]
fn patch_channel_body_serde_roundtrips() {
    use vst_types::rest::sessions::PatchChannelBody;
    use vst_types::Channel;

    // Deserializing without modeId defaults to None
    let json_without = serde_json::json!({ "channel": "json" });
    let parsed: PatchChannelBody = serde_json::from_value(json_without).unwrap();
    assert_eq!(parsed.channel, Channel::Json);
    assert_eq!(parsed.mode_id, None);

    // Serializing with None omits modeId
    let serialized = serde_json::to_value(&parsed).unwrap();
    assert!(!serialized.as_object().unwrap().contains_key("modeId"));

    // Deserializing with modeId parses correctly
    let json_with = serde_json::json!({ "channel": "json", "modeId": "new-mode" });
    let parsed_with: PatchChannelBody = serde_json::from_value(json_with.clone()).unwrap();
    assert_eq!(parsed_with.mode_id, Some("new-mode".into()));
    assert_eq!(serde_json::to_value(&parsed_with).unwrap(), json_with);
}

#[test]
fn session_updated_delink_serializes_parent_session_id_null() {
    let msg = ServerMessage::SessionUpdated {
        session_id: "s-child".into(),
        pinned_at: None,
        channel: None,
        name: None,
        archived_at: None,
        sort_order: None,
        pr: None,
        superseded_by: None,
        is_main: None,
        parent_session_id: Some(None),
        worktree_id: None,
        draft_prompt: None,
        draft_config: None,
        mode_id: None,
        mode_icon: None,
    };
    let value = serde_json::to_value(&msg).unwrap();
    let obj = value.as_object().unwrap();
    assert_eq!(obj.get("type").unwrap(), "session:updated");
    assert_eq!(
        obj.get("parentSessionId").unwrap(),
        &serde_json::Value::Null
    );
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

#[test]
fn limits_snapshot_fixture_roundtrips() {
    assert_roundtrip::<LimitsSnapshot>("limits-snapshot.json");
}

#[test]
fn session_activity_event_wire_shape() {
    let ev = vst_types::ServerEvent::SessionActivity {
        session_id: "s1".into(),
        last_activity_at: "2026-10-21T10:00:00.000Z".into(),
        last_line: None,
        last_tool: None,
    };
    assert_eq!(
        serde_json::to_value(&ev).unwrap(),
        serde_json::json!({
            "type": "session:activity",
            "sessionId": "s1",
            "lastActivityAt": "2026-10-21T10:00:00.000Z"
        })
    );
    let msg = ServerMessage::SessionActivity {
        session_id: "s1".into(),
        last_activity_at: "2026-10-21T10:00:00.000Z".into(),
        last_line: None,
        last_tool: Some(vst_types::activity::ToolActivity {
            name: "Edit".into(),
            detail: Some("a.ts".into()),
        }),
    };
    assert!(serde_json::to_value(&msg)
        .unwrap()
        .get("lastLine")
        .is_none());
    assert_eq!(
        serde_json::to_value(&msg).unwrap()["lastTool"],
        serde_json::json!({"name": "Edit", "detail": "a.ts"})
    );
}

#[test]
fn session_without_activity_keys_still_deserializes() {
    let mut fixture = load_fixture("session.json");
    let obj = fixture.as_object_mut().unwrap();
    obj.remove("lastActivityAt");
    obj.remove("lastLine");
    obj.remove("lastTool");
    let s: Session = serde_json::from_value(fixture).unwrap();
    assert_eq!(s.last_activity_at, None);
    assert_eq!(s.last_line, None);
    assert_eq!(s.last_tool, None);
}

/// The whole-file-trim starts are optional with a serde default: a diff that
/// was never trimmed must serialize WITHOUT `oldStart`/`newStart`, so existing
/// persisted rows and the hand-mirrored `web-ui/src/api/types.ts` (where an
/// absent start means line 1) stay byte-compatible.
#[test]
fn tool_diff_omits_absent_trim_starts() {
    use vst_types::ToolDiff;

    let untrimmed = ToolDiff {
        path: "/a.ts".into(),
        old_text: Some("a\n".into()),
        new_text: "b\n".into(),
        old_start: None,
        new_start: None,
    };
    let v = serde_json::to_value(&untrimmed).unwrap();
    assert!(
        v.get("oldStart").is_none(),
        "absent oldStart must be omitted: {v}"
    );
    assert!(
        v.get("newStart").is_none(),
        "absent newStart must be omitted: {v}"
    );

    let trimmed = ToolDiff {
        old_start: Some(17),
        new_start: Some(17),
        ..untrimmed
    };
    let v = serde_json::to_value(&trimmed).unwrap();
    assert_eq!(v["oldStart"], 17);
    assert_eq!(v["newStart"], 17);

    // A pre-change payload (no keys at all) still deserializes.
    let back: ToolDiff = serde_json::from_value(serde_json::json!({
        "path": "/a.ts", "oldText": "a\n", "newText": "b\n"
    }))
    .unwrap();
    assert_eq!((back.old_start, back.new_start), (None, None));
}

#[test]
fn session_scheduled_with_scheduled_sent_roundtrips() {
    assert_roundtrip::<ServerMessage>("server-message-session-scheduled.json");
}

#[test]
fn session_scheduled_without_scheduled_sent_roundtrips_and_stays_absent() {
    // Absent = "keep what you have": it must deserialize to None and NOT be
    // re-emitted as `[]`/null (which a client would read as "cleared").
    assert_roundtrip::<ServerMessage>("server-message-session-scheduled-no-sent.json");
    let msg: ServerMessage = serde_json::from_value(load_fixture(
        "server-message-session-scheduled-no-sent.json",
    ))
    .unwrap();
    match msg {
        ServerMessage::SessionScheduled { scheduled_sent, .. } => assert!(scheduled_sent.is_none()),
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn session_scheduled_empty_scheduled_sent_is_preserved_as_clear() {
    let mut v = load_fixture("server-message-session-scheduled-no-sent.json");
    v["scheduledSent"] = serde_json::json!([]);
    let msg: ServerMessage = serde_json::from_value(v.clone()).unwrap();
    assert_eq!(serde_json::to_value(&msg).unwrap(), v);
}

#[test]
fn schedule_snapshot_dto_roundtrips() {
    assert_roundtrip::<ScheduleSnapshotDto>("schedule-snapshot.json");
}

#[test]
fn supported_cli_without_supports_terminal_delivery_defaults_to_false() {
    let json = serde_json::json!({
        "id": "claude",
        "defaultModel": "",
        "supportsJson": true,
        "importsNativeHistory": true,
        "supportsJsonToTerminalResume": true,
        "detected": true,
        "starterBundleNames": [],
        "usingFallbackOnly": false,
        "defaultChannel": "json",
        "defaultChannelOverridden": false
    });
    let cli: SupportedCli = serde_json::from_value(json).unwrap();
    assert!(!cli.supports_terminal_delivery);
    let out = serde_json::to_value(&cli).unwrap();
    assert_eq!(out["supportsTerminalDelivery"], serde_json::json!(false));
}

// ── artifacts (plan 03, Phase 1) ─────────────────────────────────────────

#[test]
fn artifact_row_fixture_roundtrips() {
    assert_roundtrip::<vst_types::artifacts::ArtifactRow>("artifact-row.json");
}

#[test]
fn artifact_events_and_resync_roundtrip() {
    assert_roundtrip::<ServerMessage>("server-message-artifact-upserted.json");
    assert_roundtrip::<ServerMessage>("server-message-artifact-removed.json");
    assert_roundtrip::<ServerMessage>("server-message-ws-resync.json");
}

#[test]
fn artifact_rest_bodies_roundtrip() {
    use vst_types::rest::artifacts::{
        AddArtifactsRequest, AddArtifactsResponse, ArtifactContentError, ArtifactListResponse,
    };
    assert_roundtrip::<ArtifactListResponse>("artifact-list-response.json");
    assert_roundtrip::<AddArtifactsRequest>("artifact-add-request.json");
    assert_roundtrip::<AddArtifactsResponse>("artifact-add-response.json");
    assert_roundtrip::<ArtifactContentError>("artifact-content-error.json");
}

#[test]
fn artifact_events_map_one_to_one_to_server_messages_shape() {
    // The internal ServerEvent and the wire ServerMessage serialize identically.
    use vst_types::events::ServerEvent;
    let v = load_fixture("server-message-artifact-removed.json");
    let ev: ServerEvent = serde_json::from_value(v.clone()).unwrap();
    assert_eq!(serde_json::to_value(ev).unwrap(), v);
    let v = load_fixture("server-message-artifact-upserted.json");
    let ev: ServerEvent = serde_json::from_value(v.clone()).unwrap();
    assert_eq!(serde_json::to_value(ev).unwrap(), v);
}

#[test]
fn artifact_wire_ignores_unknown_fields_and_defaults_optionals() {
    use vst_types::artifacts::{ArtifactRow, ArtifactState};
    let mut v = load_fixture("artifact-row.json");
    let obj = v.as_object_mut().unwrap();
    obj.insert("futureField".into(), serde_json::json!({"x": 1}));
    obj.remove("size");
    let row: ArtifactRow = serde_json::from_value(v).unwrap();
    assert_eq!(row.size, None);
    assert_eq!(row.state, ArtifactState::Ok);

    // Optional per-path fields default when absent.
    let r: vst_types::rest::artifacts::AddArtifactResult =
        serde_json::from_value(serde_json::json!({"path": "/a", "extra": 1})).unwrap();
    assert!(r.artifact.is_none() && r.outside_worktree.is_none() && r.error.is_none());
}

// ── review comments (plan 04, Phase 1a) ──────────────────────────────────

#[test]
fn review_comment_fixtures_roundtrip() {
    use vst_types::rest::review::{CommentListResponse, CreateCommentBody};
    use vst_types::review::{ReviewComment, ReviewRecord, ScheduledReviewPayload};
    assert_roundtrip::<ReviewComment>("review-comment.json");
    assert_roundtrip::<ReviewRecord>("review-record.json");
    assert_roundtrip::<ScheduledReviewPayload>("scheduled-review-payload.json");
    assert_roundtrip::<CommentListResponse>("comment-list-response.json");
    assert_roundtrip::<CreateCommentBody>("create-comment-body.json");
}

#[test]
fn comment_events_roundtrip() {
    assert_roundtrip::<ServerMessage>("server-message-comments-changed.json");
    assert_roundtrip::<ServerMessage>("server-message-terminal-delivery-updated.json");
}

/// 1.T11: the payload shape meets plan 02's `snapshot_meta` count rule.
#[test]
fn scheduled_review_payload_fixture_counts_two_comments() {
    let text = std::fs::read_to_string(format!(
        "{}/tests/fixtures/wire/scheduled-review-payload.json",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    assert_eq!(
        vst_types::review::snapshot_meta(&text).map(|m| m.count),
        Some(2)
    );
}

/// 1.T11: payloads written before the review fields existed still parse, and the
/// new optional fields stay out of the output.
#[test]
fn old_payloads_default_the_new_review_fields() {
    use vst_types::rest::sessions::{ChatBody, ResubmitBody, StartDraftBody};
    let chat: ChatBody = serde_json::from_str(r#"{"message":"hi"}"#).unwrap();
    assert_eq!(chat.review_comment_ids, None);
    assert_eq!(
        serde_json::to_value(&chat).unwrap(),
        serde_json::json!({ "message": "hi" })
    );
    let resubmit: ResubmitBody = serde_json::from_str(r#"{"edited":false}"#).unwrap();
    assert_eq!(resubmit.keep_review, None);
    let start: StartDraftBody =
        serde_json::from_str(r#"{"draftPrompt":"p","draftConfig":{"entryPoint":"tab"}}"#).unwrap();
    assert_eq!(start.review_comment_ids, None);
    let cli: SupportedCli = serde_json::from_value(serde_json::json!({
        "id": "claude", "defaultModel": "m", "supportsJson": true,
        "importsNativeHistory": false, "supportsJsonToTerminalResume": false,
        "detected": true, "starterBundleNames": [], "usingFallbackOnly": false,
        "defaultChannel": "json", "defaultChannelOverridden": false
    }))
    .unwrap();
    assert!(!cli.supports_terminal_comments);
}

#[test]
fn update_status_roundtrips() {
    assert_roundtrip::<UpdateStatus>("update-status.json");
}

#[test]
fn server_message_update_changed_roundtrips() {
    let fixture = load_fixture("server-message-update-changed.json");
    let msg: ServerMessage = serde_json::from_value(fixture.clone()).unwrap();
    assert!(matches!(msg, ServerMessage::UpdateChanged { .. }));
    let reserialized = serde_json::to_value(&msg).unwrap();
    assert_eq!(reserialized, fixture);
}
