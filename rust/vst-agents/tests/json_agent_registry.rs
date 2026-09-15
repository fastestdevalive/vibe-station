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
