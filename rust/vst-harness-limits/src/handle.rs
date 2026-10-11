//! `LimitsHandle` — the harness-limits scheduler: a cheap `Clone` handle over
//! an `Arc<Inner>` owning the cache, timers, and in-flight/backoff state.
//!
//! Architecture: the scheduler is built in `vst-daemon` (probes, the
//! session→harness resolver, host, and client counter are injected), keeps no
//! `vst-agents` dependency edge, and follows `PrPollerHandle`'s lifecycle —
//! `start(&self)` returns a `JoinHandle` aborted on shutdown.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use tokio::sync::broadcast::error::RecvError;
use tracing::debug;
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::{LifecycleState, LimitSlotRef, LimitStatus, LimitsResult, LimitsSnapshot};

use crate::merge::{merge_result, results_equivalent};
use crate::policy::{
    backoff_delay, cooldown_remaining, debounce_ok, is_turn_finished, LimitsTiming,
};

/// A future resolving to a probed `LimitsResult`.
pub type ProbeFuture = Pin<Box<dyn Future<Output = LimitsResult> + Send>>;
/// A probe closure (one per harness).
pub type ProbeFn = Arc<dyn Fn() -> ProbeFuture + Send + Sync>;
/// A future resolving to `Option<String>` (the harness a session belongs to).
pub type HarnessFuture = Pin<Box<dyn Future<Output = Option<String>> + Send>>;
/// Session-id → harness resolver.
pub type SessionHarnessFn = Arc<dyn Fn(String) -> HarnessFuture + Send + Sync>;
/// Live-client counter closure.
pub type ClientCountFn = Arc<dyn Fn() -> usize + Send + Sync>;

/// A single registered harness and its probe closure.
#[derive(Clone)]
pub struct HarnessProbe {
    pub harness: String,
    pub probe: ProbeFn,
}

/// Everything the scheduler needs, injected at construction.
pub struct LimitsDeps {
    pub broadcaster: Broadcaster,
    pub probes: Vec<HarnessProbe>,
    pub session_harness: SessionHarnessFn,
    pub host: String,
    pub initial_slots: [LimitSlotRef; 2],
    pub timing: LimitsTiming,
}

/// Result of `refresh_manual` — whether probes started and, if not, how long
/// to wait before retrying.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RefreshOutcome {
    pub started: bool,
    pub retry_after_secs: Option<u64>,
}

/// Why a probe is being run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Trigger {
    Interval,
    Turn,
    Fetch,
    Manual,
}

impl Trigger {
    /// Manual refresh ignores the backoff gate.
    fn ignores_backoff(self) -> bool {
        matches!(self, Trigger::Manual)
    }
}

struct State {
    results: BTreeMap<String, LimitsResult>,
    slots: [LimitSlotRef; 2],
    last_probe: HashMap<String, Instant>,
    last_broadcast: HashMap<String, Instant>,
    last_turn_probe: HashMap<String, Instant>,
    fail_count: HashMap<String, u32>,
    backoff_until: HashMap<String, Instant>,
    in_flight: HashSet<String>,
    unsupported: HashSet<String>,
    last_manual: Option<Instant>,
    last_states: HashMap<String, LifecycleState>,
}

struct Inner {
    state: Mutex<State>,
    broadcaster: Broadcaster,
    probes: HashMap<String, ProbeFn>,
    session_harness: SessionHarnessFn,
    host: String,
    timing: LimitsTiming,
    client_counter: OnceLock<ClientCountFn>,
}

/// The scheduler handle. Cheap `Clone`; all shared state in `Arc<Inner>`.
#[derive(Clone)]
pub struct LimitsHandle {
    inner: Arc<Inner>,
}

impl LimitsHandle {
    pub fn new(deps: LimitsDeps) -> Self {
        let inner = Arc::new(Inner {
            state: Mutex::new(State {
                results: BTreeMap::new(),
                slots: deps.initial_slots,
                last_probe: HashMap::new(),
                last_broadcast: HashMap::new(),
                last_turn_probe: HashMap::new(),
                fail_count: HashMap::new(),
                backoff_until: HashMap::new(),
                in_flight: HashSet::new(),
                unsupported: HashSet::new(),
                last_manual: None,
                last_states: HashMap::new(),
            }),
            broadcaster: deps.broadcaster,
            probes: deps
                .probes
                .into_iter()
                .map(|p| (p.harness, p.probe))
                .collect(),
            session_harness: deps.session_harness,
            host: deps.host,
            timing: deps.timing,
            client_counter: OnceLock::new(),
        });
        Self { inner }
    }

    /// No probes; for tests/route wiring that must not probe.
    pub fn inert(broadcaster: Broadcaster, host: String) -> Self {
        Self::new(LimitsDeps {
            broadcaster,
            probes: vec![],
            session_harness: Arc::new(|_| Box::pin(async { None })),
            host,
            initial_slots: vst_types::limits::default_slots(),
            timing: LimitsTiming::default(),
        })
    }

    /// Late-bind the live-client counter. A second bind is silently ignored.
    pub fn bind_client_counter(&self, f: ClientCountFn) {
        let _ = self.inner.client_counter.set(f);
    }

    /// The current snapshot: harnesses sorted by name, excluding `Unsupported`.
    pub fn snapshot(&self) -> LimitsSnapshot {
        self.inner.snapshot()
    }

    /// Client connected/fetched: probe every harness whose last probe is
    /// stale (any client count), else serve the cache.
    pub fn note_client_fetch(&self) {
        let now = Instant::now();
        let stale: Vec<String> = {
            let st = self.inner.state.lock().unwrap();
            self.inner
                .probes
                .keys()
                .filter(|h| {
                    !st.unsupported.contains(*h)
                        && crate::policy::is_stale(
                            st.last_probe.get(*h).copied(),
                            now,
                            self.inner.timing.stale_after,
                        )
                })
                .cloned()
                .collect()
        };
        for harness in stale {
            let inner = self.inner.clone();
            tokio::spawn(probe_one(inner, harness, Trigger::Fetch));
        }
    }

    /// Manual refresh: awaits the probes. Returns `started:false` with a
    /// retry-after when inside the cooldown.
    pub async fn refresh_manual(&self) -> RefreshOutcome {
        let now = Instant::now();
        let cooldown = self.inner.timing.manual_cooldown;
        {
            let mut st = self.inner.state.lock().unwrap();
            if let Some(rem) = cooldown_remaining(st.last_manual, now, cooldown) {
                return RefreshOutcome {
                    started: false,
                    retry_after_secs: Some(rem.as_secs().max(1)),
                };
            }
            st.last_manual = Some(now);
        }
        let inner = self.inner.clone();
        let handles: Vec<_> = inner
            .probes
            .keys()
            .map(|harness| tokio::spawn(probe_one(inner.clone(), harness.clone(), Trigger::Manual)))
            .collect();
        for h in handles {
            let _ = h.await;
        }
        RefreshOutcome {
            started: true,
            retry_after_secs: None,
        }
    }

    /// Store the pinned slots and broadcast `limits:updated`.
    pub fn set_slots(&self, slots: [LimitSlotRef; 2]) -> LimitsSnapshot {
        {
            let mut st = self.inner.state.lock().unwrap();
            st.slots = slots;
        }
        let snapshot = self.snapshot();
        self.inner.broadcaster.send(ServerEvent::LimitsUpdated {
            limits: snapshot.clone(),
        });
        snapshot
    }

    /// Start the scheduler loop: interval probing + turn-finished triggering.
    /// The `broadcast::Receiver` is subscribed SYNCHRONOUSLY in `start()`
    /// (before `tokio::spawn`) so events sent right after `start()` are not
    /// lost.
    pub fn start(&self) -> tokio::task::JoinHandle<()> {
        let mut rx = self.inner.broadcaster.subscribe();
        let inner = self.inner.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(inner.timing.interval);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            // First tick fires immediately; consume it so a probe isn't run
            // twice back-to-back with the initial note_client_fetch.
            interval.tick().await;
            loop {
                tokio::select! {
                    _ = interval.tick() => {
                        if inner.client_count() >= 1 {
                            let names: Vec<String> = inner.probes.keys().cloned().collect();
                            for harness in names {
                                tokio::spawn(probe_one(inner.clone(), harness, Trigger::Interval));
                            }
                        }
                    }
                    ev = rx.recv() => {
                        match ev {
                            Ok(ServerEvent::SessionState { session_id, state, .. }) => {
                                let prev = {
                                    let mut st = inner.state.lock().unwrap();
                                    st.last_states.insert(session_id.clone(), state)
                                };
                                if is_turn_finished(prev, state) && inner.client_count() >= 1 {
                                    let harness = (inner.session_harness)(session_id).await;
                                    if let Some(h) = harness {
                                        if inner.probes.contains_key(&h) {
                                            let now = Instant::now();
                                            let ok = {
                                                let mut st = inner.state.lock().unwrap();
                                                if debounce_ok(st.last_turn_probe.get(&h).copied(), now, inner.timing.turn_debounce) {
                                                    st.last_turn_probe.insert(h.clone(), now);
                                                    true
                                                } else {
                                                    false
                                                }
                                            };
                                            if ok {
                                                tokio::spawn(probe_one(inner.clone(), h, Trigger::Turn));
                                            }
                                        }
                                    }
                                }
                            }
                            Ok(ServerEvent::SessionDeleted { session_id }) => {
                                inner.state.lock().unwrap().last_states.remove(&session_id);
                            }
                            Ok(_) => {}
                            Err(RecvError::Lagged(_)) => continue,
                            Err(RecvError::Closed) => break,
                        }
                    }
                }
            }
        })
    }
}

impl Inner {
    fn client_count(&self) -> usize {
        self.client_counter.get().map(|f| f()).unwrap_or(0)
    }

    fn snapshot(&self) -> LimitsSnapshot {
        let st = self.state.lock().unwrap();
        let harnesses: Vec<LimitsResult> = st
            .results
            .values()
            .filter(|r| r.status != LimitStatus::Unsupported)
            .cloned()
            .collect();
        LimitsSnapshot {
            host: self.host.clone(),
            slots: st.slots.clone(),
            harnesses,
        }
    }

    fn apply_result(&self, harness: &str, result: LimitsResult) {
        if result.status == LimitStatus::Unsupported {
            let mut st = self.state.lock().unwrap();
            st.in_flight.remove(harness);
            st.unsupported.insert(harness.to_string());
            return;
        }
        let now = Instant::now();
        let should_broadcast = {
            let mut st = self.state.lock().unwrap();
            st.in_flight.remove(harness);

            let fail = st.fail_count.entry(harness.to_string()).or_insert(0);
            if result.status == LimitStatus::Error {
                *fail += 1;
                let delay =
                    backoff_delay(*fail, self.timing.backoff_initial, self.timing.backoff_cap);
                st.backoff_until.insert(harness.to_string(), now + delay);
            } else {
                *fail = 0;
                st.backoff_until.remove(harness);
            }
            st.last_probe.insert(harness.to_string(), now);

            let prev = st.results.get(harness).cloned();
            let merged = merge_result(prev.as_ref(), result);
            let changed = match &prev {
                Some(p) => !results_equivalent(p, &merged),
                None => true,
            };
            let fresh = st.last_broadcast.get(harness).map_or(true, |t| {
                now.duration_since(*t) >= self.timing.rebroadcast_after
            });
            let should_broadcast = changed || fresh;
            if should_broadcast {
                st.last_broadcast.insert(harness.to_string(), now);
            }
            st.results.insert(harness.to_string(), merged);
            should_broadcast
        };

        if should_broadcast {
            let snapshot = self.snapshot();
            self.broadcaster
                .send(ServerEvent::LimitsUpdated { limits: snapshot });
        }
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn error_result(harness: &str, message: &str) -> LimitsResult {
    LimitsResult::failure(harness, LimitStatus::Error, message, &now_iso(), &[])
}

/// Run one probe under a timeout, applying its result. Guards: skips when the
/// harness is unsupported or already in flight; skips on backoff unless the
/// trigger is Manual. Never holds the state lock across an await.
async fn probe_one(inner: Arc<Inner>, harness: String, trigger: Trigger) {
    {
        let mut st = inner.state.lock().unwrap();
        if st.unsupported.contains(&harness) || st.in_flight.contains(&harness) {
            return;
        }
        if !trigger.ignores_backoff()
            && st
                .backoff_until
                .get(&harness)
                .is_some_and(|t| Instant::now() < *t)
        {
            return;
        }
        st.in_flight.insert(harness.clone());
    }

    let probe = inner.probes.get(&harness).cloned();
    let Some(probe) = probe else {
        inner.state.lock().unwrap().in_flight.remove(&harness);
        return;
    };

    // Run the probe in its own task so a panic cannot leave `in_flight` set (the
    // result is always applied below, which clears it) or poison the state lock.
    let probe_timeout = inner.timing.probe_timeout;
    let joined =
        tokio::spawn(async move { tokio::time::timeout(probe_timeout, probe()).await }).await;
    let result = match joined {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => error_result(&harness, "probe timed out"),
        Err(_) => error_result(&harness, "probe task failed"),
    };

    debug!(
        harness = %harness,
        status = ?result.status,
        "harness limits probe finished"
    );
    inner.apply_result(&harness, result);
}
