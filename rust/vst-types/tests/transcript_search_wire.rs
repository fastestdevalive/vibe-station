use vst_types::rest::sessions::{
    SnippetSegment, TranscriptAroundPage, TranscriptSearchMatch, TranscriptSearchPage,
};
use vst_types::rest::settings::FileScrollMap;

#[test]
fn transcript_search_wire_serialization() {
    let page = TranscriptSearchPage {
        query: "refresh".to_string(),
        total: 1,
        total_capped: false,
        matches: vec![TranscriptSearchMatch {
            seq: 42,
            turn_id: None,
            turn_index: 1,
            kind: "text".to_string(),
            occurrence: 0,
            ts: None,
            snippet: None,
        }],
        next_cursor: None,
        indexed_through_seq: None,
        backfilling: false,
        turn_count: 1,
    };

    let json = serde_json::to_string(&page).unwrap();
    let val: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert!(val.get("nextCursor").is_none());
    assert!(val.get("indexedThroughSeq").is_none());
    let match_obj = &val["matches"][0];
    assert!(match_obj.get("snippet").is_none());
    assert!(match_obj.get("turnId").is_none());
    assert!(match_obj.get("ts").is_none());

    // FileScrollMap::Minimap serializes as "minimap"
    let map_json = serde_json::to_string(&FileScrollMap::Minimap).unwrap();
    assert_eq!(map_json, "\"minimap\"");

    let marks_json = serde_json::to_string(&FileScrollMap::Marks).unwrap();
    assert_eq!(marks_json, "\"marks\"");

    // Test snippet serialization with hit
    let segment = SnippetSegment {
        text: "hello".to_string(),
        hit: Some(true),
    };
    let seg_json = serde_json::to_string(&segment).unwrap();
    assert!(seg_json.contains("\"hit\":true"), "{seg_json}");

    let segment_no_hit = SnippetSegment {
        text: "world".to_string(),
        hit: None,
    };
    let seg_no_hit_json = serde_json::to_string(&segment_no_hit).unwrap();
    assert!(!seg_no_hit_json.contains("hit"), "{seg_no_hit_json}");

    // Test around page serialization
    let around = TranscriptAroundPage {
        events: vec![],
        oldest_seq: Some(10),
        has_more: true,
        turns_before: 5,
    };
    let around_json = serde_json::to_string(&around).unwrap();
    assert!(around_json.contains("\"turnsBefore\":5"), "{around_json}");
    assert!(around_json.contains("\"hasMore\":true"), "{around_json}");
}
