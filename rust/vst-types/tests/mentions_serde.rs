use serde_json::json;
use vst_types::domain::{Mention, MentionKind, NormalizedEvent, QueuedTurnMeta};
use vst_types::rest::sessions::{ChatBody, EditQueuedResult};

#[test]
fn chat_body_without_mentions_deserializes_with_none() {
    let json_val = json!({
        "message": "hello"
    });
    let body: ChatBody = serde_json::from_value(json_val).expect("deserialize ChatBody");
    assert_eq!(body.message, "hello");
    assert_eq!(body.mentions, None);
}

#[test]
fn chat_body_with_mentions_round_trips() {
    let mention = Mention {
        kind: MentionKind::File,
        id: "a/b.ts".to_string(),
        label: "b.ts".to_string(),
    };
    let body = ChatBody {
        message: "hello".to_string(),
        attachment_ids: None,
        queue: None,
        mentions: Some(vec![mention.clone()]),
    };
    let json_str = serde_json::to_string(&body).expect("serialize ChatBody");
    let back: ChatBody = serde_json::from_str(&json_str).expect("deserialize ChatBody");
    assert_eq!(back, body);

    let val = serde_json::to_value(&body).expect("to_value");
    assert_eq!(
        val,
        json!({
            "message": "hello",
            "mentions": [
                {
                    "kind": "file",
                    "id": "a/b.ts",
                    "label": "b.ts"
                }
            ]
        })
    );
}

#[test]
fn mention_kind_unknown_deserializes_as_unknown() {
    // Stored history written by a newer daemon must still load after rollback;
    // the send path rejects Unknown via `validate_mentions` (vst-agents).
    let json_val = json!({
        "message": "hello",
        "mentions": [
            { "kind": "artifact", "id": "art-1", "label": "Artifact" }
        ]
    });
    let body: ChatBody = serde_json::from_value(json_val).expect("unknown kind must deserialize");
    assert_eq!(body.mentions.unwrap()[0].kind, MentionKind::Unknown);
}

#[test]
fn normalized_event_and_queued_turn_meta_without_mentions_deserialize() {
    let ev_val = json!({
        "id": "ev-1",
        "sessionId": "s-1",
        "ts": "2026-01-01T00:00:00Z",
        "provider": "claude",
        "kind": "user"
    });
    let ev: NormalizedEvent = serde_json::from_value(ev_val).expect("deserialize NormalizedEvent");
    assert_eq!(ev.mentions, None);

    let meta_val = json!({
        "turnId": "t-1",
        "message": "hi"
    });
    let meta: QueuedTurnMeta =
        serde_json::from_value(meta_val).expect("deserialize QueuedTurnMeta");
    assert_eq!(meta.mentions, None);
}

#[test]
fn edit_queued_result_none_mentions_serializes_without_mentions_key() {
    let result = EditQueuedResult {
        turn_id: "t-1".to_string(),
        message: "hello".to_string(),
        attachments: vec![],
        queue_index: 0,
        mentions: None,
    };
    let val = serde_json::to_value(&result).expect("to_value EditQueuedResult");
    assert!(
        val.get("mentions").is_none(),
        "mentions key should be omitted when None"
    );
}
