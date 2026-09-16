//! Behavior contract for `vst_agents::json_agent_registry::JsonAgentRegistry`.
//!
//! Ports `daemon/src/state/jsonAgentRegistry.ts` — a `sessionId → JsonAgentSession`
//! `Map` used to hold the live JSON agent-chat sessions so routes can reach the
//! running session for a given id without re-deriving it. A JSON session is
//! registered lazily on its first turn and removed when the session/worktree is
//! deleted.
//!
//! The concrete value type (`JsonAgentSession`) is not yet ported (blocked on
//! `05-lifecycle-status`); the registry is generic over the value type so it can
//! be instantiated as `JsonAgentRegistry<JsonAgentSession>` when the core lands,
//! exactly matching the TS `Map<string, JsonAgentSession>`.
//!
//! Mirrors the `Map` semantics exercised by the TS suite (`jsonChatRoutes.test.ts`
//! and friends): `get` returns the stored value or `None`, `set` inserts,
//! `remove` deletes and returns the prior value, `clear` empties the map.

use std::sync::Arc;

use vst_agents::json_agent_registry::JsonAgentRegistry;

/// `set` then `get` returns the same value — the registry round-trips an id.
#[test]
fn set_then_get_round_trips() {
    let reg = JsonAgentRegistry::<String>::new();
    reg.set("sess-1".to_string(), Arc::new("agent-a".to_string()));
    let got = reg.get("sess-1");
    assert_eq!(
        got.as_deref().map(String::as_str),
        Some("agent-a"),
        "get returns the stored value for the same id"
    );
}

/// `get` for an id that was never registered returns `None`.
#[test]
fn get_unknown_id_returns_none() {
    let reg = JsonAgentRegistry::<String>::new();
    reg.set("sess-1".to_string(), Arc::new("agent-a".to_string()));
    assert!(reg.get("sess-2").is_none(), "unknown id is absent");
}

/// `set` on an already-present id replaces the stored value.
#[test]
fn set_overwrites_existing_value() {
    let reg = JsonAgentRegistry::<String>::new();
    reg.set("sess-1".to_string(), Arc::new("first".to_string()));
    reg.set("sess-1".to_string(), Arc::new("second".to_string()));
    assert_eq!(
        reg.get("sess-1").as_deref().map(String::as_str),
        Some("second"),
        "later set replaces the earlier value"
    );
}

/// `remove` deletes the entry and returns the prior value (Map.delete semantics
/// extended with the removed value, as used by the daemon teardown path).
#[test]
fn remove_deletes_and_returns_prior_value() {
    let reg = JsonAgentRegistry::<String>::new();
    reg.set("sess-1".to_string(), Arc::new("agent-a".to_string()));
    let removed = reg.remove("sess-1");
    assert_eq!(
        removed.as_deref().map(String::as_str),
        Some("agent-a"),
        "remove returns the value that was present"
    );
    assert!(reg.get("sess-1").is_none(), "entry is gone after remove");
}

/// `remove` on an absent id returns `None` and is a no-op.
#[test]
fn remove_absent_id_returns_none() {
    let reg = JsonAgentRegistry::<String>::new();
    assert!(reg.remove("sess-1").is_none());
}

/// `clear` empties the whole registry.
#[test]
fn clear_empties_registry() {
    let reg = JsonAgentRegistry::<String>::new();
    reg.set("sess-1".to_string(), Arc::new("a".to_string()));
    reg.set("sess-2".to_string(), Arc::new("b".to_string()));
    reg.clear();
    assert!(reg.get("sess-1").is_none());
    assert!(reg.get("sess-2").is_none());
}

/// `get_or_insert_with` on an empty slot constructs and registers exactly
/// once, returning the newly-created value.
#[test]
fn get_or_insert_with_constructs_on_empty_slot() {
    let reg = JsonAgentRegistry::<String>::new();
    let created = reg.get_or_insert_with("sess-1", || "constructed".to_string());
    assert_eq!(*created, "constructed");
    assert_eq!(
        reg.get("sess-1").as_deref().map(String::as_str),
        Some("constructed"),
        "the constructed value is registered"
    );
}

/// `get_or_insert_with` on an already-registered id returns the EXISTING
/// value and never calls the constructor closure — this is the exact
/// invariant that closes the lost-update race in
/// `get_or_create_json_agent_session`: two "concurrent" callers for the
/// same session id must resolve to the SAME instance, never each building
/// (and one of them silently discarding) their own.
#[test]
fn get_or_insert_with_does_not_reconstruct_existing_entry() {
    let reg = JsonAgentRegistry::<String>::new();
    reg.set("sess-1".to_string(), Arc::new("first".to_string()));
    let mut constructor_called = false;
    let got = reg.get_or_insert_with("sess-1", || {
        constructor_called = true;
        "second".to_string()
    });
    assert!(
        !constructor_called,
        "constructor must not run when an entry already exists"
    );
    assert_eq!(
        *got, "first",
        "the pre-existing value is returned, not a freshly constructed one"
    );
}

/// A simulated "race": two `get_or_insert_with` calls for the same id, back
/// to back with nothing in between, must produce the same `Arc` — i.e. the
/// second call is a no-op read of what the first one inserted, not an
/// independent construction that clobbers it. This is the single-threaded
/// analogue of the real bug: `resolve_json_agent`'s two `.await`s created a
/// window where two callers each ran `get()` (both `None`) before either
/// reached `set()`; `get_or_insert_with` collapses that entire
/// check-and-construct into one lock-held critical section so the window
/// cannot exist even across threads.
#[test]
fn get_or_insert_with_is_idempotent_across_repeated_calls() {
    let reg = JsonAgentRegistry::<String>::new();
    let first = reg.get_or_insert_with("sess-1", || "a".to_string());
    let second = reg.get_or_insert_with("sess-1", || "b".to_string());
    assert!(
        Arc::ptr_eq(&first, &second),
        "both calls must resolve to the exact same Arc instance"
    );
    assert_eq!(*second, "a", "the first constructor's value wins");
}
