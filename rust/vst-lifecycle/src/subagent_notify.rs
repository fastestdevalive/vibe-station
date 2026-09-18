//! Subagent-to-parent notification coalescing — ports `services/subagentNotify.ts`.
//!
//! Invariants (behavior contract):
//! - `COALESCE_MS = 4_000`: notifications are batched; flush fires after 4s of quiet.
//! - `MAX_NOTICES_PER_PARENT = 25`: once a parent has received this many notices
//!   in one human turn, further flushes emit pills without consuming a slot.
//! - Only `LifecycleState::WaitingForHuman` is NOTABLE — all other state
//!   transitions (working, idle, done, exited) are silently dropped.
//! - `note_subagent_state_change`: prunes stale entries for the parent (R16)
//!   before the NOTABLE gate, then coalesces per (parent, child) pair.
//! - `note_human_turn(parent_id)`: resets the budget counter for that parent.
//! - `forget_subagent_notify(id)`: removes the session from both parent and
//!   child roles.

use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use vst_types::domain::{Channel, LifecycleState};

pub const COALESCE_MS: u64 = 4_000;
pub const MAX_NOTICES_PER_PARENT: usize = 25;

/// Pill payload emitted to the parent's json-channel turn queue.
#[derive(Clone, Debug)]
pub struct PillPayload {
    pub subagent_id: String,
    pub subagent_name: String,
    pub subagent_state: LifecycleState,
    pub text: String,
}

/// Session record returned by the dep-injection lookup.
#[derive(Clone, Debug)]
pub struct SessionLookup {
    pub id: String,
    pub channel: Channel,
    pub parent_session_id: Option<String>,
    pub name: Option<String>,
    pub archived_at: Option<String>,
    pub superseded_by: Option<String>,
    pub lifecycle_state: Option<LifecycleState>,
}

/// Dependency-injection surface — keeps `subagent_notify` as a leaf crate
/// with no compile-time dependency on `jsonAgentRuntime`.  The wiring lives
/// in the caller (lifecycle poller).
pub trait NotifyDeps: Send + Sync {
    fn lookup(&self, id: &str) -> Option<SessionLookup>;
    fn populate_notice_slot(&self, parent: &str, child_id: &str, child_name: &str) -> bool;
    fn emit_pill(
        &self,
        parent: &str,
        payload: PillPayload,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
    fn prune_notice_slot_child(&self, parent: &str, child: &str);
}

/// Resolve the effective parent session id (following the `superseded_by`
/// chain), and verify it is a valid target (exists, not archived, not done,
/// and json channel).
pub fn resolve_parent(child_id: &str, deps: &dyn NotifyDeps) -> Option<String> {
    let child = deps.lookup(child_id)?;
    let mut parent_id = child.parent_session_id?;
    let mut seen = std::collections::HashSet::new();
    while seen.insert(parent_id.clone()) {
        let Some(p) = deps.lookup(&parent_id) else { break };
        let Some(next) = p.superseded_by else { break };
        parent_id = next;
    }
    let parent = deps.lookup(&parent_id)?;
    if parent.archived_at.is_some() {
        return None;
    }
    if parent.lifecycle_state == Some(LifecycleState::Done) {
        return None;
    }
    if parent.channel != Channel::Json {
        return None;
    }
    Some(parent_id)
}

#[derive(Default)]
struct ParentState {
    budget: usize,
    pending: HashMap<String, PillPayload>,
}

struct Inner {
    parents: HashMap<String, ParentState>,
    children: HashMap<String, String>,
    flush_handles: HashMap<String, tokio::task::JoinHandle<()>>,
    suppression_warned: std::collections::HashSet<String>,
    deps: Option<Arc<dyn NotifyDeps>>,
}

/// Handle to the subagent-notify coalescer.
#[derive(Clone)]
pub struct SubagentNotifyHandle(Arc<Mutex<Inner>>);

impl SubagentNotifyHandle {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(Inner {
            parents: HashMap::new(),
            children: HashMap::new(),
            flush_handles: HashMap::new(),
            suppression_warned: std::collections::HashSet::new(),
            deps: None,
        })))
    }

    /// Set runtime dependencies used for async flushing.
    pub fn set_deps(&self, deps: Arc<dyn NotifyDeps>) {
        let mut inner = self.0.lock().expect("poisoned");
        inner.deps = Some(deps);
    }

    /// Record a child state transition.  Fires flush after `COALESCE_MS` if
    /// the new state is NOTABLE (`WaitingForHuman`).
    pub fn note_subagent_state_change(
        &self,
        child_id: &str,
        from: LifecycleState,
        to: LifecycleState,
        deps: &dyn NotifyDeps,
    ) {
        if from == to {
            return;
        }

        // R16 prune: when child leaves WaitingForHuman (any reason), prune from parent's notice slot
        if from == LifecycleState::WaitingForHuman && to != LifecycleState::WaitingForHuman {
            if let Some(parent_id) = resolve_parent(child_id, deps) {
                deps.prune_notice_slot_child(&parent_id, child_id);
            }
            let mut inner = self.0.lock().expect("poisoned");
            if let Some(parent_id) = inner.children.remove(child_id) {
                if let Some(state) = inner.parents.get_mut(&parent_id) {
                    state.pending.remove(child_id);
                }
            }
        }

        if to != LifecycleState::WaitingForHuman {
            return;
        }

        let Some(parent_id) = resolve_parent(child_id, deps) else {
            return;
        };
        let child_rec = deps.lookup(child_id);
        let child_name = child_rec
            .as_ref()
            .and_then(|c| c.name.clone())
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| child_id.to_string());

        {
            let mut inner = self.0.lock().expect("SubagentNotify poisoned");
            let entry = inner.parents.entry(parent_id.clone()).or_default();
            entry.pending.insert(
                child_id.to_string(),
                PillPayload {
                    subagent_id: child_id.to_string(),
                    subagent_name: child_name.clone(),
                    subagent_state: to,
                    text: String::new(),
                },
            );
            inner
                .children
                .insert(child_id.to_string(), parent_id.clone());
        }

        self.schedule_flush(parent_id);
    }

    fn schedule_flush(&self, parent_id: String) {
        // Cancel any previous pending flush handle for this parent.
        let mut inner = self.0.lock().expect("poisoned");
        if let Some(handle) = inner.flush_handles.remove(&parent_id) {
            handle.abort();
        }
        let handle_arc = self.0.clone();
        let parent_clone = parent_id.clone();
        let handle = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(COALESCE_MS)).await;
            Self::flush_parent(handle_arc, &parent_clone).await;
        });
        inner.flush_handles.insert(parent_id, handle);
    }

    /// Flush pending notices for a single parent session.
    async fn flush_parent(arc: Arc<Mutex<Inner>>, parent_id: &str) {
        let (deps, children, at_cap) = {
            let mut inner = arc.lock().expect("poisoned");
            inner.flush_handles.remove(parent_id);
            let Some(deps) = inner.deps.clone() else { return };
            let Some(state) = inner.parents.get_mut(parent_id) else { return };
            let children: Vec<(String, PillPayload)> = state.pending.drain().collect();
            if children.is_empty() { return };
            let at_cap = state.budget >= MAX_NOTICES_PER_PARENT;
            (deps, children, at_cap)
        };

        // Re-check parent validity
        let Some(parent) = deps.lookup(parent_id) else { return };
        if parent.archived_at.is_some()
            || parent.lifecycle_state == Some(LifecycleState::Done)
            || parent.channel != Channel::Json
        {
            return;
        }

        if at_cap {
            for (_, payload) in &children {
                deps.emit_pill(parent_id, payload.clone()).await;
            }
            let is_first = {
                let mut inner = arc.lock().expect("poisoned");
                inner.suppression_warned.insert(parent_id.to_string())
            };
            if is_first {
                deps.emit_pill(
                    parent_id,
                    PillPayload {
                        subagent_id: String::new(),
                        subagent_name: String::new(),
                        subagent_state: LifecycleState::WaitingForHuman,
                        text: "auto-wake paused; reply here to resume".to_string(),
                    },
                )
                .await;
            }
            return;
        }

        let mut slotted: Vec<(String, PillPayload)> = Vec::new();
        for (child_id, payload) in children {
            if deps.populate_notice_slot(parent_id, &child_id, &payload.subagent_name) {
                slotted.push((child_id, payload));
            }
        }

        if !slotted.is_empty() {
            // Pills are NOT emitted here while the event is only queued in the tray;
            // pills are emitted upon dequeue when the parent runs the wake-up turn.
            let mut inner = arc.lock().expect("poisoned");
            if let Some(state) = inner.parents.get_mut(parent_id) {
                state.budget += 1;
            }
        }
    }

    /// Reset the notice budget for a parent session (called when a human turn
    /// arrives in the parent's json channel).
    pub fn note_human_turn(&self, parent_id: &str) {
        let mut inner = self.0.lock().expect("poisoned");
        if let Some(state) = inner.parents.get_mut(parent_id) {
            state.budget = 0;
        }
        inner.suppression_warned.remove(parent_id);
    }

    /// Remove `id` from both parent and child tracking maps.
    pub fn forget_subagent_notify(&self, id: &str) {
        let mut inner = self.0.lock().expect("poisoned");
        if let Some(handle) = inner.flush_handles.remove(id) {
            handle.abort();
        }
        inner.parents.remove(id);
        inner.suppression_warned.remove(id);
        if let Some(parent_id) = inner.children.remove(id) {
            if let Some(state) = inner.parents.get_mut(&parent_id) {
                state.pending.remove(id);
            }
        }
    }
}

impl Default for SubagentNotifyHandle {
    fn default() -> Self {
        Self::new()
    }
}
