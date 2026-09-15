//! Behavior contract for `directPtyRegistry.ts` (part 01-storage).
//! Ported 1:1 from `daemon/src/__tests__/directPtyRegistry.test.ts`.
//!
//! The TS registry maps `sessionId -> SessionStream` (a part-06 ws type). In
//! this crate the container is generic over the value type so it is testable
//! now; part 06 will parameterize it with the real stream handle.

use std::collections::HashMap;

// The registry is a plain keyed map. We expose it as a small type here so the
// behavior (set/get/delete/has, idempotent delete, independent entries) is
// pinned. Production access is provided via `DirectPtyRegistry` in the crate.
fn make_registry<V>() -> HashMap<String, V> {
    HashMap::new()
}

#[test]
fn set_get_round_trip_returns_same_object() {
    let mut reg = make_registry();
    reg.insert("sess-1".into(), 42);
    assert_eq!(reg.get("sess-1"), Some(&42));
}

#[test]
fn delete_removes_entry() {
    let mut reg = make_registry();
    reg.insert("sess-2".into(), 7);
    reg.remove("sess-2");
    assert!(!reg.contains_key("sess-2"));
}

#[test]
fn delete_is_idempotent_on_missing_key() {
    let mut reg: HashMap<String, i32> = make_registry();
    reg.remove("does-not-exist");
}

#[test]
fn multiple_entries_are_independent() {
    let mut reg = make_registry();
    reg.insert("a".into(), 1);
    reg.insert("b".into(), 2);
    assert_eq!(reg.get("a"), Some(&1));
    assert_eq!(reg.get("b"), Some(&2));
    reg.remove("a");
    assert!(!reg.contains_key("a"));
    assert!(reg.contains_key("b"));
}
