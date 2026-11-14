//! `vst-diffstat` — the daemon-side, event-driven worktree diffstat cache
//! (plan `poller-redesign` Decisions 4–6, Requirements 9–13).
//!
//! Replaces the web client's 30 s per-worktree `GET /worktrees/:id/diffstat`
//! polling. One [`DiffStatPollerHandle`] owns:
//!
//! - a [`Coalescer<String>`] keyed by worktree id (2 s debounce, fixed 5 s
//!   per-worktree spacing, 5 s starvation bound),
//! - an in-memory cache of [`DiffStatEntry`]s (`rev` monotonic per worktree),
//! - the worktree/session index it needs to turn events into worktree ids.
//!
//! Triggers (Decision 6/11): `session:activity` (Rich Chat `record_tool` and
//! the terminal poller's `record`), `session:state` → idle/waiting_for_human,
//! worktree created / branch changed, tree:watch change hook
//! (the opened worktree's existing `tree:watch` closure — NO new watchers),
//! [`DiffStatPollerHandle::hint_focus`] (client focus), `snapshot()` (client
//! connect) and a staggered sweep (one worktree per `max(1 s, 300 s / N)`).
//!
//! Gate (Requirement 13): compute only while a WS client is connected, plus a
//! 60 s grace after the last disconnect. With zero clients events only mark
//! entries dirty; the backlog drains on the first connect, most-recently-active
//! first (activity marks carry the trigger's unix-ms as priority, boot marks 0).
//!
//! Pacing (Decision 6): at most [`DIFFSTAT_IN_FLIGHT`] compute tasks at once, so
//! two of the four global short git permits stay available for user-facing
//! routes.

pub mod compute;
pub mod head;

pub use compute::{
    git_file_stamp, ComputeInput, ComputeOutcome, DiffStatComputer, GitFileStamp, BROKEN_HINT,
};

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};
use vst_git::Paths;
use vst_store::StoreHandle;
use vst_types::coalescer::{Coalescer, CoalescerConfig, MarkOpts};
use vst_types::domain::LifecycleState;
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::rest::worktrees::{DiffStatEntry, DiffStatState, DiffStatsSnapshot};

/// Default quiet period after a trigger (Decision 6).
pub const DIFFSTAT_DEBOUNCE_MS: u64 = 2_000;
/// Fixed minimum spacing between the START of two computes for one worktree.
pub const DIFFSTAT_MIN_SPACING_MS: u64 = 5_000;
/// Upper bound on how long a continuously re-triggered worktree may stay dirty.
pub const DIFFSTAT_MAX_WAIT_MS: u64 = 5_000;
/// Target length of one full sweep cycle.
pub const DIFFSTAT_SWEEP_SECS: u64 = 300;
/// Grace period after the last WS client disconnects.
pub const DIFFSTAT_CLIENT_GRACE_SECS: u64 = 60;
/// Concurrent compute tasks (leaves 2 of the 4 global short git permits for
/// user-facing routes).
pub const DIFFSTAT_IN_FLIGHT: usize = 2;

/// A boxed, `Send` future — the shape of the injectable compute seam.
pub type BoxFuture<'a, T> = Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

/// Injectable compute (tests replace it with a fake).
pub type ComputeFn = Arc<dyn Fn(ComputeInput) -> BoxFuture<'static, ComputeOutcome> + Send + Sync>;

/// Injectable WS-client count (wired to the hub from `run.rs`/`build_state`).
pub type ClientCountFn = Arc<dyn Fn() -> usize + Send + Sync>;

/// The sweep period for `worktrees` known worktrees: `max(1 s, 300 s / N)`, so
/// one full cycle is ≈[`DIFFSTAT_SWEEP_SECS`] for up to 300 worktrees.
#[must_use]
pub fn sweep_period_for(worktrees: usize) -> Duration {
    let full = Duration::from_secs(DIFFSTAT_SWEEP_SECS);
    if worktrees == 0 {
        return full;
    }
    let n = u32::try_from(worktrees).unwrap_or(u32::MAX);
    (full / n).max(Duration::from_secs(1))
}

/// One cached worktree diffstat plus poller bookkeeping.
#[derive(Clone, Debug)]
struct CachedEntry {
    insertions: u64,
    deletions: u64,
    state: DiffStatState,
    rev: u64,
    hint: Option<String>,
    /// `None` = never computed (a `snapshot()` marks it dirty).
    computed_at: Option<Instant>,
    /// `.git` stamp captured when `state == Broken`.
    broken_stamp: Option<GitFileStamp>,
}

impl CachedEntry {
    fn empty() -> Self {
        Self {
            insertions: 0,
            deletions: 0,
            state: DiffStatState::Unknown,
            rev: 0,
            hint: None,
            computed_at: None,
            broken_stamp: None,
        }
    }

    fn to_entry(&self) -> DiffStatEntry {
        DiffStatEntry {
            insertions: self.insertions,
            deletions: self.deletions,
            state: self.state,
            rev: self.rev,
            hint: self.hint.clone(),
        }
    }
}

/// Everything the poller needs about one worktree (from the store).
#[derive(Clone, Debug)]
struct WorktreeMeta {
    project_id: String,
    /// The owning project's main repo path (the background base fetch runs there).
    repo_path: String,
    branch: String,
    base_branch: String,
    base_sha: String,
}

/// Incrementally maintained worktree / session index.
#[derive(Default)]
struct Index {
    worktrees: HashMap<String, WorktreeMeta>,
    /// session id → worktree id (worktree sessions only).
    sessions: HashMap<String, String>,
}

/// Client-gate bookkeeping.
#[derive(Default)]
struct Gate {
    previous_clients: usize,
    /// Set when the client count drops to zero after having been non-zero.
    last_zero_at: Option<Instant>,
}

/// Handle to the diffstat poller.
#[derive(Clone)]
pub struct DiffStatPollerHandle {
    store: StoreHandle,
    broadcaster: Broadcaster,
    paths: Paths,
    coalescer: Arc<Mutex<Coalescer<String>>>,
    notify: Arc<Notify>,
    cache: Arc<Mutex<HashMap<String, CachedEntry>>>,
    index: Arc<Mutex<Index>>,
    gate: Arc<Mutex<Gate>>,
    /// Every id ever marked — the coalescer has no key enumeration, so
    /// eviction iterates this set instead.
    tracked: Arc<Mutex<HashSet<String>>>,
    client_count: ClientCountFn,
    compute: ComputeFn,
    /// Background `origin/<base>` refresh seam (production: bounded `git fetch`).
    fetch: head::FetchFn,
    /// Per-worktree head/base tracker (`worktree:head` single writer).
    heads: Arc<Mutex<HashMap<String, head::HeadState>>>,
    /// The production computer, kept so eviction can reach its per-worktree
    /// choice cache. `None` when the compute seam was replaced.
    computer: Option<Arc<DiffStatComputer>>,
    compute_permits: Arc<Semaphore>,
    sweep_cursor: Arc<Mutex<usize>>,
    store_refreshes: Arc<AtomicUsize>,
}

impl DiffStatPollerHandle {
    /// Build the production poller (real git via `vst-git`, real store).
    #[must_use]
    pub fn new(store: StoreHandle, broadcaster: Broadcaster, paths: Paths) -> Self {
        let computer = Arc::new(DiffStatComputer::new());
        let compute: ComputeFn = {
            let computer = computer.clone();
            Arc::new(move |input| {
                let computer = computer.clone();
                Box::pin(async move { computer.compute(&input).await })
            })
        };
        Self {
            store,
            broadcaster,
            paths,
            coalescer: Arc::new(Mutex::new(Coalescer::new(CoalescerConfig {
                debounce: Duration::from_millis(DIFFSTAT_DEBOUNCE_MS),
                min_spacing: Duration::from_millis(DIFFSTAT_MIN_SPACING_MS),
                max_wait: Duration::from_millis(DIFFSTAT_MAX_WAIT_MS),
            }))),
            notify: Arc::new(Notify::new()),
            cache: Arc::new(Mutex::new(HashMap::new())),
            index: Arc::new(Mutex::new(Index::default())),
            gate: Arc::new(Mutex::new(Gate::default())),
            tracked: Arc::new(Mutex::new(HashSet::new())),
            // Safe default: no observer bound ⇒ the gate stays closed until
            // the hub wires the live connection count.
            client_count: Arc::new(|| 0),
            compute,
            fetch: head::production_fetch(),
            heads: Arc::new(Mutex::new(HashMap::new())),
            computer: Some(computer),
            compute_permits: Arc::new(Semaphore::new(DIFFSTAT_IN_FLIGHT)),
            sweep_cursor: Arc::new(Mutex::new(0)),
            store_refreshes: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Number of times the index was refreshed from the store (diagnostics/tests).
    #[must_use]
    pub fn store_refreshes(&self) -> usize {
        self.store_refreshes.load(Ordering::Relaxed)
    }

    /// Bind the live WS-client count.
    #[must_use]
    pub fn with_client_count(mut self, count: ClientCountFn) -> Self {
        self.client_count = count;
        self
    }

    /// Replace the compute seam (tests). The background base fetch is also
    /// replaced by an inert seam so a test never spawns `git`; chain
    /// [`Self::with_fetch`] after this to script the fetch.
    #[must_use]
    pub fn with_compute(mut self, compute: ComputeFn) -> Self {
        self.compute = compute;
        self.computer = None;
        self.fetch = head::inert_fetch();
        self
    }

    /// Replace the background base-fetch seam (tests).
    #[must_use]
    pub fn with_fetch(mut self, fetch: head::FetchFn) -> Self {
        self.fetch = fetch;
        self
    }

    /// Use a specific computer (tests that need to inspect its caches).
    #[doc(hidden)]
    #[must_use]
    pub fn with_computer(mut self, computer: Arc<DiffStatComputer>) -> Self {
        let for_compute = computer.clone();
        self.compute = Arc::new(move |input| {
            let computer = for_compute.clone();
            Box::pin(async move { computer.compute(&input).await })
        });
        self.computer = Some(computer);
        self
    }

    /// The hub's connection observer calls this on every connect/disconnect
    /// with the NEW count.
    pub fn note_clients_changed(&self, count: usize) {
        {
            let mut gate = self.gate.lock().unwrap();
            if count == 0 && gate.previous_clients > 0 {
                gate.last_zero_at = Some(now());
            }
            if count > 0 {
                gate.last_zero_at = None;
            }
            gate.previous_clients = count;
        }
        self.notify.notify_one();
    }

    /// Mark one worktree dirty (default debounce, priority = trigger time so the
    /// most recently active worktree drains first).
    pub fn mark_dirty(&self, worktree_id: &str) {
        self.mark(
            worktree_id,
            MarkOpts {
                debounce: None,
                priority: unix_ms_now(),
            },
        );
    }

    /// Client focus hint: the user opened this worktree, so it goes first.
    pub fn hint_focus(&self, worktree_id: &str) {
        // Zero debounce (the spacing floor still applies) so already-due
        // backlog keys do not beat a key that would otherwise be 2 s out.
        self.mark(
            worktree_id,
            MarkOpts {
                debounce: Some(Duration::ZERO),
                priority: u64::MAX,
            },
        );
    }

    /// Forget everything about one worktree (eviction).
    pub fn forget(&self, worktree_id: &str) {
        if let Ok(mut coalescer) = self.coalescer.lock() {
            coalescer.remove(&worktree_id.to_string());
        }
        // Index BEFORE cache: `apply` checks the index under the cache lock,
        // so a compute finishing after this point cannot re-insert.
        if let Ok(mut index) = self.index.lock() {
            index.worktrees.remove(worktree_id);
            index.sessions.retain(|_, wt| wt != worktree_id);
        }
        if let Ok(mut cache) = self.cache.lock() {
            cache.remove(worktree_id);
        }
        if let Ok(mut tracked) = self.tracked.lock() {
            tracked.remove(worktree_id);
        }
        // After the index removal: `observe_head` checks the index under the
        // heads lock, so it cannot re-create this entry afterwards.
        if let Ok(mut heads) = self.heads.lock() {
            heads.remove(worktree_id);
        }
        if let Some(computer) = &self.computer {
            computer.forget(worktree_id);
        }
    }

    /// The cached snapshot for `GET /worktrees/diffstats`.
    ///
    /// Never computes inline: it marks every never-computed entry and every
    /// entry older than one sweep period dirty, then returns the cache.
    pub async fn snapshot(&self) -> DiffStatsSnapshot {
        self.refresh_from_store().await;
        let now = now();
        let ids: Vec<String> = self
            .index
            .lock()
            .map(|index| index.worktrees.keys().cloned().collect())
            .unwrap_or_default();
        for id in ids {
            let stale = self
                .cache
                .lock()
                .map(|cache| {
                    cache.get(&id).map_or(true, |entry| {
                        entry.computed_at.map_or(true, |at| {
                            now.saturating_duration_since(at)
                                >= Duration::from_secs(DIFFSTAT_SWEEP_SECS)
                        })
                    })
                })
                .unwrap_or(true);
            if stale {
                self.mark(
                    &id,
                    MarkOpts {
                        debounce: None,
                        priority: 0,
                    },
                );
            }
        }
        let mut stats: HashMap<String, DiffStatEntry> = self
            .cache
            .lock()
            .map(|cache| {
                cache
                    .iter()
                    .map(|(id, entry)| (id.clone(), entry.to_entry()))
                    .collect()
            })
            .unwrap_or_default();
        // A known worktree with no value yet is a visible `unknown` (rev 0),
        // never a blank. Only the returned map carries it: `cache` stays
        // empty for it so the first real result always broadcasts.
        if let Ok(index) = self.index.lock() {
            for id in index.worktrees.keys() {
                stats.entry(id.clone()).or_insert(DiffStatEntry {
                    insertions: 0,
                    deletions: 0,
                    state: DiffStatState::Unknown,
                    rev: 0,
                    hint: None,
                });
            }
        }
        DiffStatsSnapshot { stats }
    }

    /// The poller's in-flight worktree ids (diagnostics/tests).
    #[must_use]
    pub fn has_pending(&self, worktree_id: &str) -> bool {
        self.coalescer
            .lock()
            .map(|coalescer| coalescer.contains(&worktree_id.to_string()))
            .unwrap_or(false)
    }

    /// Start the poller: ONE task that selects over the broadcaster subscriber,
    /// the coalescer driver and the sweep timer, so one abort stops all.
    pub fn start(self: Arc<Self>) -> tokio::task::JoinHandle<()> {
        // Subscribe before spawning so an event sent right after `start`
        // returns is not missed (same shape as `PrPollerHandle::start`).
        let mut rx = self.broadcaster.subscribe();
        tokio::spawn(async move {
            self.refresh_from_store().await;
            self.mark_backlog();
            let mut sweep_at = tokio::time::Instant::now() + self.sweep_period();
            loop {
                // Drain everything due right now, if the gate is open. Taking
                // keys while gated would strand them in-flight.
                // The permit is acquired HERE, in the driver, and only as many
                // keys as there are free permits are taken: a backlog stays
                // in the coalescer (priority-ordered, focus-able) instead of
                // queueing on the semaphore.
                if self.gate_open() {
                    let free = self.compute_permits.available_permits();
                    for worktree_id in self.take_ready_limited(free) {
                        match self.compute_permits.clone().try_acquire_owned() {
                            Ok(permit) => self.spawn_compute(worktree_id, permit),
                            Err(_) => self.requeue(&worktree_id), // defensive
                        }
                    }
                }
                let next_due = if self.gate_open() && self.compute_permits.available_permits() > 0 {
                    self.next_due()
                } else {
                    // A free permit wakes us via `ComputeGuard`'s notify;
                    // never spin on a past-due key while all permits are busy.
                    None
                };
                let due = async {
                    match next_due {
                        Some(due) => {
                            tokio::time::sleep_until(tokio::time::Instant::from_std(due)).await;
                        }
                        None => std::future::pending::<()>().await,
                    }
                };
                tokio::select! {
                    // Consume the sweep first so a sweep mark landing on the same
                    // instant as a coalescer due time collapses into one run.
                    biased;
                    _ = tokio::time::sleep_until(sweep_at) => {
                        // Paused while gated (no clients): no store clone.
                        if self.gate_open() {
                            self.sweep_once().await;
                        }
                        sweep_at = tokio::time::Instant::now() + self.sweep_period();
                    }
                    _ = self.notify.notified() => {}
                    _ = due => {}
                    received = rx.recv() => match received {
                        Ok(event) => self.handle_event(event).await,
                        // A lagged receiver may have missed triggers: mark the
                        // whole backlog dirty at low priority and continue.
                        Err(RecvError::Lagged(_)) => self.mark_backlog(),
                        Err(RecvError::Closed) => break,
                    },
                }
            }
        })
    }

    /// One sweep step: mark ONE worktree dirty round-robin from the cached index
    /// (refreshing from store only if empty, and skipping a `broken` one whose
    /// `.git` has not changed). Public so tests can drive it without waiting.
    pub async fn sweep_once(&self) {
        if self.is_index_empty() {
            self.refresh_from_store().await;
        }
        if !self.gate_open() {
            return;
        }
        let mut ids: Vec<String> = self
            .index
            .lock()
            .map(|index| index.worktrees.keys().cloned().collect())
            .unwrap_or_default();
        ids.sort();
        if ids.is_empty() {
            return;
        }
        let len = ids.len();
        let mut cursor = self.sweep_cursor.lock().unwrap();
        let start = *cursor % len;
        for offset in 0..len {
            let idx = (start + offset) % len;
            let id = ids[idx].clone();
            if self.broken_unchanged(&id) {
                continue;
            }
            *cursor = (idx + 1) % len;
            self.mark(
                &id,
                MarkOpts {
                    debounce: None,
                    priority: 0,
                },
            );
            return;
        }
        *cursor = (start + 1) % len;
    }

    fn gate_open(&self) -> bool {
        if (self.client_count)() > 0 {
            return true;
        }
        self.gate.lock().is_ok_and(|gate| {
            gate.last_zero_at.is_some_and(|at| {
                now().saturating_duration_since(at)
                    < Duration::from_secs(DIFFSTAT_CLIENT_GRACE_SECS)
            })
        })
    }

    fn sweep_period(&self) -> Duration {
        sweep_period_for(self.index.lock().map_or(0, |index| index.worktrees.len()))
    }

    fn mark(&self, worktree_id: &str, opts: MarkOpts) {
        if let Ok(mut tracked) = self.tracked.lock() {
            tracked.insert(worktree_id.to_string());
        }
        if let Ok(mut coalescer) = self.coalescer.lock() {
            coalescer.mark_dirty(worktree_id.to_string(), now(), opts);
        }
        self.notify.notify_one();
    }

    /// Boot / lagged-receiver backlog: everything known, lowest priority.
    fn mark_backlog(&self) {
        let ids: Vec<String> = self
            .index
            .lock()
            .map(|index| index.worktrees.keys().cloned().collect())
            .unwrap_or_default();
        for id in ids {
            self.mark(
                &id,
                MarkOpts {
                    debounce: None,
                    priority: 0,
                },
            );
        }
    }

    fn take_ready_limited(&self, limit: usize) -> Vec<String> {
        self.coalescer
            .lock()
            .map(|mut coalescer| coalescer.take_ready_limited(now(), limit))
            .unwrap_or_default()
    }

    /// Give back a key that was taken but could not start: settle it and mark
    /// it dirty again so it is not stranded in flight.
    fn requeue(&self, worktree_id: &str) {
        if let Ok(mut coalescer) = self.coalescer.lock() {
            coalescer.finish(&worktree_id.to_string(), now());
        }
        self.mark(
            worktree_id,
            MarkOpts {
                debounce: None,
                priority: 0,
            },
        );
    }

    fn next_due(&self) -> Option<Instant> {
        self.coalescer
            .lock()
            .ok()
            .and_then(|coalescer| coalescer.next_due())
    }

    fn meta(&self, worktree_id: &str) -> Option<WorktreeMeta> {
        self.index
            .lock()
            .ok()
            .and_then(|index| index.worktrees.get(worktree_id).cloned())
    }

    fn worktree_path(&self, worktree_id: &str) -> Option<PathBuf> {
        self.meta(worktree_id)
            .map(|meta| self.paths.worktree_path(&meta.project_id, worktree_id))
    }

    /// True when the worktree is `broken` and its `.git` stamp has not moved.
    fn broken_unchanged(&self, worktree_id: &str) -> bool {
        let cached = self
            .cache
            .lock()
            .ok()
            .and_then(|cache| cache.get(worktree_id).cloned());
        let Some(entry) = cached else {
            return false;
        };
        if entry.state != DiffStatState::Broken {
            return false;
        }
        let Some(path) = self.worktree_path(worktree_id) else {
            return false;
        };
        git_file_stamp(&path) == entry.broken_stamp
    }

    fn spawn_compute(&self, worktree_id: String, permit: OwnedSemaphorePermit) {
        let this = self.clone();
        tokio::spawn(async move {
            // Created FIRST so every early return still calls
            // `Coalescer::finish` (the key was taken as in-flight).
            let _finish = ComputeGuard {
                coalescer: this.coalescer.clone(),
                notify: this.notify.clone(),
                key: worktree_id.clone(),
            };
            // The driver already acquired the permit (at most
            // DIFFSTAT_IN_FLIGHT computes). Declared AFTER `_finish` so it
            // drops BEFORE the guard notifies the driver.
            let permit = permit;
            let Some(meta) = this.meta(&worktree_id) else {
                return;
            };
            let path = this.paths.worktree_path(&meta.project_id, &worktree_id);
            if this.broken_unchanged(&worktree_id) {
                return;
            }
            let input = ComputeInput {
                worktree_id: worktree_id.clone(),
                path: path.clone(),
                base_branch: meta.base_branch.clone(),
                base_sha: meta.base_sha,
            };
            let outcome = (this.compute)(input).await;
            drop(permit);
            this.apply(&worktree_id, outcome);
            this.observe_head(&worktree_id, &path, &meta.base_branch, &meta.repo_path);
        });
    }

    /// Store one compute result; broadcast only on a real change.
    fn apply(&self, worktree_id: &str, outcome: ComputeOutcome) {
        let now_ms = unix_ms_now();
        let Ok(mut cache) = self.cache.lock() else {
            return;
        };
        // A compute that finished after `forget`/eviction must not resurrect
        // the entry or broadcast for a deleted worktree.
        if !self
            .index
            .lock()
            .is_ok_and(|index| index.worktrees.contains_key(worktree_id))
        {
            return;
        }
        let existing = cache.get(worktree_id).cloned();
        let mut next = existing.clone().unwrap_or_else(CachedEntry::empty);

        if outcome.state == DiffStatState::Unknown {
            // Transient failure: keep the last-known value (whatever it was)
            // and broadcast nothing. `unknown` is only visible when there has
            // never been a value for this worktree.
            if existing.is_some() {
                next.computed_at = Some(now());
                cache.insert(worktree_id.to_string(), next);
                return;
            }
        }

        next.insertions = outcome.insertions;
        next.deletions = outcome.deletions;
        next.state = outcome.state;
        next.hint = outcome.hint;
        next.computed_at = Some(now());
        next.broken_stamp = if outcome.state == DiffStatState::Broken {
            outcome.stamp
        } else {
            None
        };

        let changed = existing.as_ref().map_or(true, |entry| {
            entry.insertions != next.insertions
                || entry.deletions != next.deletions
                || entry.state != next.state
                || entry.hint != next.hint
        });
        let previous_rev = existing.as_ref().map_or(0, |entry| entry.rev);
        if changed {
            // `rev = max(prev + 1, unix_ms_now)` — monotonic and restart-safe.
            next.rev = previous_rev.saturating_add(1).max(now_ms);
        } else {
            next.rev = previous_rev;
        }
        cache.insert(worktree_id.to_string(), next.clone());
        drop(cache);

        if changed {
            self.broadcaster.send(ServerEvent::WorktreeDiffStat {
                worktree_id: worktree_id.to_string(),
                insertions: next.insertions,
                deletions: next.deletions,
                state: next.state,
                rev: next.rev,
                hint: next.hint,
            });
        }
    }

    fn is_index_empty(&self) -> bool {
        self.index
            .lock()
            .map_or(true, |index| index.worktrees.is_empty())
    }

    /// Rebuild the worktree/session index from the store and evict every cached
    /// entry whose worktree disappeared (deleted, hidden, or absent).
    async fn refresh_from_store(&self) {
        self.store_refreshes.fetch_add(1, Ordering::Relaxed);
        let projects = self.store.get_all_projects().await;
        {
            let Ok(mut index) = self.index.lock() else {
                return;
            };
            index.worktrees.clear();
            index.sessions.clear();
            for project in &projects {
                for worktree in &project.worktrees {
                    if worktree.hidden_at.is_some() {
                        continue;
                    }
                    index.worktrees.insert(
                        worktree.id.clone(),
                        WorktreeMeta {
                            project_id: project.id.clone(),
                            repo_path: project.absolute_path.clone(),
                            branch: worktree.branch.clone(),
                            base_branch: worktree.base_branch.clone(),
                            base_sha: worktree.base_sha.clone(),
                        },
                    );
                    for session in &worktree.sessions {
                        index
                            .sessions
                            .insert(session.id.clone(), worktree.id.clone());
                    }
                }
            }
        }
        self.evict_absent();
    }

    fn evict_absent(&self) {
        let known: HashSet<String> = self
            .index
            .lock()
            .map(|index| index.worktrees.keys().cloned().collect())
            .unwrap_or_default();
        let stale: Vec<String> = self
            .tracked
            .lock()
            .map(|tracked| {
                tracked
                    .iter()
                    .filter(|id| !known.contains(*id))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        for id in stale {
            self.forget(&id);
        }
        if let Ok(mut cache) = self.cache.lock() {
            cache.retain(|id, _| known.contains(id));
        }
        if let Some(computer) = &self.computer {
            computer.retain(&known);
        }
    }

    /// Map one broadcaster event onto the poller's triggers.
    async fn handle_event(&self, event: ServerEvent) {
        match event {
            ServerEvent::SessionActivity { session_id, .. }
            | ServerEvent::SessionState {
                session_id,
                state: LifecycleState::Idle | LifecycleState::WaitingForHuman,
                ..
            } => {
                self.mark_session_dirty(&session_id).await;
            }
            ServerEvent::SessionCreated { worktree_id, .. } => {
                self.refresh_from_store().await;
                if let Some(worktree_id) = worktree_id {
                    self.mark_dirty(&worktree_id);
                }
            }
            ServerEvent::ProjectCreated { .. } | ServerEvent::ProjectDeleted { .. } => {
                self.refresh_from_store().await;
            }
            ServerEvent::WorktreeCreated { worktree } => {
                let id = event_worktree_id(&worktree);
                self.refresh_from_store().await;
                if let Some(id) = id {
                    self.mark_dirty(&id);
                }
            }
            ServerEvent::WorktreeUpdated { worktree } => {
                let id = event_worktree_id(&worktree);
                let previous = id
                    .as_deref()
                    .and_then(|id| self.meta(id))
                    .map(|meta| (meta.branch, meta.base_branch));
                self.refresh_from_store().await;
                if let Some(id) = id {
                    let Some(meta) = self.meta(&id) else {
                        return; // hidden/deleted — refresh already evicted it
                    };
                    let current = (meta.branch, meta.base_branch);
                    if previous.as_ref() != Some(&current) {
                        self.mark_dirty(&id);
                    }
                }
            }
            ServerEvent::WorktreeDeleted { worktree_id } => {
                self.refresh_from_store().await;
                self.forget(&worktree_id);
            }
            _ => {}
        }
    }

    async fn mark_session_dirty(&self, session_id: &str) {
        let worktree_id = self
            .index
            .lock()
            .ok()
            .and_then(|index| index.sessions.get(session_id).cloned());
        let worktree_id = match worktree_id {
            Some(id) => Some(id),
            None => self
                .store
                .find_session(session_id)
                .await
                .and_then(|(_, session)| session.worktree_id),
        };
        let Some(worktree_id) = worktree_id else {
            return;
        };
        if let Ok(mut index) = self.index.lock() {
            index
                .sessions
                .insert(session_id.to_string(), worktree_id.clone());
        }
        self.mark_dirty(&worktree_id);
    }
}

/// Calls [`Coalescer::finish`] when a compute task ends — including on an early
/// return — and wakes the driver so a trailing run is not stranded.
struct ComputeGuard {
    coalescer: Arc<Mutex<Coalescer<String>>>,
    notify: Arc<Notify>,
    key: String,
}

impl Drop for ComputeGuard {
    fn drop(&mut self) {
        if let Ok(mut coalescer) = self.coalescer.lock() {
            coalescer.finish(&self.key, now());
        }
        self.notify.notify_one();
    }
}

fn event_worktree_id(worktree: &serde_json::Map<String, serde_json::Value>) -> Option<String> {
    worktree
        .get("id")
        .and_then(|value| value.as_str())
        .map(str::to_string)
}

/// The poller's clock. Uses tokio's clock so paused-time tests drive the same
/// instants the coalescer sees (plan "Test clock rule").
fn now() -> Instant {
    tokio::time::Instant::now().into_std()
}

fn unix_ms_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}
