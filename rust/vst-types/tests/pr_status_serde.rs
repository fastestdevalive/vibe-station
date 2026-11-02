//! Serde contract for the PR-status wire type (poller-redesign Phase 1).
//!
//! `PrStatus` gained `staleSince` and `PrErrorKind` gained `unsupported`.
//! Persisted/wire data stays readable: an old payload without `staleSince`
//! must still parse, and `None` must not appear on the wire at all.

use serde_json::{json, Value};
use vst_types::domain::{PrErrorKind, PrState, PrStatus};

/// The canonical wire shape: `#[skip_serializing_none]` omits every `None`
/// field, so a fresh open PR is exactly these five keys.
fn canonical_json() -> Value {
    json!({
        "state": "open",
        "number": 7,
        "url": "https://github.com/acme/widgets/pull/7",
        "checkedAt": "2026-01-01T00:00:00.000Z",
        "prBranch": "feature-x"
    })
}

#[test]
fn old_json_without_stale_since_still_parses() {
    // An older payload that spelled out every absent field as `null` (and had
    // no `staleSince` key at all) must keep parsing.
    let mut old = canonical_json();
    old["error"] = Value::Null;
    old["errorKind"] = Value::Null;
    let pr: PrStatus = serde_json::from_value(old).unwrap();
    assert_eq!(pr.state, PrState::Open);
    assert_eq!(pr.number, Some(7));
    assert_eq!(pr.pr_branch.as_deref(), Some("feature-x"));
    assert!(pr.stale_since.is_none());
}

#[test]
fn absent_stale_since_is_omitted_on_serialize() {
    let pr: PrStatus = serde_json::from_value(canonical_json()).unwrap();
    let out = serde_json::to_value(&pr).unwrap();
    assert_eq!(out, canonical_json());
    assert!(out.get("staleSince").is_none());
    assert!(out.get("error").is_none());
    assert!(out.get("errorKind").is_none());
}

#[test]
fn stale_since_round_trips_as_camel_case() {
    let mut value = canonical_json();
    value["staleSince"] = json!("2026-01-01T00:05:00.000Z");
    let pr: PrStatus = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(pr.stale_since.as_deref(), Some("2026-01-01T00:05:00.000Z"));
    assert_eq!(serde_json::to_value(&pr).unwrap(), value);
}

#[test]
fn unsupported_error_kind_round_trips() {
    let mut value = json!({
        "state": "none",
        "checkedAt": "2026-01-01T00:00:00.000Z"
    });
    value["errorKind"] = json!("unsupported");
    let pr: PrStatus = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(pr.state, PrState::None);
    assert_eq!(pr.error_kind, Some(PrErrorKind::Unsupported));
    assert_eq!(serde_json::to_value(&pr).unwrap(), value);
}

#[test]
fn every_error_kind_uses_the_documented_snake_case_name() {
    let cases = [
        (PrErrorKind::NoCredentials, "no_credentials"),
        (PrErrorKind::Auth, "auth"),
        (PrErrorKind::NotFound, "not_found"),
        (PrErrorKind::Transient, "transient"),
        (PrErrorKind::Unsupported, "unsupported"),
    ];
    for (kind, wire) in cases {
        assert_eq!(serde_json::to_value(kind).unwrap(), json!(wire));
        assert_eq!(
            serde_json::from_value::<PrErrorKind>(json!(wire)).unwrap(),
            kind
        );
    }
}
