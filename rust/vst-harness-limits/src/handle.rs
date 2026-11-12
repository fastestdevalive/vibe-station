//! `LimitsHandle` — the harness-limits scheduler: a cheap `Clone` handle over
//! an `Arc<Inner>` owning the cache, timers, and in-flight/backoff state.
//!
//! Architecture: the scheduler is built in `vst-daemon` (targets, probes, the
//! session→account resolver, host, and client counter are injected), keeps no
//! `vst-agents`/`vst-accounts` dependency edge, and follows `PrPollerHandle`'s
//! lifecycle — `start(&self)` returns a `JoinHandle` aborted on shutdown.
//!
//! Per-account (Decision 9): every probe is one [`ProbeTarget`] (a harness plus
//! an optional account id) and ALL state is keyed by [`ProbeTarget::key`], so
//! two accounts of one harness never share a cache slot. The targets are read
//! from the injected [`TargetsFn`] at call time, so an account added or removed
//! while the daemon runs is picked up on the next tick/fetch with no restart.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use tokio::sync::broadcast::error::RecvError;
use tracing::debug;
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::{
    LifecycleState, LimitSlotRef, LimitStatus, LimitsResult, LimitsSnapshot, SYSTEM_ACCOUNT_ID,
};

use crate::merge::{merge_result, results_equivalent};
use crate::policy::{
    backoff_delay, cooldown_remaining, debounce_ok, is_turn_finished, LimitsTiming,
};

/// One thing to probe: a harness, under one account (`None` = the System login).
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct ProbeTarget {
    pub harness: String,
    /// `None` = the CLI's System login.
    pub account_id: Option<String>,
}

impl ProbeTarget {
    /// The state key: `harness` (System) or `harness#accountId`.
    #[must_use]
    pub fn key(&self) -> String {
        match &self.account_id {
            None => self.harness.clone(),
            Some(account) => format!("{}#{account}", self.harness),
        }
    }

    /// The System login of `harness`.
    #[must_use]
    pub fn system(harness: &str) -> Self {
        Self {
            harness: harness.to_string(),
            account_id: None,
        }
    }
}

/// A future resolving to a probed `LimitsResult`.
pub type ProbeFuture = Pin<Box<dyn Future<Output = LimitsResult> + Send>>;
/// Every target to probe right now (all accounts of all supported CLIs).
pub type TargetsFn = Arc<dyn Fn() -> Vec<ProbeTarget> + Send + Sync>;
/// Probe ONE target. Sets `result.accountId` + `window.accountId` (Decision 9).
pub type ProbeFn = Arc<dyn Fn(ProbeTarget) -> ProbeFuture + Send + Sync>;
/// A future resolving to the target a session belongs to.
pub type TargetFuture = Pin<Box<dyn Future<Output = Option<ProbeTarget>> + Send>>;
/// Session-id → target resolver (post-turn probe).
pub type SessionTargetFn = Arc<dyn Fn(String) -> TargetFuture + Send + Sync>;
/// Live-client counter closure.
pub type ClientCountFn = Arc<dyn Fn() -> usize + Send + Sync>;

/// Everything the scheduler needs, injected at construction.
pub struct LimitsDeps {
    pub broadcaster: Broadcaster,
    pub targets: TargetsFn,
    pub probe: ProbeFn,
    pub session_target: SessionTargetFn,
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
    /// Keyed by HARNESS: "unsupported" applies to every account of that harness.
    unsupported: HashSet<String>,
    last_manual: Option<Instant>,
    last_states: HashMap<String, LifecycleState>,
    /// Keys already probed because their account was announced (once each).
    announced: HashSet<String>,
}

impl State {
    /// Drop every cache entry of one state key (an account was removed).
    fn prune_key(&mut self, key: &str) -> bool {
        self.last_probe.remove(key);
        self.last_broadcast.remove(key);
        self.last_turn_probe.remove(key);
        self.fail_count.remove(key);
        self.backoff_until.remove(key);
        self.in_flight.remove(key);
        self.announced.remove(key);
        self.results.remove(key).is_some()
    }
}

struct Inner {
    state: Mutex<State>,
    broadcaster: Broadcaster,
    targets: TargetsFn,
    probe: ProbeFn,
    session_target: SessionTargetFn,
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
                announced: HashSet::new(),
            }),
            broadcaster: deps.broadcaster,
            targets: deps.targets,
            probe: deps.probe,
            session_target: deps.session_target,
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
            targets: Arc::new(Vec::new),
            probe: Arc::new(|_| Box::pin(async { LimitsResult::unsupported("", "") })),
            session_target: Arc::new(|_| Box::pin(async { None })),
            host,
            initial_slots: vst_types::limits::default_slots(),
            timing: LimitsTiming::default(),
        })
    }

    /// Late-bind the live-client counter. A second bind is silently ignored.
    pub fn bind_client_counter(&self, f: ClientCountFn) {
        let _ = self.inner.client_counter.set(f);
    }

    /// The current snapshot: harnesses sorted by state key, excluding
    /// `Unsupported`. Within one harness the System result sorts before every
    /// account result (`<harness>` < `<harness>#<account>`), so old clients doing
    /// `results.find(harness)` still get the System login.
    pub fn snapshot(&self) -> LimitsSnapshot {
        self.inner.snapshot()
    }

    /// Client connected/fetched: probe every target whose last probe is stale
    /// (any client count), else serve the cache.
    pub fn note_client_fetch(&self) {
        let now = Instant::now();
        let stale: Vec<ProbeTarget> = {
            let st = self.inner.state.lock().unwrap();
            self.inner
                .targets()
                .into_iter()
                .filter(|t| {
                    !st.unsupported.contains(&t.harness)
                        && crate::policy::is_stale(
                            st.last_probe.get(&t.key()).copied(),
                            now,
                            self.inner.timing.stale_after,
                        )
                })
                .collect()
        };
        for target in stale {
            let inner = self.inner.clone();
            tokio::spawn(probe_one(inner, target, Trigger::Fetch));
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
            .targets()
            .into_iter()
            .map(|target| tokio::spawn(probe_one(inner.clone(), target, Trigger::Manual)))
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
                            for target in inner.targets() {
                                tokio::spawn(probe_one(inner.clone(), target, Trigger::Interval));
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
                                    let target = (inner.session_target)(session_id).await;
                                    if let Some(target) = target {
                                        if !inner.is_unsupported(&target.harness) {
                                            let key = target.key();
                                            let now = Instant::now();
                                            let ok = {
                                                let mut st = inner.state.lock().unwrap();
                                                if debounce_ok(st.last_turn_probe.get(&key).copied(), now, inner.timing.turn_debounce) {
                                                    st.last_turn_probe.insert(key, now);
                                                    true
                                                } else {
                                                    false
                                                }
                                            };
                                            if ok {
                                                tokio::spawn(probe_one(inner.clone(), target, Trigger::Turn));
                                            }
                                        }
                                    }
                                }
                            }
                            Ok(ServerEvent::SessionDeleted { session_id }) => {
                                inner.state.lock().unwrap().last_states.remove(&session_id);
                            }
                            // An account was removed: its cached results are
                            // gone, so prune the key and rebroadcast (Decision 9).
                            Ok(ServerEvent::AccountRemoved { cli, account_id }) => {
                                let key = ProbeTarget {
                                    harness: cli,
                                    account_id: Some(account_id),
                                }
                                .key();
                                // Always rebroadcast: a pinned account with no
                                // result yet must also update the footer.
                                inner.state.lock().unwrap().prune_key(&key);
                                let snapshot = inner.snapshot();
                                inner.broadcaster.send(ServerEvent::LimitsUpdated {
                                    limits: snapshot,
                                });
                            }
                            // A newly usable account: probe it now instead of
                            // waiting for the next interval tick. Only the first
                            // event probes (a rename or default change finds the
                            // key already probed or in flight).
                            Ok(ServerEvent::AccountUpdated { account }) => {
                                if !account.pending && account.id != SYSTEM_ACCOUNT_ID {
                                    let target = ProbeTarget {
                                        harness: account.cli,
                                        account_id: Some(account.id),
                                    };
                                    let key = target.key();
                                    let fresh = {
                                        let mut st = inner.state.lock().unwrap();
                                        !st.unsupported.contains(&target.harness)
                                            && !st.last_probe.contains_key(&key)
                                            && !st.in_flight.contains(&key)
                                            && st.announced.insert(key)
                                    };
                                    if fresh {
                                        tokio::spawn(probe_one(inner.clone(), target, Trigger::Fetch));
                                    }
                                }
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

/// A pinned slot whose account is no longer a probe target is served as that
/// harness's System login; the stored slot is never rewritten, so a pin comes
/// back by itself if its account becomes a target again.
fn live_slot(slot: &LimitSlotRef, targets: &[ProbeTarget]) -> LimitSlotRef {
    let mut out = slot.clone();
    if let Some(id) = &slot.account_id {
        let live = targets
            .iter()
            .any(|t| t.harness == slot.harness && t.account_id.as_deref() == Some(id.as_str()));
        if !live {
            out.account_id = None;
        }
    }
    out
}

impl Inner {
    fn targets(&self) -> Vec<ProbeTarget> {
        (self.targets)()
    }

    fn is_unsupported(&self, harness: &str) -> bool {
        self.state.lock().unwrap().unsupported.contains(harness)
    }

    fn client_count(&self) -> usize {
        self.client_counter.get().map(|f| f()).unwrap_or(0)
    }

    fn snapshot(&self) -> LimitsSnapshot {
        // Read the targets BEFORE the state lock (the closure takes its own locks).
        let targets = self.targets();
        let st = self.state.lock().unwrap();
        let harnesses: Vec<LimitsResult> = st
            .results
            .values()
            .filter(|r| r.status != LimitStatus::Unsupported)
            .cloned()
            .collect();
        LimitsSnapshot {
            host: self.host.clone(),
            slots: [
                live_slot(&st.slots[0], &targets),
                live_slot(&st.slots[1], &targets),
            ],
            harnesses,
        }
    }

    fn apply_result(&self, target: &ProbeTarget, result: LimitsResult) {
        let key = target.key();
        if result.status == LimitStatus::Unsupported {
            let mut st = self.state.lock().unwrap();
            st.in_flight.remove(&key);
            // Unsupported is a HARNESS fact: every account of it is skipped.
            st.unsupported.insert(target.harness.clone());
            return;
        }
        let now = Instant::now();
        let should_broadcast = {
            let mut st = self.state.lock().unwrap();
            st.in_flight.remove(&key);

            let fail = st.fail_count.entry(key.clone()).or_insert(0);
            if result.status == LimitStatus::Error {
                *fail += 1;
                let delay =
                    backoff_delay(*fail, self.timing.backoff_initial, self.timing.backoff_cap);
                st.backoff_until.insert(key.clone(), now + delay);
            } else {
                *fail = 0;
                st.backoff_until.remove(&key);
            }
            st.last_probe.insert(key.clone(), now);

            let prev = st.results.get(&key).cloned();
            let merged = merge_result(prev.as_ref(), result);
            let changed = match &prev {
                Some(p) => !results_equivalent(p, &merged),
                None => true,
            };
            let fresh = st.last_broadcast.get(&key).map_or(true, |t| {
                now.duration_since(*t) >= self.timing.rebroadcast_after
            });
            let should_broadcast = changed || fresh;
            if should_broadcast {
                st.last_broadcast.insert(key.clone(), now);
            }
            st.results.insert(key, merged);
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

fn error_result(target: &ProbeTarget, message: &str) -> LimitsResult {
    LimitsResult::failure(
        &target.harness,
        LimitStatus::Error,
        message,
        &now_iso(),
        &[],
    )
    .with_account(target.account_id.clone())
}

/// Run one probe under a timeout, applying its result. Guards: skips when the
/// harness is unsupported or the target is already in flight; skips on backoff
/// unless the trigger is Manual. Never holds the state lock across an await.
async fn probe_one(inner: Arc<Inner>, target: ProbeTarget, trigger: Trigger) {
    let key = target.key();
    {
        let mut st = inner.state.lock().unwrap();
        if st.unsupported.contains(&target.harness) || st.in_flight.contains(&key) {
            return;
        }
        if !trigger.ignores_backoff()
            && st
                .backoff_until
                .get(&key)
                .is_some_and(|t| Instant::now() < *t)
        {
            return;
        }
        st.in_flight.insert(key.clone());
    }

    let probe = inner.probe.clone();
    let probed = target.clone();

    // Run the probe in its own task so a panic cannot leave `in_flight` set (the
    // result is always applied below, which clears it) or poison the state lock.
    let probe_timeout = inner.timing.probe_timeout;
    let joined =
        tokio::spawn(async move { tokio::time::timeout(probe_timeout, probe(probed)).await }).await;
    let result = match joined {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => error_result(&target, "probe timed out"),
        Err(_) => error_result(&target, "probe task failed"),
    };

    debug!(
        harness = %target.harness,
        account = target.account_id.as_deref().unwrap_or("system"),
        status = ?result.status,
        "harness limits probe finished"
    );
    inner.apply_result(&target, result);
}
