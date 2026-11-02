//! Event-driven, batched PR-status poller (plan `poller-redesign`, Decisions 2–3).
//!
//! **Two-axis model** (Gotcha #3): this module is the **sole writer** of the
//! `pr` field on a session. The setter is fully private — restricted to this
//! module only — so the compiler prevents lifecycle.rs (or any other module)
//! from calling it.
//!
//! Behaviour contract:
//! - ONE global [`Coalescer`] key (`()`): every trigger marks the same key, so
//!   a burst of events collapses into one batched run.
//! - Debounce 2 s (1 s for a client focus hint), fixed 5 s starvation bound,
//!   and a **20 s minimum spacing** between the starts of two runs.
//! - A fixed 45 s tick marks dirty with zero debounce (the spacing floor still
//!   applies) — GitHub cannot push to a local daemon, so remote-only changes
//!   need a timer; one cheap request per account covers every project.
//! - One run = collect every main-session `(owner/repo, branch)` across all
//!   projects (skipping `drafting` sessions) → remote classes (cached per
//!   project, 10 min TTL) → accounts (`AccountCache`, 10 min TTL) → ONE
//!   batched [`fetch_all`] → apply. The fetch phase is bounded by a 50 s budget; the apply phase (store write + broadcast) always runs to completion.
//! - Triggers: `worktree:created`/`worktree:updated`/`session:created`,
//!   `session:state` → idle/waiting_for_human, `project:updated` (drops that
//!   project's remote cache), `project:deleted` (drops it too), and
//!   [`PrPollerHandle::hint_worktree`] (client focus).
//! - Failure semantics (Decision 3): a transient failure keeps the last-known
//!   value and sets `stale_since`; `no_credentials` is written only on a clean
//!   zero-login credential resolution or an all-401 run (Decision 8). A `gh`
//!   timeout is transient, never `no_credentials`.
//! - `pr_status_equivalent` compares state/number/url/error_kind/pr_branch and
//!   whether the value is stale — never error text, never `checked_at`.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::time::Instant;

use tokio::sync::broadcast::error::RecvError;
use tokio::sync::Notify;
use vst_store::StoreHandle;
use vst_types::coalescer::{Coalescer, CoalescerConfig, MarkOpts};
use vst_types::domain::{LifecycleState, PrErrorKind, PrState, PrStatus, SessionRecord};
use vst_types::events::{Broadcaster, ServerEvent};
use vst_types::ProjectRecord;

use crate::github::{
    classify_remote, fetch_all, get_remote_url, merge_account_results, AccountMergedOutcome,
    GithubError, Query, RemoteClass,
};
use crate::github_auth::{list_accounts_with, AccountCache, AccountsOutcome, GithubAccount};
use crate::util::now_iso;

/// Fixed safety-net tick (Decision 2). Remote-only changes (a merge, a review,
/// CI) cannot reach a local daemon, so one cheap batched request per account
/// every 45 s is the only way to notice them.
pub const PR_TICK_INTERVAL_MS: u64 = 45_000;

/// Minimum spacing between the START of two runs (Decision 2).
pub const PR_MIN_SPACING_MS: u64 = 20_000;

/// Default quiet period after a trigger (Decision 2).
pub const PR_DEBOUNCE_MS: u64 = 2_000;

/// Quiet period for a client focus hint — the opened worktree reacts faster.
pub const PR_HINT_DEBOUNCE_MS: u64 = 1_000;

/// Upper bound on how long a continuously re-triggered poll may stay dirty.
pub const PR_MAX_WAIT_MS: u64 = 5_000;

/// Budget for everything up to the end of the fetch phase of one run
/// (remote probes, credential resolution and fetching; R1F-03). A hung
/// `gh`/HTTP call must not wedge the poller (Requirement 5): a hung account is
/// cut off and marked transient, and the apply phase still runs.
pub const PR_FETCH_BUDGET_SECS: u64 = 50;

/// Minimum gap between two 401-triggered credential re-lists (R1F-02). A
/// permanently rejected token must not re-run `gh` on every 45 s tick.
pub const PR_401_RELIST_COOLDOWN_SECS: u64 = 300;

/// TTL for the per-project remote-URL classification cache (Decision 9).
pub const REMOTE_CACHE_TTL_SECS: u64 = 600;

/// Production GitHub API base URL.
pub const GITHUB_API_BASE: &str = "https://api.github.com";

/// A boxed, `Send` future — the shape of every injectable seam.
pub type BoxFuture<'a, T> = Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

/// Per-`(owner/repo, branch)` merged outcome across every account.
pub type Merged = HashMap<(String, String), AccountMergedOutcome>;

/// Injectable batched fetch seam (tests replace it with a fake).
pub type Fetcher =
    Arc<dyn Fn(Vec<Query>, Vec<GithubAccount>) -> BoxFuture<'static, Merged> + Send + Sync>;

/// Injectable credential source (tests replace it with a fake).
pub type AccountSource = Arc<dyn Fn() -> BoxFuture<'static, AccountsOutcome> + Send + Sync>;

/// Injectable remote-classification source (tests replace it with a fake).
pub type RemoteSource = Arc<dyn Fn(String) -> BoxFuture<'static, RemoteClass> + Send + Sync>;

/// Classify a raw GitHub PR into a `PrState`.
///
/// Decision rules (mirrors TS `classifyPrState`):
/// 1. `merged == true` → `Merged`
/// 2. `draft == true` → `Draft`
/// 3. `state == "closed"` → `Closed`
/// 4. otherwise → `Open`
pub fn classify_pr_state(merged: bool, draft: bool, state_closed: bool) -> PrState {
    if merged {
        PrState::Merged
    } else if draft {
        PrState::Draft
    } else if state_closed {
        PrState::Closed
    } else {
        PrState::Open
    }
}

/// Compare two `PrStatus` values for effective equivalence (Decision 3).
///
/// Deliberately ignores `checked_at` and the free-text `error` — error text
/// churn used to re-broadcast `session:updated` on every tick. `stale_since`
/// compares as a boolean so a stale value broadcasts exactly once when it goes
/// stale, and once when it becomes fresh again.
pub fn pr_status_equivalent(a: &PrStatus, b: &PrStatus) -> bool {
    a.state == b.state
        && a.number == b.number
        && a.url == b.url
        && a.error_kind == b.error_kind
        && a.pr_branch == b.pr_branch
        && a.stale_since.is_some() == b.stale_since.is_some()
}

/// Private (this module only) PR-status setter.
/// Only this module may write `pr` — enforces the two-axis model.
async fn set_pr_status(
    project_id: &str,
    session: &SessionRecord,
    pr: PrStatus,
    store: &StoreHandle,
    broadcaster: &Broadcaster,
) {
    if let Some(existing) = &session.pr {
        if pr_status_equivalent(existing, &pr) {
            return;
        }
    }
    let pr_box = Box::new(pr.clone());
    let _ = store.update_session_pr(project_id, &session.id, pr).await;
    broadcaster.send(ServerEvent::SessionUpdated {
        session_id: session.id.clone(),
        pr: Some(pr_box),
        pinned_at: None,
        channel: None,
        name: None,
        archived_at: None,
        sort_order: None,
        superseded_by: None,
        is_main: None,
        parent_session_id: None,
        worktree_id: None,
        draft_prompt: None,
        draft_config: None,
        mode_id: None,
        mode_icon: None,
    });
}

/// One main session whose branch the poller tracks.
struct Target {
    project_id: String,
    project_path: String,
    session: SessionRecord,
    branch: String,
}

/// Per-project cache of the classified remote URL (Decision 9: TTL 10 min,
/// dropped on `project:updated`/`project:deleted`).
#[derive(Debug)]
struct RemoteCache {
    ttl: Duration,
    entries: Mutex<HashMap<String, (Instant, RemoteClass)>>,
}

impl RemoteCache {
    fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            entries: Mutex::new(HashMap::new()),
        }
    }

    fn get(&self, project_id: &str, now: Instant) -> Option<RemoteClass> {
        let guard = self.entries.lock().ok()?;
        let (at, class) = guard.get(project_id)?;
        (now.saturating_duration_since(*at) < self.ttl).then(|| class.clone())
    }

    fn put(&self, project_id: &str, now: Instant, class: RemoteClass) {
        if let Ok(mut guard) = self.entries.lock() {
            guard.insert(project_id.to_string(), (now, class));
        }
    }

    fn remove(&self, project_id: &str) {
        if let Ok(mut guard) = self.entries.lock() {
            guard.remove(project_id);
        }
    }

    fn clear(&self) {
        if let Ok(mut guard) = self.entries.lock() {
            guard.clear();
        }
    }
}

/// Clears the in-flight guard even when the run future is dropped (e.g. daemon shutdown aborts the task).
struct InFlightGuard(Arc<AtomicBool>);

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// Calls [`Coalescer::finish`] when a run ends — including when the run
/// future is dropped mid-flight (task abort), so a re-mark during that run still
/// turns into exactly one trailing run.
struct FinishGuard {
    coalescer: Arc<Mutex<Coalescer<()>>>,
}

impl Drop for FinishGuard {
    fn drop(&mut self) {
        let now = tokio::time::Instant::now().into_std();
        if let Ok(mut coalescer) = self.coalescer.lock() {
            coalescer.finish(&(), now);
        }
    }
}

/// Handle to the PR poller.
#[derive(Clone)]
pub struct PrPollerHandle {
    store: StoreHandle,
    broadcaster: Broadcaster,
    coalescer: Arc<Mutex<Coalescer<()>>>,
    notify: Arc<Notify>,
    in_flight: Arc<AtomicBool>,
    account_cache: Arc<AccountCache>,
    remote_cache: Arc<RemoteCache>,
    accounts: AccountSource,
    remote: RemoteSource,
    fetcher: Fetcher,
    /// When the last 401-triggered re-list ran (one timestamp; not account memory).
    last_401_relist: Arc<Mutex<Option<std::time::Instant>>>,
}

impl PrPollerHandle {
    /// Build the production poller: real `gh` credentials, real `git remote`,
    /// real GitHub GraphQL at [`GITHUB_API_BASE`].
    pub fn new(store: StoreHandle, broadcaster: Broadcaster) -> Self {
        Self {
            store,
            broadcaster,
            coalescer: Arc::new(Mutex::new(Coalescer::new(CoalescerConfig {
                debounce: Duration::from_millis(PR_DEBOUNCE_MS),
                min_spacing: Duration::from_millis(PR_MIN_SPACING_MS),
                max_wait: Duration::from_millis(PR_MAX_WAIT_MS),
            }))),
            notify: Arc::new(Notify::new()),
            in_flight: Arc::new(AtomicBool::new(false)),
            account_cache: Arc::new(AccountCache::default()),
            remote_cache: Arc::new(RemoteCache::new(Duration::from_secs(REMOTE_CACHE_TTL_SECS))),
            accounts: default_account_source(),
            remote: default_remote_source(),
            fetcher: default_fetcher(GITHUB_API_BASE.to_string()),
            last_401_relist: Arc::new(Mutex::new(None)),
        }
    }

    /// Point the batched fetch at a different GitHub API base (tests, GHE-like
    /// fixtures). Replaces the default fetcher with one bound to `base`.
    #[must_use]
    pub fn with_github_base(mut self, base: impl Into<String>) -> Self {
        self.fetcher = default_fetcher(base.into());
        self
    }

    /// Replace the credential source (tests).
    #[must_use]
    pub fn with_account_source(mut self, source: AccountSource) -> Self {
        self.accounts = source;
        self
    }

    /// Replace the remote-classification source (tests).
    #[must_use]
    pub fn with_remote_source(mut self, source: RemoteSource) -> Self {
        self.remote = source;
        self
    }

    /// Replace the batched fetch seam (paused-time tests: no real HTTP).
    #[must_use]
    pub fn with_fetcher(mut self, fetcher: Fetcher) -> Self {
        self.fetcher = fetcher;
        self
    }

    /// Share an existing account cache (tests that assert TTL behaviour).
    #[must_use]
    pub fn with_account_cache(mut self, cache: Arc<AccountCache>) -> Self {
        self.account_cache = cache;
        self
    }

    /// Mark the single global key dirty.
    fn mark_dirty(&self, opts: MarkOpts) {
        let now = tokio::time::Instant::now().into_std();
        if let Ok(mut coalescer) = self.coalescer.lock() {
            coalescer.mark_dirty((), now, opts);
        }
        self.notify.notify_one();
    }

    /// Client focus hint: the user opened a worktree, so refresh soon.
    pub fn hint_worktree(&self) {
        // A deliberate user action: re-check credentials if signed out.
        self.account_cache.invalidate_if_no_credentials();
        self.mark_dirty(MarkOpts {
            debounce: Some(Duration::from_millis(PR_HINT_DEBOUNCE_MS)),
            priority: u64::MAX,
        });
    }

    /// Whether a run is pending (dirty, in flight, or awaiting a trailing run).
    /// Used by the focus route's regression test.
    #[must_use]
    pub fn has_pending(&self) -> bool {
        self.coalescer
            .lock()
            .map(|coalescer| coalescer.contains(&()))
            .unwrap_or(false)
    }

    /// Map one broadcaster event onto the poller's triggers (Decision 2).
    fn handle_event(&self, event: ServerEvent) {
        match event {
            ServerEvent::WorktreeCreated { .. }
            | ServerEvent::WorktreeUpdated { .. }
            | ServerEvent::SessionCreated { .. } => self.mark_dirty(MarkOpts::default()),
            ServerEvent::SessionState {
                state: LifecycleState::Idle | LifecycleState::WaitingForHuman,
                ..
            } => self.mark_dirty(MarkOpts::default()),
            ServerEvent::ProjectUpdated { project } => {
                // A project's remote may have changed (re-cloned, remote
                // edited), so drop its cached classification and re-derive.
                match project.get("id").and_then(|value| value.as_str()) {
                    Some(id) => self.remote_cache.remove(id),
                    None => self.remote_cache.clear(),
                }
                self.mark_dirty(MarkOpts::default());
            }
            ServerEvent::ProjectDeleted { project_id } => self.remote_cache.remove(&project_id),
            _ => {}
        }
    }

    /// Resolve accounts through the TTL cache (Decision 8).
    async fn resolve_accounts(&self) -> AccountsOutcome {
        if let Some(cached) = self.account_cache.get(Instant::now()) {
            return cached;
        }
        let outcome = (self.accounts)().await;
        self.account_cache.put(Instant::now(), outcome.clone());
        outcome
    }

    /// Fetch each token-holding account concurrently through the injectable
    /// seam, one call per account (so a 401 is attributable), bounded by
    /// `deadline`. The result is aligned with `accounts`.
    ///
    /// A token-holding account that does not answer in time (or whose task
    /// fails) is filled with `Transient` for EVERY query — never left empty,
    /// since an empty set merges to `Unauthorized`. Only token-less accounts
    /// get an empty map (no candidate).
    async fn fetch_per_account(
        &self,
        queries: &[Query],
        accounts: &[GithubAccount],
        deadline: tokio::time::Instant,
    ) -> Vec<Merged> {
        let transient_map = || -> Merged {
            queries
                .iter()
                .map(|query| (query.key(), AccountMergedOutcome::Transient))
                .collect()
        };
        let mut results: Vec<Merged> = accounts
            .iter()
            .map(|account| {
                if account.token.is_some() {
                    transient_map()
                } else {
                    HashMap::new()
                }
            })
            .collect();
        if queries.is_empty() {
            return results;
        }

        let mut set = tokio::task::JoinSet::new();
        for (index, account) in accounts.iter().enumerate() {
            if account.token.is_none() {
                continue;
            }
            let fut = (self.fetcher)(queries.to_vec(), vec![account.clone()]);
            set.spawn(async move { (index, fut.await) });
        }
        loop {
            match tokio::time::timeout_at(deadline, set.join_next()).await {
                Ok(Some(Ok((index, mut map)))) => {
                    for query in queries {
                        map.entry(query.key())
                            .or_insert(AccountMergedOutcome::Transient);
                    }
                    results[index] = map;
                }
                // A failed task keeps its Transient default.
                Ok(Some(Err(_))) => {}
                Ok(None) => break,
                Err(_) => {
                    set.abort_all();
                    break;
                }
            }
        }
        results
    }

    /// Claim the (single) 401 re-list slot unless the cooldown is running.
    fn take_relist_slot(&self) -> bool {
        let now = tokio::time::Instant::now().into_std();
        let Ok(mut last) = self.last_401_relist.lock() else {
            return false;
        };
        if let Some(at) = *last {
            if now.saturating_duration_since(at) < Duration::from_secs(PR_401_RELIST_COOLDOWN_SECS)
            {
                return false;
            }
        }
        *last = Some(now);
        true
    }

    /// One complete run — public so tests can drive it without the timer.
    ///
    /// Overlap guard: a run already in flight makes this a no-op.
    pub async fn run_once(&self) {
        if self
            .in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
            .is_err()
        {
            return;
        }
        let _guard = InFlightGuard(self.in_flight.clone());
        let deadline = tokio::time::Instant::now() + Duration::from_secs(PR_FETCH_BUDGET_SECS);

        let projects = self.store.get_all_projects().await;
        let targets = collect_targets(&projects);
        if targets.is_empty() {
            return;
        }
        let checked_at = now_iso();

        // Remote classes, cached per project (Decision 9).
        // Probed concurrently (bounded to 4) inside deadline.
        let mut remotes: HashMap<String, RemoteClass> = HashMap::new();
        let mut unprobed: Vec<(String, String)> = Vec::new();
        for target in &targets {
            if remotes.contains_key(&target.project_id) {
                continue;
            }
            if let Some(class) = self.remote_cache.get(&target.project_id, Instant::now()) {
                remotes.insert(target.project_id.clone(), class);
            } else if !unprobed.iter().any(|(id, _)| id == &target.project_id) {
                unprobed.push((target.project_id.clone(), target.project_path.clone()));
            }
        }

        if !unprobed.is_empty() {
            let mut set = tokio::task::JoinSet::new();
            let mut iter = unprobed.into_iter();
            for _ in 0..4 {
                if let Some((project_id, project_path)) = iter.next() {
                    let remote_fn = self.remote.clone();
                    set.spawn(async move {
                        let class = remote_fn(project_path).await;
                        (project_id, class)
                    });
                }
            }
            while !set.is_empty() {
                match tokio::time::timeout_at(deadline, set.join_next()).await {
                    Ok(Some(Ok((project_id, class)))) => {
                        if class != RemoteClass::Transient {
                            self.remote_cache
                                .put(&project_id, Instant::now(), class.clone());
                        }
                        remotes.insert(project_id, class);
                        if let Some((next_id, next_path)) = iter.next() {
                            let remote_fn = self.remote.clone();
                            set.spawn(async move {
                                let class = remote_fn(next_path).await;
                                (next_id, class)
                            });
                        }
                    }
                    _ => {
                        // Timeout or task error: remaining tasks default to Transient.
                        break;
                    }
                }
            }
        }
        for target in &targets {
            remotes
                .entry(target.project_id.clone())
                .or_insert(RemoteClass::Transient);
        }

        let queries = build_queries(&targets, &remotes);

        // A GHE-like host is permanently unsupported and does not depend on
        // credentials: write that visible state now, then leave those targets
        // out of the credential/fetch path entirely (a signed-out machine must
        // still show "unsupported", not "no credentials").
        self.apply_unsupported(&targets, &remotes, &checked_at)
            .await;
        // Transient remote probe: keep the last value for the branch, stale.
        for target in &targets {
            if matches!(
                remotes.get(&target.project_id),
                Some(RemoteClass::Transient)
            ) {
                tracing::debug!(project_id = %target.project_id, "pr poller: transient (remote)");
                if let Some(status) =
                    transient_status(&target.branch, &checked_at, target.session.pr.as_ref())
                {
                    self.write(&target.project_id, &target.session, status)
                        .await;
                }
            }
        }
        let github_targets: Vec<&Target> = targets
            .iter()
            .filter(|target| {
                matches!(
                    remotes.get(&target.project_id),
                    Some(RemoteClass::Github(_))
                )
            })
            .collect();
        if github_targets.is_empty() {
            return;
        }

        let accounts = match tokio::time::timeout_at(deadline, self.resolve_accounts()).await {
            Ok(AccountsOutcome::Accounts(accounts)) => accounts,
            Ok(other) => {
                self.apply_accounts_outcome(&github_targets, &other, &checked_at)
                    .await;
                return;
            }
            Err(_) => {
                let other = AccountsOutcome::Transient("account resolution timed out".into());
                self.apply_accounts_outcome(&github_targets, &other, &checked_at)
                    .await;
                return;
            }
        };

        let mut per_account = self.fetch_per_account(&queries, &accounts, deadline).await;
        let mut final_accounts = accounts.clone();

        // Decision 8: on ANY 401, invalidate, re-list ONCE and retry only the
        // 401 accounts (a cooldown keeps a permanently rejected token from
        // re-running `gh` every tick).
        let unauthorized: Vec<usize> = accounts
            .iter()
            .enumerate()
            .filter(|(index, account)| {
                account.token.is_some()
                    && per_account[*index]
                        .values()
                        .any(|outcome| matches!(outcome, AccountMergedOutcome::Unauthorized))
            })
            .map(|(index, _)| index)
            .collect();
        if !unauthorized.is_empty() && self.take_relist_slot() {
            self.account_cache.invalidate();
            let refreshed_outcome =
                match tokio::time::timeout_at(deadline, self.resolve_accounts()).await {
                    Ok(outcome) => outcome,
                    Err(_) => AccountsOutcome::Transient("relist accounts timed out".into()),
                };
            match refreshed_outcome {
                AccountsOutcome::Accounts(refreshed) => {
                    // Per refreshed account: reuse the first-pass map, or
                    // re-fetch when it is new / has a different token.
                    let mut reused: Vec<Option<Merged>> = Vec::with_capacity(refreshed.len());
                    let mut to_fetch: Vec<GithubAccount> = Vec::new();
                    for account in &refreshed {
                        let original = accounts.iter().position(|o| o.login == account.login);
                        let reuse = match original {
                            Some(index) if unauthorized.contains(&index) => {
                                accounts[index].token == account.token
                            }
                            Some(_) => true,
                            None => false,
                        };
                        if reuse {
                            reused.push(original.map(|index| per_account[index].clone()));
                        } else {
                            reused.push(None);
                            to_fetch.push(account.clone());
                        }
                    }
                    let mut fetched = self
                        .fetch_per_account(&queries, &to_fetch, deadline)
                        .await
                        .into_iter();
                    per_account = reused
                        .into_iter()
                        .map(|map| map.or_else(|| fetched.next()).unwrap_or_default())
                        .collect();
                    final_accounts = refreshed;
                }
                other @ AccountsOutcome::NoCredentials => {
                    self.apply_accounts_outcome(&github_targets, &other, &checked_at)
                        .await;
                    return;
                }
                AccountsOutcome::Transient(_) => {
                    // Keep the good accounts' results; the 401 accounts could
                    // not be refreshed, so they answer "transient".
                    for index in &unauthorized {
                        for outcome in per_account[*index].values_mut() {
                            *outcome = AccountMergedOutcome::Transient;
                        }
                    }
                }
            }
        }

        let merged = merge_account_results(&queries, &final_accounts, &per_account);

        self.apply_merged(&github_targets, &remotes, &merged, &checked_at)
            .await;
    }

    /// Write the permanent `unsupported` state for GHE-like hosts.
    async fn apply_unsupported(
        &self,
        targets: &[Target],
        remotes: &HashMap<String, RemoteClass>,
        checked_at: &str,
    ) {
        for target in targets {
            let Some(RemoteClass::Unsupported { host }) = remotes.get(&target.project_id) else {
                continue;
            };
            tracing::debug!(
                project_id = %target.project_id,
                host = %host,
                "pr poller: unsupported"
            );
            let status = error_status(
                &target.branch,
                checked_at,
                PrErrorKind::Unsupported,
                &format!("unsupported GitHub host: {host}"),
            );
            self.write(&target.project_id, &target.session, status)
                .await;
        }
    }

    /// Credential-level outcomes apply to every tracked GitHub branch.
    async fn apply_accounts_outcome(
        &self,
        targets: &[&Target],
        outcome: &AccountsOutcome,
        checked_at: &str,
    ) {
        match outcome {
            AccountsOutcome::NoCredentials => {
                for target in targets {
                    tracing::debug!(
                        project_id = %target.project_id,
                        "pr poller: no_credentials"
                    );
                    let status = error_status(
                        &target.branch,
                        checked_at,
                        PrErrorKind::NoCredentials,
                        "no GitHub credentials available",
                    );
                    self.write(&target.project_id, &target.session, status)
                        .await;
                }
            }
            // Transient: keep the last-known value for this branch (or write
            // nothing at all when there is none).
            AccountsOutcome::Transient(_) => {
                for target in targets {
                    tracing::debug!(
                        project_id = %target.project_id,
                        "pr poller: transient (accounts)"
                    );
                    if let Some(status) =
                        transient_status(&target.branch, checked_at, target.session.pr.as_ref())
                    {
                        self.write(&target.project_id, &target.session, status)
                            .await;
                    }
                }
            }
            AccountsOutcome::Accounts(_) => {}
        }
    }

    /// Per-key outcomes from the batched fetch (GitHub targets only).
    async fn apply_merged(
        &self,
        targets: &[&Target],
        remotes: &HashMap<String, RemoteClass>,
        merged: &Merged,
        checked_at: &str,
    ) {
        for target in targets {
            let Some(RemoteClass::Github(remote)) = remotes.get(&target.project_id) else {
                continue;
            };
            let key = Query::new(
                remote.owner.clone(),
                remote.repo.clone(),
                target.branch.clone(),
            )
            .key();
            let outcome = merged
                .get(&key)
                .cloned()
                .unwrap_or(AccountMergedOutcome::Transient);
            match &outcome {
                AccountMergedOutcome::Unauthorized => {
                    tracing::debug!(
                        project_id = %target.project_id,
                        branch = %target.branch,
                        "pr poller: no_credentials (unauthorized)"
                    );
                }
                AccountMergedOutcome::Transient => {
                    tracing::debug!(
                        project_id = %target.project_id,
                        branch = %target.branch,
                        "pr poller: transient"
                    );
                }
                _ => {}
            }
            if let Some(status) = outcome_status(
                &outcome,
                &target.branch,
                checked_at,
                target.session.pr.as_ref(),
            ) {
                self.write(&target.project_id, &target.session, status)
                    .await;
            }
        }
    }

    async fn write(&self, project_id: &str, session: &SessionRecord, status: PrStatus) {
        set_pr_status(project_id, session, status, &self.store, &self.broadcaster).await;
    }

    /// Start the poller: ONE task that selects over the broadcaster subscriber,
    /// the coalescer driver and the 45 s tick, so a single abort stops all.
    pub fn start(self: Arc<Self>) -> tokio::task::JoinHandle<()> {
        let mut rx = self.broadcaster.subscribe();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(PR_TICK_INTERVAL_MS));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                // Drain everything that is due right now.
                let taken = {
                    let now = tokio::time::Instant::now().into_std();
                    self.coalescer
                        .lock()
                        .map(|mut coalescer| coalescer.take_ready(now))
                        .unwrap_or_default()
                };
                if !taken.is_empty() {
                    let finish = FinishGuard {
                        coalescer: self.coalescer.clone(),
                    };
                    self.run_once().await;
                    drop(finish);
                    continue;
                }

                let next_due = self
                    .coalescer
                    .lock()
                    .ok()
                    .and_then(|coalescer| coalescer.next_due());
                let sleep = async {
                    match next_due {
                        Some(due) => {
                            tokio::time::sleep_until(tokio::time::Instant::from_std(due)).await;
                        }
                        None => std::future::pending::<()>().await,
                    }
                };

                tokio::select! {
                    // Poll the tick first (`biased`): when a mark's due time
                    // and the 45 s tick land on the same instant, the tick must
                    // be consumed here so the loop below runs exactly ONE run
                    // instead of leaving the tick to re-mark immediately after.
                    biased;
                    // Tick skips the debounce but still respects spacing.
                    _ = tick.tick() => self.mark_dirty(MarkOpts {
                        debounce: Some(Duration::ZERO),
                        priority: 0,
                    }),
                    _ = self.notify.notified() => {}
                    _ = sleep => {}
                    received = rx.recv() => match received {
                        Ok(event) => self.handle_event(event),
                        // A lagged receiver may have missed triggers: re-poll.
                        Err(RecvError::Lagged(_)) => self.mark_dirty(MarkOpts::default()),
                        Err(RecvError::Closed) => break,
                    },
                }
            }
        })
    }
}

/// Every `isMain` session across every project, skipping drafts.
fn collect_targets(projects: &[ProjectRecord]) -> Vec<Target> {
    let mut targets = Vec::new();
    for project in projects {
        for worktree in &project.worktrees {
            for session in &worktree.sessions {
                if !session.is_main || session.lifecycle.state == LifecycleState::Drafting {
                    continue;
                }
                targets.push(Target {
                    project_id: project.id.clone(),
                    project_path: project.absolute_path.clone(),
                    session: session.clone(),
                    branch: worktree.branch.clone(),
                });
            }
        }
    }
    targets
}

/// One query per distinct `(owner/repo, branch)` across all GitHub projects.
fn build_queries(targets: &[Target], remotes: &HashMap<String, RemoteClass>) -> Vec<Query> {
    let mut seen = HashSet::new();
    let mut queries = Vec::new();
    for target in targets {
        let Some(RemoteClass::Github(remote)) = remotes.get(&target.project_id) else {
            continue;
        };
        let query = Query::new(
            remote.owner.clone(),
            remote.repo.clone(),
            target.branch.clone(),
        );
        if seen.insert(query.key()) {
            queries.push(query);
        }
    }
    queries
}

/// A status carrying only a categorised error (Decision 3).
fn error_status(branch: &str, checked_at: &str, kind: PrErrorKind, message: &str) -> PrStatus {
    PrStatus {
        state: PrState::None,
        number: None,
        url: None,
        checked_at: checked_at.to_string(),
        error: Some(message.to_string()),
        error_kind: Some(kind),
        pr_branch: Some(branch.to_string()),
        stale_since: None,
    }
}

/// Keep the last-known value for `branch` and mark it stale (Decision 3).
/// `None` means "write nothing": there is no value for this branch to keep.
fn transient_status(
    branch: &str,
    checked_at: &str,
    existing: Option<&PrStatus>,
) -> Option<PrStatus> {
    let existing = existing.filter(|status| status.pr_branch.as_deref() == Some(branch))?;
    Some(PrStatus {
        state: existing.state,
        number: existing.number,
        url: existing.url.clone(),
        checked_at: checked_at.to_string(),
        error: existing.error.clone(),
        error_kind: existing.error_kind,
        pr_branch: Some(branch.to_string()),
        stale_since: Some(
            existing
                .stale_since
                .clone()
                .unwrap_or_else(|| checked_at.to_string()),
        ),
    })
}

/// Map one merged per-key outcome onto the wire status (Decision 3 table).
fn outcome_status(
    outcome: &AccountMergedOutcome,
    branch: &str,
    checked_at: &str,
    existing: Option<&PrStatus>,
) -> Option<PrStatus> {
    match outcome {
        AccountMergedOutcome::Pr(data) => Some(PrStatus {
            state: classify_pr_state(data.merged, data.draft, data.state == "closed"),
            number: Some(data.number),
            url: Some(data.url.clone()),
            checked_at: checked_at.to_string(),
            error: None,
            error_kind: None,
            pr_branch: Some(branch.to_string()),
            stale_since: None,
        }),
        AccountMergedOutcome::NoPr => Some(PrStatus {
            state: PrState::None,
            number: None,
            url: None,
            checked_at: checked_at.to_string(),
            error: None,
            error_kind: None,
            pr_branch: Some(branch.to_string()),
            stale_since: None,
        }),
        AccountMergedOutcome::NotVisible => Some(error_status(
            branch,
            checked_at,
            PrErrorKind::NotFound,
            "repo not visible to any GitHub account",
        )),
        AccountMergedOutcome::Auth => Some(error_status(
            branch,
            checked_at,
            PrErrorKind::Auth,
            "GitHub token lacks the 'repo' scope",
        )),
        AccountMergedOutcome::Unauthorized => Some(error_status(
            branch,
            checked_at,
            PrErrorKind::NoCredentials,
            "GitHub credentials rejected",
        )),
        AccountMergedOutcome::Transient => transient_status(branch, checked_at, existing),
    }
}

/// Production credential source: `gh auth status` + env fallback.
///
/// Shared by the PR poller and the ad-hoc `GET /worktrees/:id/pr` route so
/// both resolve credentials identically.
pub fn default_account_source() -> AccountSource {
    Arc::new(|| {
        Box::pin(async {
            list_accounts_with(Path::new("gh"), |key: &str| std::env::var(key).ok()).await
        })
    })
}

/// Production remote source: bounded `git remote get-url` + classification.
/// The ssh-config read is blocking, so it runs in `spawn_blocking`.
fn default_remote_source() -> RemoteSource {
    Arc::new(|project_path: String| {
        Box::pin(async move {
            match get_remote_url(Path::new(&project_path)).await {
                Ok(url) => tokio::task::spawn_blocking(move || classify_remote(&url))
                    .await
                    .unwrap_or(RemoteClass::Transient),
                Err(GithubError::RemoteProbe(_)) => RemoteClass::Transient,
                Err(_) => RemoteClass::NotGithub,
            }
        })
    })
}

/// Production fetcher: ONE batched request per account against `base`.
fn default_fetcher(base: String) -> Fetcher {
    Arc::new(move |queries: Vec<Query>, accounts: Vec<GithubAccount>| {
        let base = base.clone();
        Box::pin(async move { fetch_all(&base, &accounts, &queries).await })
    })
}
