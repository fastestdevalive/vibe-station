//! `JsonAgentRegistry` — the registry of live JSON agent-chat sessions.
//!
//! Ports `daemon/src/state/jsonAgentRegistry.ts`, a `sessionId → JsonAgentSession`
//! `Map` mirroring `directPtyRegistry`: a JSON session is registered lazily on its
//! first turn (per-turn spawn is stateless between turns, Decision 2) and removed
//! when the session/worktree is deleted.
//!
//! The TS is typed loosely (`unknown`-free) to avoid an import cycle with the
//! service that defines `JsonAgentSession`. The concrete session type is not yet
//! ported (blocked on `05-lifecycle-status`), so this registry is generic over
//! the value type; instantiate as `JsonAgentRegistry<JsonAgentSession>` when the
//! core lands. Values are stored as `Arc<T>` (the session is an interior-mutable
//! handle, per the workspace `XHandle(Arc<Inner>)` convention), and `get` returns
//! a cloned `Arc` so callers can call methods on the live session without holding
//! the registry's lock.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};

use vst_types::activity::ActivitySink;
use vst_types::artifacts::ArtifactSink;
use vst_types::review::{ReviewPort, TurnObserver};

/// The review-comments seams installed together (one setter).
struct ReviewHooks {
    port: Arc<dyn ReviewPort>,
    observer: Arc<dyn TurnObserver>,
}

/// Lock `m`, recovering from poison.
///
/// Every registry lock goes through here. A panic on one session's path must
/// never take Rich Chat down for every session: with `lock().unwrap()` a single
/// panic while a guard was held poisoned the map and every later `chat:open`
/// panicked in turn. The map's invariants cannot be half-applied by a panic —
/// each critical section is a single `HashMap` call, and constructors run
/// without the map lock (see [`JsonAgentRegistry::try_get_or_insert_with`]).
fn lock<M>(m: &Mutex<M>) -> MutexGuard<'_, M> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Interior-mutable `sessionId → Arc<T>` map, safe to share across routes.
pub struct JsonAgentRegistry<T> {
    inner: Mutex<HashMap<String, Arc<T>>>,
    /// Per-session-id creation gates: serialize constructors for the SAME id
    /// (so one session never gets two instances, nor two concurrent transcript
    /// opens/migrations) without holding `inner` across the construction.
    creating: GateMap,
    /// Daemon-wide activity sink, set once from `run.rs`. Sessions created via
    /// `get_or_create_json_agent_session` attach it so they report activity.
    activity: OnceLock<Arc<dyn ActivitySink>>,
    /// Daemon-wide artifact sink (file effects of finished tool calls), set once
    /// from `run.rs`. Optional: with none installed capture is a no-op.
    artifact: OnceLock<Arc<dyn ArtifactSink>>,
    /// Review-comments owner, as the two `vst-types` seams (`ReviewPort` for
    /// routes and the scheduled-fire path, `TurnObserver` for sessions), set once
    /// from `run.rs`. With none installed review turns are never created.
    review: OnceLock<ReviewHooks>,
}

impl<T> Default for JsonAgentRegistry<T> {
    fn default() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            creating: Mutex::new(HashMap::new()),
            activity: OnceLock::new(),
            artifact: OnceLock::new(),
            review: OnceLock::new(),
        }
    }
}

impl<T> JsonAgentRegistry<T> {
    /// An empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Install the activity sink (first call wins; later calls are ignored).
    pub fn set_activity_sink(&self, sink: Arc<dyn ActivitySink>) {
        let _ = self.activity.set(sink);
    }

    /// The installed activity sink, if any.
    pub fn activity_sink(&self) -> Option<Arc<dyn ActivitySink>> {
        self.activity.get().cloned()
    }

    /// Install the artifact sink (first call wins; later calls are ignored).
    pub fn set_artifact_sink(&self, sink: Arc<dyn ArtifactSink>) {
        let _ = self.artifact.set(sink);
    }

    /// The installed artifact sink, if any.
    pub fn artifact_sink(&self) -> Option<Arc<dyn ArtifactSink>> {
        self.artifact.get().cloned()
    }

    /// Install the review-comments seams (first call wins; later calls are ignored).
    pub fn set_review_hooks(&self, port: Arc<dyn ReviewPort>, observer: Arc<dyn TurnObserver>) {
        let _ = self.review.set(ReviewHooks { port, observer });
    }

    /// The review port, if installed.
    pub fn review_port(&self) -> Option<Arc<dyn ReviewPort>> {
        self.review.get().map(|h| h.port.clone())
    }

    /// The turn observer sessions report to, if installed.
    pub fn review_observer(&self) -> Option<Arc<dyn TurnObserver>> {
        self.review.get().map(|h| h.observer.clone())
    }

    /// The live session registered for `session_id`, if any.
    pub fn get(&self, session_id: &str) -> Option<Arc<T>> {
        lock(&self.inner).get(session_id).cloned()
    }

    /// Register (or replace) the live session for `session_id`.
    pub fn set(&self, session_id: String, session: Arc<T>) {
        lock(&self.inner).insert(session_id, session);
    }

    /// Infallible [`try_get_or_insert_with`](Self::try_get_or_insert_with).
    pub fn get_or_insert_with(&self, session_id: &str, create: impl FnOnce() -> T) -> Arc<T> {
        match self.try_get_or_insert_with(session_id, || Ok::<T, Infallible>(create())) {
            Ok((value, _created)) => value,
            Err(never) => match never {},
        }
    }

    /// Atomic "get existing, or construct-and-register a new one", with the
    /// constructor run OUTSIDE the map lock. Returns the value and whether this
    /// call constructed it.
    ///
    /// Single instance per id: two concurrent callers for the same
    /// `session_id` never both construct. `get_or_create_json_agent_session`
    /// once did a separate `get()` then `set()` with an `.await` between
    /// (in `resolve_json_agent`): a fresh direct-agent session's `chat:open`
    /// racing its own auto-enqueued turn-1 each built a `JsonAgentSession`, the
    /// second `set()` evicted the first, the turn ran on the discarded instance
    /// and the Rich Chat pane stayed empty until a refresh. Concurrent
    /// constructors also open (and migrate) the same transcript DB at once.
    /// Callers for the same id therefore queue on a per-id creation gate and
    /// re-check the map once they hold it.
    ///
    /// No I/O under the map lock: constructing a `JsonAgentSession` opens its
    /// SQLite transcript. That once ran inside the map lock; when the open
    /// panicked the lock was poisoned and every later `chat:open` for every
    /// session died. `create` now runs holding only its own id's gate, so a slow
    /// or failing construction never blocks `get`/`remove` or another id.
    ///
    /// # Errors
    /// Whatever `create` returns; nothing is registered and the next call for
    /// this id runs `create` again.
    pub fn try_get_or_insert_with<E>(
        &self,
        session_id: &str,
        create: impl FnOnce() -> Result<T, E>,
    ) -> Result<(Arc<T>, bool), E> {
        if let Some(existing) = self.get(session_id) {
            return Ok((existing, false));
        }
        // The ticket releases its gate on every exit (success, error or panic in
        // `create`) and the last holder removes the entry, so the gate map never
        // leaks ids and two constructors for one id never overlap. Declared
        // before the guard, so the guard is always released first.
        let ticket = GateTicket::take_or_create(&self.creating, session_id);
        let gate_guard = lock(ticket.gate());
        let result = (|| {
            if let Some(existing) = self.get(session_id) {
                return Ok((existing, false));
            }
            let created = Arc::new(create()?);
            let mut map = lock(&self.inner);
            if let Some(existing) = map.get(session_id) {
                return Ok((existing.clone(), false));
            }
            map.insert(session_id.to_string(), created.clone());
            Ok((created, true))
        })();
        drop(gate_guard);
        result
    }

    /// Remove the session for `session_id`, returning the prior value if present.
    ///
    /// Waits for an in-flight construction of the same id first, so a delete
    /// racing a lazy create removes the new instance instead of being undone by
    /// its insert (the order the old construct-under-the-map-lock shape gave).
    /// Must not be called from inside that id's `create` closure.
    pub fn remove(&self, session_id: &str) -> Option<Arc<T>> {
        let Some(ticket) = GateTicket::take_existing(&self.creating, session_id) else {
            return lock(&self.inner).remove(session_id);
        };
        // Holding a ticket keeps the creator from removing the gate entry, so
        // this caller removes it if it leaves last.
        let in_flight_done = lock(ticket.gate());
        let removed = lock(&self.inner).remove(session_id);
        drop(in_flight_done);
        removed
    }

    /// Remove every entry.
    pub fn clear(&self) {
        lock(&self.inner).clear();
    }
}

type GateMap = Mutex<HashMap<String, Arc<Mutex<()>>>>;

/// One caller's hold on a per-id creation gate.
///
/// Every clone AND every drop of a gate `Arc` happens under the `creating`
/// lock (the ticket owns its clone and releases it in `Drop` while holding
/// that lock), so `strong_count` is exact there: when a releasing ticket
/// leaves only the map's reference, nobody else is queued and the entry is
/// removed. A queued waiter therefore always keeps the SAME gate (a newcomer
/// can't construct beside it after a failed create), and the last one out
/// never leaves a stale entry behind.
struct GateTicket<'a> {
    creating: &'a GateMap,
    session_id: &'a str,
    /// `None` only inside `drop`.
    gate: Option<Arc<Mutex<()>>>,
}

impl<'a> GateTicket<'a> {
    /// Join (or open) the gate for `session_id`.
    fn take_or_create(creating: &'a GateMap, session_id: &'a str) -> Self {
        let gate = lock(creating)
            .entry(session_id.to_string())
            .or_default()
            .clone();
        Self {
            creating,
            session_id,
            gate: Some(gate),
        }
    }

    /// Join the gate for `session_id` only if a creation is in flight.
    fn take_existing(creating: &'a GateMap, session_id: &'a str) -> Option<Self> {
        let gate = lock(creating).get(session_id).cloned()?;
        Some(Self {
            creating,
            session_id,
            gate: Some(gate),
        })
    }

    fn gate(&self) -> &Mutex<()> {
        match &self.gate {
            Some(gate) => gate,
            None => unreachable!("gate is only taken in drop"),
        }
    }
}

impl Drop for GateTicket<'_> {
    fn drop(&mut self) {
        let Some(ours) = self.gate.take() else { return };
        let mut gates = lock(self.creating);
        let ours_ptr = Arc::as_ptr(&ours);
        drop(ours);
        if gates
            .get(self.session_id)
            // 1 = only the map's own reference is left: nobody is queued.
            .is_some_and(|g| Arc::as_ptr(g) == ours_ptr && Arc::strong_count(g) == 1)
        {
            gates.remove(self.session_id);
        }
    }
}

impl<T> std::fmt::Debug for JsonAgentRegistry<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let n = lock(&self.inner).len();
        f.debug_struct("JsonAgentRegistry")
            .field("len", &n)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    //! White-box tests: they poison the PRIVATE mutexes directly (a panicking
    //! constructor no longer can, since it runs without the map lock) and
    //! inspect the creation-gate map for leaks.

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::sync::Barrier;
    use std::thread;
    use std::time::Duration;

    use super::*;

    fn poison<M: Send>(m: &Mutex<M>) {
        thread::scope(|s| {
            let r = s
                .spawn(|| {
                    let _g = m.lock().unwrap();
                    panic!("poison on purpose");
                })
                .join();
            assert!(r.is_err());
        });
        assert!(m.is_poisoned());
    }

    fn gates_len<T>(reg: &JsonAgentRegistry<T>) -> usize {
        lock(&reg.creating).len()
    }

    /// The live bug: one panic while a registry guard was held made every later
    /// call panic, so `chat:open` died for every session. Every entry point must
    /// keep working on poisoned locks.
    #[test]
    fn every_entry_point_survives_poisoned_locks() {
        let reg = JsonAgentRegistry::<String>::new();
        reg.set("a".into(), Arc::new("A".into()));
        poison(&reg.inner);
        poison(&reg.creating);

        assert_eq!(reg.get("a").as_deref().map(String::as_str), Some("A"));
        reg.set("b".into(), Arc::new("B".into()));
        let (c, created) = reg
            .try_get_or_insert_with("c", || Ok::<_, ()>("C".to_string()))
            .unwrap();
        assert!(created);
        assert_eq!(*c, "C");
        assert_eq!(*reg.get_or_insert_with("b", || "X".into()), "B");
        assert!(reg.remove("a").is_some());
        assert!(format!("{reg:?}").contains("len"));
        reg.clear();
        assert!(reg.get("b").is_none());
        assert_eq!(gates_len(&reg), 0);
    }

    /// A panicking constructor leaves no entry, no leaked gate, and does not
    /// stop the same id (or any other) from being created afterwards.
    #[test]
    fn panicking_constructor_leaves_registry_usable() {
        let reg = JsonAgentRegistry::<String>::new();
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            reg.get_or_insert_with("a", || panic!("transcript open failed"))
        }));
        assert!(r.is_err());
        assert!(reg.get("a").is_none());
        assert_eq!(gates_len(&reg), 0, "gate removed on unwind");
        assert_eq!(*reg.get_or_insert_with("a", || "A".into()), "A");
        assert_eq!(*reg.get_or_insert_with("b", || "B".into()), "B");
    }

    /// `Err` registers nothing, leaks no gate, and the next call retries.
    #[test]
    fn failed_constructor_registers_nothing_and_retries() {
        let reg = JsonAgentRegistry::<String>::new();
        let r = reg.try_get_or_insert_with("a", || Err::<String, _>("disk I/O error"));
        assert_eq!(r.unwrap_err(), "disk I/O error");
        assert!(reg.get("a").is_none());
        assert_eq!(gates_len(&reg), 0);
        let mut ran = false;
        let (v, created) = reg
            .try_get_or_insert_with("a", || {
                ran = true;
                Ok::<_, &str>("A".to_string())
            })
            .unwrap();
        assert!(ran && created);
        assert_eq!(*v, "A");
        assert_eq!(gates_len(&reg), 0);
    }

    /// The constructor runs without the map lock: it may read/write other
    /// entries (a std `Mutex` is not re-entrant — this would deadlock or panic
    /// if the map lock were held).
    #[test]
    fn constructor_runs_without_the_map_lock() {
        let reg = JsonAgentRegistry::<String>::new();
        reg.set("other".into(), Arc::new("O".into()));
        let v = reg.get_or_insert_with("a", || {
            assert!(reg.get("other").is_some());
            reg.set("third".into(), Arc::new("T".into()));
            "A".into()
        });
        assert_eq!(*v, "A");
        assert!(reg.get("third").is_some());
    }

    /// A slow construction of one id never blocks `get`/`remove`/creation of
    /// another id.
    #[test]
    fn different_ids_never_wait_on_each_other() {
        let reg = JsonAgentRegistry::<String>::new();
        reg.set("x".into(), Arc::new("X".into()));
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let entered = Barrier::new(2);
        thread::scope(|s| {
            let (reg_ref, entered_ref) = (&reg, &entered);
            let slow = s.spawn(move || {
                reg_ref.get_or_insert_with("a", || {
                    entered_ref.wait();
                    release_rx.recv().unwrap();
                    "A".to_string()
                })
            });
            entered.wait();
            // "a" is mid-construction; all of these must complete now.
            assert_eq!(*reg.get_or_insert_with("b", || "B".into()), "B");
            assert!(reg.get("a").is_none());
            assert!(reg.remove("x").is_some());
            release_tx.send(()).unwrap();
            assert_eq!(*slow.join().unwrap(), "A");
        });
        assert_eq!(gates_len(&reg), 0);
    }

    /// Same-id callers never construct concurrently — including after a failed
    /// construction, when a queued waiter and a late arrival race (the case an
    /// unconditional gate removal would get wrong). Exactly one value wins.
    #[test]
    fn same_id_constructors_never_overlap_even_after_a_failure() {
        let reg = JsonAgentRegistry::<usize>::new();
        let active = AtomicUsize::new(0);
        let max_active = AtomicUsize::new(0);
        let calls = AtomicUsize::new(0);
        let create = || {
            let now = active.fetch_add(1, Ordering::SeqCst) + 1;
            max_active.fetch_max(now, Ordering::SeqCst);
            let n = calls.fetch_add(1, Ordering::SeqCst);
            thread::sleep(Duration::from_millis(20));
            active.fetch_sub(1, Ordering::SeqCst);
            // The first construction fails; later ones succeed.
            if n == 0 {
                Err("first open fails")
            } else {
                Ok(n)
            }
        };
        let results: Vec<_> = thread::scope(|s| {
            let handles: Vec<_> = (0..8)
                .map(|i| {
                    let create = &create;
                    let reg = &reg;
                    s.spawn(move || {
                        thread::sleep(Duration::from_millis(i * 3));
                        reg.try_get_or_insert_with("a", create)
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert_eq!(
            max_active.load(Ordering::SeqCst),
            1,
            "constructors overlapped"
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "one failure, then one success"
        );
        let winner = reg.get("a").expect("registered");
        let oks: Vec<_> = results.into_iter().filter_map(Result::ok).collect();
        assert_eq!(oks.len(), 7);
        assert_eq!(oks.iter().filter(|(_, created)| *created).count(), 1);
        assert!(oks.iter().all(|(v, _)| Arc::ptr_eq(v, &winner)));
        assert_eq!(gates_len(&reg), 0);
    }

    /// A delete racing a lazy create removes the new instance instead of being
    /// undone by its insert.
    #[test]
    fn remove_waits_for_in_flight_construction() {
        let reg = JsonAgentRegistry::<String>::new();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let entered = Barrier::new(2);
        thread::scope(|s| {
            let (reg_ref, entered_ref) = (&reg, &entered);
            let creator = s.spawn(move || {
                reg_ref.get_or_insert_with("a", || {
                    entered_ref.wait();
                    release_rx.recv().unwrap();
                    "A".to_string()
                })
            });
            entered.wait();
            let remover = s.spawn(|| reg.remove("a"));
            thread::sleep(Duration::from_millis(30));
            assert!(!remover.is_finished(), "remove must wait for the creation");
            release_tx.send(()).unwrap();
            creator.join().unwrap();
            assert_eq!(
                remover.join().unwrap().as_deref().map(String::as_str),
                Some("A")
            );
        });
        assert!(reg.get("a").is_none(), "no zombie entry for a deleted id");
        assert_eq!(gates_len(&reg), 0);
    }
}
