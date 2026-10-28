//! Event batcher (plan Decision 9): coalesces artifact changes per scope and
//! flushes at most every 250 ms with a per-scope `rev`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;
use vst_types::artifacts::{ArtifactRemoveReason, ArtifactRow, ArtifactUpsert, ScopeKey};
use vst_types::{Broadcaster, ServerEvent};

/// Trailing flush window.
pub const BATCH_WINDOW: Duration = Duration::from_millis(250);
/// Largest number of rows in one `artifact:upserted` event.
pub const CHUNK_ROWS: usize = 200;

#[derive(Default)]
struct ScopePending {
    /// Insertion-ordered ids of pending upserts.
    order: Vec<String>,
    upserts: HashMap<String, (ArtifactRow, bool)>,
    removed: Vec<(ArtifactRemoveReason, Vec<String>)>,
}

impl ScopePending {
    fn is_empty(&self) -> bool {
        self.upserts.is_empty() && self.removed.iter().all(|(_, ids)| ids.is_empty())
    }
}

#[derive(Default)]
struct State {
    pending: HashMap<ScopeKey, ScopePending>,
    rev: HashMap<ScopeKey, u64>,
}

/// Coalesces and broadcasts `artifact:*` events.
pub struct Batcher {
    broadcaster: Broadcaster,
    state: Mutex<State>,
}

impl Batcher {
    pub fn new(broadcaster: Broadcaster) -> Arc<Self> {
        Arc::new(Self {
            broadcaster,
            state: Mutex::new(State::default()),
        })
    }

    /// Current `rev` of a scope. The list handler reads it BEFORE the rows, so
    /// an event that races the list is either reflected or has `rev > last`.
    pub fn rev(&self, scope: &ScopeKey) -> u64 {
        self.state
            .lock()
            .unwrap()
            .rev
            .get(scope)
            .copied()
            .unwrap_or(0)
    }

    /// Queue an upsert; the last write of an id wins, `created` is sticky.
    pub fn upsert(&self, row: ArtifactRow, created: bool) {
        let scope = ScopeKey {
            scope_kind: row.scope_kind,
            scope_id: row.scope_id.clone(),
        };
        let mut st = self.state.lock().unwrap();
        let p = st.pending.entry(scope).or_default();
        for (_, ids) in &mut p.removed {
            ids.retain(|i| *i != row.id);
        }
        match p.upserts.get_mut(&row.id) {
            Some(slot) => {
                slot.1 |= created;
                slot.0 = row;
            }
            None => {
                p.order.push(row.id.clone());
                p.upserts.insert(row.id.clone(), (row, created));
            }
        }
    }

    /// Queue removals (they cancel pending upserts of the same ids).
    pub fn remove(&self, scope: &ScopeKey, ids: Vec<String>, reason: ArtifactRemoveReason) {
        if ids.is_empty() {
            return;
        }
        let mut st = self.state.lock().unwrap();
        let p = st.pending.entry(scope.clone()).or_default();
        for id in &ids {
            p.upserts.remove(id);
        }
        p.order.retain(|i| p.upserts.contains_key(i));
        for (_, existing) in &mut p.removed {
            existing.retain(|i| !ids.contains(i));
        }
        match p.removed.iter_mut().find(|(r, _)| *r == reason) {
            Some((_, existing)) => existing.extend(ids),
            None => p.removed.push((reason, ids)),
        }
    }

    /// Forget everything pending/counted for a purged scope.
    pub fn forget_scope(&self, scope: &ScopeKey) {
        let mut st = self.state.lock().unwrap();
        st.pending.remove(scope);
        st.rev.remove(scope);
    }

    /// Broadcast everything pending (no-op when nothing is). Each event takes
    /// the scope's next consecutive `rev`; removals go before upserts.
    pub fn flush_pending(&self) {
        let mut st = self.state.lock().unwrap();
        let scopes: Vec<ScopeKey> = st.pending.keys().cloned().collect();
        for scope in scopes {
            let Some(p) = st.pending.remove(&scope) else {
                continue;
            };
            if p.is_empty() {
                continue;
            }
            let mut events: Vec<Box<dyn FnOnce(u64) -> ServerEvent>> = Vec::new();
            for (reason, ids) in p.removed {
                if ids.is_empty() {
                    continue;
                }
                let s = scope.clone();
                events.push(Box::new(move |rev| ServerEvent::ArtifactRemoved {
                    scope_kind: s.scope_kind,
                    scope_id: s.scope_id,
                    rev,
                    ids,
                    reason,
                }));
            }
            let mut p_upserts = p.upserts;
            let rows: Vec<ArtifactUpsert> = p
                .order
                .iter()
                .filter_map(|id| p_upserts.remove(id))
                .map(|(row, created)| ArtifactUpsert { row, created })
                .collect();
            for chunk in rows.chunks(CHUNK_ROWS) {
                let s = scope.clone();
                let chunk = chunk.to_vec();
                events.push(Box::new(move |rev| ServerEvent::ArtifactUpserted {
                    scope_kind: s.scope_kind,
                    scope_id: s.scope_id,
                    rev,
                    rows: chunk,
                }));
            }
            let counter = st.rev.entry(scope).or_insert(0);
            for make in events {
                *counter += 1;
                self.broadcaster.send(make(*counter));
            }
        }
    }

    /// The trailing flusher loop (copy of the `PrPollerHandle` shape:
    /// `MissedTickBehavior::Skip`, broadcast on change only).
    pub async fn run(self: Arc<Self>) {
        let mut tick = tokio::time::interval(BATCH_WINDOW);
        tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            self.flush_pending();
        }
    }

    /// Spawn [`run`](Self::run).
    pub fn start(self: Arc<Self>) -> JoinHandle<()> {
        tokio::spawn(self.run())
    }
}
