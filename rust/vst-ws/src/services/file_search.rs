//! Server-driven filename index for Quick Open, keyed by scope (`wt:<id>` or `proj:<id>`).
//!
//! Replaces the old client-side cache in `web-ui/src/hooks/useWorktreeFiles.ts`.
//! The daemon owns freshness: the index is updated incrementally whenever the
//! tree watcher (`handlers::tree_watch`) observes a filesystem change, and
//! unwatched callers are kept fresh via a 30s TTL. See
//! `docs/FILE-SEARCH-LIFECYCLE.md` for the full lifecycle (first walk and the
//! `indexing` state, serve-stale refresh, idle eviction, evict-on-delete).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio::sync::{watch, RwLock};
use tokio_util::sync::CancellationToken;
use vst_types::rest::worktrees::FileSearchResult;
use vst_types::ws::WatchScope;

use super::file_list::FileList;
use super::file_search_rank::rank;
use super::file_search_walk::{stat_paths, walk_and_stat, WalkOutcome};

static NEXT_GEN: AtomicU64 = AtomicU64::new(1);

/// Unwatched entries not queried for this long are dropped by the lazy sweep.
const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(600);
/// The lazy idle sweep runs at most this often (piggybacked on `search`).
const DEFAULT_SWEEP_INTERVAL: Duration = Duration::from_secs(60);
/// How long the FIRST query for a key waits for the first walk before
/// answering `indexing: true`.
const DEFAULT_FIRST_WALK_WAIT: Duration = Duration::from_millis(1500);

/// Compute an index key from a watch scope and entity id (`wt:<id>` or `proj:<id>`).
pub fn index_key(scope: WatchScope, id: &str) -> String {
    match scope {
        WatchScope::Worktree => format!("wt:{id}"),
        WatchScope::Project => format!("proj:{id}"),
    }
}

#[derive(Debug, Clone)]
pub(crate) enum Op {
    Insert(String, i64),
    Remove(String),
    Merge {
        prefix: String,
        files: HashMap<String, i64>,
    },
}

pub(crate) struct Entry {
    pub files: HashMap<String, i64>,
    pub walked_at: Instant,
    pub stale: bool,
    pub pending: Option<Vec<Op>>,
    pub gen: u64,
    pub retry_after: Instant,
    /// A walk has produced a listing for this entry (even an empty one). An
    /// entry without data answers `indexing: true`; one with data is served
    /// stale while it refreshes.
    pub loaded: bool,
    /// A watcher armed while a walk was in flight: that walk may have listed
    /// the tree before the watcher could see changes, so on completion the
    /// entry must stay stale and be re-walked once (see [`FileSearchIndex::watch_started`]).
    pub rewalk_after: bool,
    /// Nanoseconds since the index's `epoch` at the last query (idle eviction).
    pub last_queried: AtomicU64,
}

pub struct FileSearchIndex {
    index: RwLock<HashMap<String, Entry>>,
    file_list: Arc<FileList>,
    watched_keys: std::sync::Mutex<HashSet<String>>,
    walk_locks: std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Single-flight registry of running (first or refresh) walks, per key.
    in_flight: std::sync::Mutex<Walks>,
    ttl: Duration,
    walk_timeout: Duration,
    idle_timeout: Duration,
    sweep_interval: Duration,
    first_walk_wait: Duration,
    epoch: Instant,
    last_sweep: std::sync::Mutex<Instant>,
    #[cfg(test)]
    pub(crate) walk_count: AtomicUsize,
    #[cfg(test)]
    walk_hook: tokio::sync::Mutex<Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>>,
    #[cfg(test)]
    pub(crate) walk_delay: std::sync::Mutex<Option<Duration>>,
    #[cfg(test)]
    pub(crate) stat_delay: std::sync::Mutex<Option<Duration>>,
}

/// Registry of running walks plus per-key eviction epochs, under one lock so
/// "has this key been evicted since the request began?" and "register a new
/// walk" are atomic (an evict can never slip between the check and the insert).
#[derive(Default)]
struct Walks {
    running: HashMap<String, Running>,
    /// Bumped on every evict of a key. A request captures it at its start and
    /// refuses to (re)start walks or resurrect state once it has moved.
    epochs: HashMap<String, u64>,
}

struct Running {
    done: watch::Receiver<bool>,
    /// Cancels the walk (kills a running `rg`) when its key is evicted.
    cancel: CancellationToken,
}

/// Removes a key's single-flight registration when the walk task ends (even
/// on panic) and then wakes its waiters.
struct InFlightGuard {
    idx: Arc<FileSearchIndex>,
    key: String,
    done: watch::Sender<bool>,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        {
            // Only drop OUR registration: after an eviction a newer walk for
            // the same key may have registered itself.
            let mut map = self.idx.in_flight.lock().unwrap();
            let mine = self.done.subscribe();
            if map
                .running
                .get(&self.key)
                .is_some_and(|r| r.done.same_channel(&mine))
            {
                map.running.remove(&self.key);
            }
        }
        let _ = self.done.send(true);
    }
}

impl FileSearchIndex {
    pub fn new(file_list: Arc<FileList>) -> Self {
        Self::with_ttl(file_list, Duration::from_secs(30))
    }

    pub fn with_ttl(file_list: Arc<FileList>, ttl: Duration) -> Self {
        let now = Instant::now();
        FileSearchIndex {
            index: RwLock::new(HashMap::new()),
            file_list,
            watched_keys: std::sync::Mutex::new(HashSet::new()),
            walk_locks: std::sync::Mutex::new(HashMap::new()),
            in_flight: std::sync::Mutex::new(Walks::default()),
            ttl,
            walk_timeout: Duration::from_secs(10),
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
            sweep_interval: DEFAULT_SWEEP_INTERVAL,
            first_walk_wait: DEFAULT_FIRST_WALK_WAIT,
            epoch: now,
            last_sweep: std::sync::Mutex::new(now),
            #[cfg(test)]
            walk_count: AtomicUsize::new(0),
            #[cfg(test)]
            walk_hook: tokio::sync::Mutex::new(None),
            #[cfg(test)]
            walk_delay: std::sync::Mutex::new(None),
            #[cfg(test)]
            stat_delay: std::sync::Mutex::new(None),
        }
    }

    pub fn with_walk_timeout(mut self, timeout: Duration) -> Self {
        self.walk_timeout = timeout;
        self
    }

    /// Unwatched entries idle (not queried) for longer than this are evicted
    /// by the lazy sweep. Default 10 minutes.
    pub fn with_idle_timeout(mut self, timeout: Duration) -> Self {
        self.idle_timeout = timeout;
        self
    }

    /// How long the first query for a key waits for the first walk before
    /// returning `indexing: true`. Default 1.5 s.
    pub fn with_first_walk_wait(mut self, wait: Duration) -> Self {
        self.first_walk_wait = wait;
        self
    }

    #[cfg(test)]
    fn with_sweep_interval(mut self, interval: Duration) -> Self {
        self.sweep_interval = interval;
        self
    }

    #[cfg(test)]
    pub fn set_walk_delay(&self, delay: Option<Duration>) {
        *self.walk_delay.lock().unwrap() = delay;
    }

    /// Clone of the stored [`FileList`] handle.
    pub fn file_list_handle(&self) -> Arc<FileList> {
        Arc::clone(&self.file_list)
    }

    fn nanos_since_epoch(&self, at: Instant) -> u64 {
        at.saturating_duration_since(self.epoch).as_nanos() as u64
    }

    pub async fn is_fresh(&self, key: &str) -> bool {
        let idx = self.index.read().await;
        let Some(e) = idx.get(key) else {
            return false;
        };
        if Instant::now() < e.retry_after {
            return true;
        }
        if e.stale {
            return false;
        }
        e.walked_at.elapsed() < self.ttl || self.is_watched(key)
    }

    /// Whether the daemon currently holds a filesystem watcher feeding `key`.
    pub(crate) fn is_watched(&self, key: &str) -> bool {
        self.watched_keys.lock().unwrap().contains(key)
    }

    /// Mark that a watcher has started for this key.
    /// Idempotent: adds to `watched_keys`, then sets `stale = true` on existing entry.
    pub async fn watch_started(&self, key: &str) {
        {
            let mut watched = self.watched_keys.lock().unwrap();
            watched.insert(key.to_string());
        }
        let mut idx = self.index.write().await;
        if let Some(e) = idx.get_mut(key) {
            e.stale = true;
            // A walk already in flight may have listed before the watcher
            // armed: make it leave the entry stale for one more walk.
            if e.pending.is_some() {
                e.rewalk_after = true;
            }
        }
    }

    /// Synchronous half of releasing the LAST watcher for `key`: stop treating
    /// it as watched. Called by `tree_watch` while it holds the watcher
    /// registry lock, so the "no watcher left" decision and this mark are
    /// atomic w.r.t. a racing `tree:watch` (which registers under the same
    /// lock and re-marks the key via [`Self::watch_started`]). Follow with
    /// [`Self::evict_if_unwatched`].
    pub(crate) fn unwatch(&self, key: &str) {
        self.watched_keys.lock().unwrap().remove(key);
    }

    /// Evict `key` unless a watcher was (re)started since [`Self::unwatch`].
    /// The watched check happens under the index write lock, and
    /// `watch_started` inserts into `watched_keys` before it takes that lock,
    /// so a watcher can never be left live with its key missing from
    /// `watched_keys`.
    pub(crate) async fn evict_if_unwatched(&self, key: &str) {
        let mut idx = self.index.write().await;
        if self.is_watched(key) {
            return;
        }
        idx.remove(key);
        // Under the index write lock: a doomed walk's `begin_walk` can't
        // re-insert the entry between the remove and the cancel.
        self.forget_walk_state(key);
    }

    /// Forget an entry entirely: removes entry, watched key, and walk lock.
    pub async fn evict(&self, key: &str) {
        let mut idx = self.index.write().await;
        idx.remove(key);
        self.watched_keys.lock().unwrap().remove(key);
        self.forget_walk_state(key);
    }

    /// Drop the walk lock and single-flight registration of an evicted key,
    /// cancel its running walk, and bump its eviction epoch. Requests that
    /// began before the evict then give up instead of re-walking a (possibly
    /// deleted) root; a LATER query starts a fresh walk. Call while holding
    /// the index write lock.
    fn forget_walk_state(&self, key: &str) {
        self.walk_locks.lock().unwrap().remove(key);
        let mut walks = self.in_flight.lock().unwrap();
        if let Some(r) = walks.running.remove(key) {
            r.cancel.cancel();
        }
        *walks.epochs.entry(key.to_string()).or_insert(0) += 1;
    }

    fn evict_epoch(&self, key: &str) -> u64 {
        *self.in_flight.lock().unwrap().epochs.get(key).unwrap_or(&0)
    }

    /// Evict the index of one project/worktree that was deleted.
    pub async fn evict_scope(&self, scope: WatchScope, id: &str) {
        self.evict(&index_key(scope, id)).await;
    }

    /// Evict a deleted project's own index and those of all its worktrees.
    pub async fn evict_project_tree(&self, project_id: &str, worktree_ids: Vec<String>) {
        self.evict_scope(WatchScope::Project, project_id).await;
        for id in &worktree_ids {
            self.evict_scope(WatchScope::Worktree, id).await;
        }
    }

    /// Drop unwatched entries idle for at least `idle_timeout` as of `now`
    /// (never `except`, the key being queried right now). Watched entries are
    /// never idle-evicted.
    pub(crate) async fn sweep_idle_at(&self, now: Instant, except: Option<&str>) {
        let now_ns = self.nanos_since_epoch(now);
        let idle_ns = self.idle_timeout.as_nanos() as u64;
        let dropped: Vec<String> = {
            let mut idx = self.index.write().await;
            let watched = self.watched_keys.lock().unwrap();
            let victims: Vec<String> = idx
                .iter()
                .filter(|(k, e)| {
                    Some(k.as_str()) != except
                        && !watched.contains(k.as_str())
                        && now_ns.saturating_sub(e.last_queried.load(Ordering::Relaxed)) >= idle_ns
                })
                .map(|(k, _)| k.clone())
                .collect();
            for k in &victims {
                idx.remove(k);
            }
            victims
        };
        if !dropped.is_empty() {
            let mut locks = self.walk_locks.lock().unwrap();
            for k in dropped {
                // A lock still in use by a running walk stays until it ends.
                if locks.get(&k).is_some_and(|l| Arc::strong_count(l) == 1) {
                    locks.remove(&k);
                }
            }
        }
    }

    /// Run the idle sweep if `sweep_interval` has passed (cheap check per query).
    async fn maybe_sweep(&self, except: &str) {
        let now = Instant::now();
        {
            let mut last = self.last_sweep.lock().unwrap();
            if now.saturating_duration_since(*last) < self.sweep_interval {
                return;
            }
            *last = now;
        }
        self.sweep_idle_at(now, Some(except)).await;
    }

    fn walk_lock(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.walk_locks.lock().unwrap();
        locks
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    /// `None` when the walk was cancelled (its key evicted): never insert an
    /// entry for a doomed walk.
    async fn begin_walk(
        &self,
        key: &str,
        cancel: &CancellationToken,
    ) -> Option<(u64, HashMap<String, i64>)> {
        let gen0 = NEXT_GEN.fetch_add(1, Ordering::SeqCst);
        let mut idx = self.index.write().await;
        if cancel.is_cancelled() {
            return None;
        }
        #[cfg(test)]
        self.walk_count.fetch_add(1, Ordering::SeqCst);
        if let Some(e) = idx.get_mut(key) {
            let prev = e.files.clone();
            e.stale = true;
            e.pending = Some(Vec::new());
            e.gen = gen0;
            e.rewalk_after = false;
            Some((gen0, prev))
        } else {
            idx.insert(
                key.to_string(),
                Entry {
                    files: HashMap::new(),
                    walked_at: Instant::now(),
                    stale: true,
                    pending: Some(Vec::new()),
                    gen: gen0,
                    retry_after: Instant::now(),
                    loaded: false,
                    rewalk_after: false,
                    last_queried: AtomicU64::new(self.nanos_since_epoch(Instant::now())),
                },
            );
            Some((gen0, HashMap::new()))
        }
    }

    #[cfg(test)]
    async fn run_walk_hook(&self) {
        let hook = {
            let g = self.walk_hook.lock().await;
            g.clone()
        };
        if let Some((reached, release)) = hook {
            reached.notify_one();
            release.notified().await;
        }
    }

    #[cfg(not(test))]
    async fn run_walk_hook(&self) {}

    #[cfg(test)]
    pub(crate) async fn set_walk_hook(
        &self,
        reached: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    ) {
        let mut g = self.walk_hook.lock().await;
        *g = Some((reached, release));
    }

    /// Walk `root` into the entry for `key` if it is not fresh. Serialised per
    /// key by the walk lock; the journal + generation guard keep concurrent
    /// incremental updates and evictions correct.
    async fn ensure_fresh(&self, key: &str, root: &Path, cancel: CancellationToken) {
        if self.is_fresh(key).await {
            return;
        }
        let lock = self.walk_lock(key);
        let _g = lock.lock().await;
        if self.is_fresh(key).await {
            return;
        }

        let Some((gen0, prev)) = self.begin_walk(key, &cancel).await else {
            return;
        };
        #[cfg(test)]
        let delay = *self.walk_delay.lock().unwrap();
        #[cfg(test)]
        let stat_delay = *self.stat_delay.lock().unwrap();
        let walked = walk_and_stat(
            &self.file_list,
            root,
            prev,
            self.walk_timeout,
            cancel.clone(),
            #[cfg(test)]
            delay,
            #[cfg(test)]
            stat_delay,
        )
        .await;
        self.run_walk_hook().await;

        let mut idx = self.index.write().await;
        let Some(e) = idx.get_mut(key) else {
            return;
        };
        if e.gen != gen0 {
            return;
        }
        let ops = e.pending.take().unwrap_or_default();
        if let Some(WalkOutcome {
            mut files,
            complete,
        }) = walked
        {
            replay(&mut files, ops);
            e.files = files;
            e.loaded = true;
            e.walked_at = Instant::now();
            if complete {
                // A watcher armed mid-walk: this listing may predate it, so
                // stay stale and let the next query walk once more.
                e.stale = std::mem::take(&mut e.rewalk_after);
                e.retry_after = Instant::now();
            } else {
                // Stat phase ran out of time: keep the listing (un-stat'ed
                // paths have created_ms = 0) and stay stale so a later query
                // backfills; short backoff avoids re-walking on every keystroke.
                e.stale = true;
                e.rewalk_after = false;
                e.retry_after = Instant::now() + Duration::from_secs(5);
            }
        } else {
            replay(&mut e.files, ops);
            e.rewalk_after = false;
            e.retry_after = Instant::now() + Duration::from_secs(30);
        }
    }

    /// Start (or join) the single background walk for `key`. The returned
    /// receiver flips to `true` when that walk task ends. `None` when the key
    /// was evicted after the request (which captured `epoch`) began: the caller
    /// must give up rather than walk a root that may be gone.
    fn kick(self: &Arc<Self>, key: &str, root: &Path, epoch: u64) -> Option<watch::Receiver<bool>> {
        let mut map = self.in_flight.lock().unwrap();
        if *map.epochs.get(key).unwrap_or(&0) != epoch {
            return None;
        }
        if let Some(r) = map.running.get(key) {
            return Some(r.done.clone());
        }
        let (tx, rx) = watch::channel(false);
        let cancel = CancellationToken::new();
        map.running.insert(
            key.to_string(),
            Running {
                done: rx.clone(),
                cancel: cancel.clone(),
            },
        );
        drop(map);

        let guard = InFlightGuard {
            idx: Arc::clone(self),
            key: key.to_string(),
            done: tx,
        };
        let key = key.to_string();
        let root: PathBuf = root.to_path_buf();
        tokio::spawn(async move {
            guard.idx.ensure_fresh(&key, &root, cancel).await;
            drop(guard);
        });
        Some(rx)
    }

    /// Wait up to `first_walk_wait` for the first walk of `key`. Returns when
    /// the entry is fresh (data, or listing-timeout backoff) or time is up.
    async fn first_walk(self: &Arc<Self>, key: &str, root: &Path, epoch: u64) {
        let deadline = Instant::now() + self.first_walk_wait;
        loop {
            if self.is_fresh(key).await {
                return;
            }
            let Some(mut rx) = self.kick(key, root, epoch) else {
                return;
            };
            let left = deadline.saturating_duration_since(Instant::now());
            if tokio::time::timeout(left, rx.wait_for(|done| *done))
                .await
                .is_err()
            {
                return;
            }
            // The walk ended. Anything but "evicted mid-walk" (no entry left)
            // is final: don't re-walk just because the TTL is already over.
            if self.index.read().await.contains_key(key) {
                return;
            }
        }
    }

    /// Test seam: wait for the running background walk of `key`, if any.
    #[cfg(test)]
    pub(crate) async fn settle(&self, key: &str) {
        let rx = self
            .in_flight
            .lock()
            .unwrap()
            .running
            .get(key)
            .map(|r| r.done.clone());
        if let Some(mut rx) = rx {
            let _ = rx.wait_for(|done| *done).await;
        }
    }

    /// Insert a path into the index.
    /// No-op if no entry or path is already indexed. Stats outside the lock.
    pub async fn insert(&self, key: &str, root: &Path, rel: &str) {
        {
            let idx = self.index.read().await;
            let Some(e) = idx.get(key) else {
                return;
            };
            if e.files.contains_key(rel) {
                return;
            }
        }

        let ts = stat_paths(root, vec![rel.to_string()], &HashMap::new())
            .await
            .remove(rel)
            .unwrap_or(0);

        let mut idx = self.index.write().await;
        let Some(e) = idx.get_mut(key) else {
            return;
        };
        if e.files.contains_key(rel) {
            return;
        }
        e.files.insert(rel.to_string(), ts);
        if let Some(ref mut pending) = e.pending {
            pending.push(Op::Insert(rel.to_string(), ts));
        }
    }

    pub async fn remove(&self, key: &str, rel: &str) {
        let mut idx = self.index.write().await;
        let Some(e) = idx.get_mut(key) else {
            return;
        };
        e.files.remove(rel);
        if let Some(ref mut pending) = e.pending {
            pending.push(Op::Remove(rel.to_string()));
        }
    }

    pub async fn merge_subtree(&self, key: &str, root: &Path, prefix: &str, files: Vec<String>) {
        // Copy only the requested paths' known timestamps (never the whole index).
        let known: HashMap<String, i64> = {
            let idx = self.index.read().await;
            let Some(e) = idx.get(key) else {
                return;
            };
            files
                .iter()
                .filter_map(|p| e.files.get(p).map(|&t| (p.clone(), t)))
                .collect()
        };

        let statted = if files.is_empty() {
            HashMap::new()
        } else {
            stat_paths(root, files, &known).await
        };

        let mut idx = self.index.write().await;
        let Some(e) = idx.get_mut(key) else {
            return;
        };
        let nested = format!("{prefix}/");
        e.files
            .retain(|p, _| p != prefix && !p.starts_with(&nested));
        if let Some(ref mut pending) = e.pending {
            pending.push(Op::Merge {
                prefix: prefix.to_string(),
                files: statted.clone(),
            });
        }
        e.files.extend(statted);
    }

    /// Ranked filename search. Never blocks on a re-walk of an entry that has
    /// data (it is served stale and refreshed in the background, single-flight
    /// per key). The FIRST query for a key waits up to `first_walk_wait`; if
    /// the walk is still running it answers `indexing: true` with no files.
    pub async fn search(
        self: &Arc<Self>,
        key: &str,
        root: &Path,
        query: &str,
        limit: usize,
    ) -> FileSearchResult {
        let epoch = self.evict_epoch(key);
        self.touch(key).await;
        self.maybe_sweep(key).await;

        if !self.is_fresh(key).await {
            if self.has_data(key).await {
                let _ = self.kick(key, root, epoch);
            } else {
                self.first_walk(key, root, epoch).await;
            }
        }
        if self.evict_epoch(key) != epoch {
            // Evicted (worktree/project deleted, last watcher closed) while
            // this request ran: there is no entry to serve. Report `indexing`
            // so the client asks again: the next query either starts a fresh
            // walk (last watcher closed) or gets a 404 from the route (the
            // project/worktree is gone), instead of showing a false "no files".
            return FileSearchResult {
                indexing: true,
                ..FileSearchResult::default()
            };
        }

        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let idx = self.index.read().await;
        match idx.get(key) {
            Some(e) if e.loaded => rank(query, &e.files, limit, now_ms),
            _ => FileSearchResult {
                indexing: true,
                ..Default::default()
            },
        }
    }

    async fn touch(&self, key: &str) {
        let idx = self.index.read().await;
        if let Some(e) = idx.get(key) {
            e.last_queried
                .store(self.nanos_since_epoch(Instant::now()), Ordering::Relaxed);
        }
    }

    async fn has_data(&self, key: &str) -> bool {
        self.index.read().await.get(key).is_some_and(|e| e.loaded)
    }
}

fn replay(files: &mut HashMap<String, i64>, ops: Vec<Op>) {
    for op in ops {
        match op {
            Op::Insert(path, ts) => {
                files.insert(path, ts);
            }
            Op::Remove(path) => {
                files.remove(&path);
            }
            Op::Merge {
                prefix,
                files: new_files,
            } => {
                files.retain(|p, _| p != &prefix && !p.starts_with(&format!("{prefix}/")));
                files.extend(new_files);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn index() -> Arc<FileSearchIndex> {
        Arc::new(FileSearchIndex::new(Arc::new(FileList::new())))
    }

    async fn seed(idx: &FileSearchIndex, key: &str, files: Vec<&str>) {
        let mut map = idx.index.write().await;
        let entry = map.entry(key.to_string()).or_insert_with(|| Entry {
            files: HashMap::new(),
            walked_at: Instant::now(),
            stale: false,
            pending: None,
            gen: NEXT_GEN.fetch_add(1, Ordering::SeqCst),
            retry_after: Instant::now(),
            loaded: true,
            rewalk_after: false,
            last_queried: AtomicU64::new(0),
        });
        for f in files {
            entry.files.insert(f.to_string(), 0);
        }
    }

    async fn all(idx: &FileSearchIndex, key: &str) -> HashSet<String> {
        idx.index
            .read()
            .await
            .get(key)
            .map(|e| e.files.keys().cloned().collect())
            .unwrap_or_default()
    }

    #[tokio::test]
    async fn prefix_match_ranks_above_fuzzy() {
        let idx = index();
        seed(
            &idx,
            "wt1",
            vec!["src/main.rs", "src/main_test.rs", "src/other/zzmain.rs"],
        )
        .await;

        let res = idx
            .search("wt1", Path::new("/nonexistent"), "main", 10)
            .await;

        assert!(!res.truncated);
        assert_eq!(res.files[0], "src/main.rs");
        assert!(res.files.contains(&"src/main_test.rs".to_string()));
    }

    #[tokio::test]
    async fn fuzzy_match_on_filename() {
        let idx = index();
        seed(
            &idx,
            "wt1",
            vec!["src/components/QuickOpen.tsx", "README.md"],
        )
        .await;

        let res = idx
            .search("wt1", Path::new("/nonexistent"), "qkopn", 10)
            .await;
        assert_eq!(res.files, vec!["src/components/QuickOpen.tsx".to_string()]);
    }

    #[tokio::test]
    async fn fuzzy_match_falls_back_to_full_path() {
        let idx = index();
        seed(
            &idx,
            "wt1",
            vec!["src/hooks/useWorktreeFiles.ts", "src/main.ts"],
        )
        .await;

        let res = idx
            .search("wt1", Path::new("/nonexistent"), "hooksuse", 10)
            .await;
        assert_eq!(res.files, vec!["src/hooks/useWorktreeFiles.ts".to_string()]);
    }

    #[tokio::test]
    async fn empty_query_returns_first_n_entries() {
        let idx = index();
        seed(&idx, "wt1", vec!["a.rs", "b.rs", "c.rs", "d.rs"]).await;

        let res = idx.search("wt1", Path::new("/nonexistent"), "", 2).await;
        assert_eq!(res.files.len(), 2);
        assert!(res.truncated);
    }

    #[tokio::test]
    async fn unknown_worktree_lazily_fills_from_disk() {
        let idx = index();
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("hello.txt"), "hi").unwrap();

        let res = idx.search("brand-new-wt", dir.path(), "hello", 10).await;
        assert_eq!(res.files, vec!["hello.txt".to_string()]);

        let res2 = idx
            .search("brand-new-wt", Path::new("/does/not/exist"), "hello", 10)
            .await;
        assert_eq!(res2.files, vec!["hello.txt".to_string()]);
    }

    #[tokio::test]
    async fn evict_then_search_finds_file_added_during_gap() {
        let idx = index();
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("before.txt"), "x").unwrap();

        let res = idx.search("wt1", dir.path(), "before", 10).await;
        assert_eq!(res.files, vec!["before.txt".to_string()]);

        idx.evict("wt1").await;

        fs::write(dir.path().join("after-gap.txt"), "y").unwrap();

        let res = idx.search("wt1", dir.path(), "after-gap", 10).await;
        assert_eq!(res.files, vec!["after-gap.txt".to_string()]);
    }

    #[tokio::test]
    async fn insert_on_unpopulated_worktree_is_noop() {
        let idx = index();
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("real.txt"), "x").unwrap();

        idx.insert("wt-unpop", dir.path(), "only-inserted.txt")
            .await;
        assert!(all(&idx, "wt-unpop").await.is_empty());

        let res = idx.search("wt-unpop", dir.path(), "", 100).await;
        assert!(res.files.contains(&"real.txt".to_string()));
        assert!(!res.files.contains(&"only-inserted.txt".to_string()));
    }

    #[tokio::test]
    async fn insert_and_remove_on_populated_worktree() {
        let idx = index();
        seed(&idx, "wt1", vec!["a.rs"]).await;

        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("b.rs"), "b").unwrap();

        idx.insert("wt1", dir.path(), "b.rs").await;
        let res = idx.search("wt1", Path::new("/nonexistent"), "b", 10).await;
        assert_eq!(res.files, vec!["b.rs".to_string()]);

        idx.remove("wt1", "b.rs").await;
        let res = idx.search("wt1", Path::new("/nonexistent"), "b", 10).await;
        assert!(res.files.is_empty());
    }

    #[tokio::test]
    async fn merge_subtree_replaces_under_prefix_only() {
        let idx = index();
        seed(
            &idx,
            "wt1",
            vec![
                "src/a.rs",
                "src/sub/old1.rs",
                "src/sub/nested/old2.rs",
                "other.rs",
            ],
        )
        .await;

        idx.merge_subtree(
            "wt1",
            Path::new("/nonexistent"),
            "src/sub",
            vec!["src/sub/new1.rs".to_string(), "src/sub/new2.rs".to_string()],
        )
        .await;

        let set = all(&idx, "wt1").await;
        assert!(set.contains("src/a.rs"));
        assert!(set.contains("other.rs"));
        assert!(!set.contains("src/sub/old1.rs"));
        assert!(!set.contains("src/sub/nested/old2.rs"));
        assert!(set.contains("src/sub/new1.rs"));
        assert!(set.contains("src/sub/new2.rs"));
    }

    #[tokio::test]
    async fn merge_subtree_with_empty_files_removes_subtree() {
        let idx = index();
        seed(
            &idx,
            "wt1",
            vec!["src/a.rs", "src/sub/x.rs", "src/sub/nested/y.rs", "keep.rs"],
        )
        .await;

        idx.merge_subtree("wt1", Path::new("/nonexistent"), "src/sub", vec![])
            .await;

        let set = all(&idx, "wt1").await;
        assert!(set.contains("src/a.rs"));
        assert!(set.contains("keep.rs"));
        assert!(!set.contains("src/sub/x.rs"));
        assert!(!set.contains("src/sub/nested/y.rs"));
    }

    #[tokio::test]
    async fn no_match_returns_empty() {
        let idx = index();
        seed(&idx, "wt1", vec!["a.rs"]).await;
        let res = idx
            .search("wt1", Path::new("/nonexistent"), "zzzzz-nope", 10)
            .await;
        assert!(res.files.is_empty());
        assert!(!res.truncated);
    }

    #[tokio::test]
    async fn query_case_is_ignored() {
        let idx = index();
        seed(&idx, "wt1", vec!["src/components/QuickOpen.tsx"]).await;

        for q in ["QUICKOPEN", "QuickOpen", "quickopen"] {
            let res = idx.search("wt1", Path::new("/nonexistent"), q, 10).await;
            assert_eq!(
                res.files,
                vec!["src/components/QuickOpen.tsx".to_string()],
                "query {q:?} should match case-insensitively"
            );
        }
    }

    // 1.T3 Unit — keys: index_key(Worktree,"x") != index_key(Project,"x"); same id under both scopes gives independent entries.
    #[tokio::test]
    async fn test_keys_independent_under_scopes() {
        let wt_key = index_key(WatchScope::Worktree, "abc");
        let proj_key = index_key(WatchScope::Project, "abc");
        assert_ne!(wt_key, proj_key);

        let idx = index();
        seed(&idx, &wt_key, vec!["worktree_file.txt"]).await;
        seed(&idx, &proj_key, vec!["project_file.txt"]).await;

        let wt_res = idx.search(&wt_key, Path::new("/nonexistent"), "", 10).await;
        let proj_res = idx
            .search(&proj_key, Path::new("/nonexistent"), "", 10)
            .await;

        assert_eq!(wt_res.files, vec!["worktree_file.txt".to_string()]);
        assert_eq!(proj_res.files, vec!["project_file.txt".to_string()]);
    }

    // 1.T4 Unit — TTL without sleeps:
    // with_ttl(fl, Duration::ZERO) -> create a file on disk between two searches, second search sees it and walk_count increments;
    // with_ttl(fl, Duration::from_secs(3600)) -> second search does not see it, walk_count == 1;
    // watch_started after an unwatched snapshot forces exactly one more re-walk then never expires; evict forces a re-walk.
    #[tokio::test]
    async fn test_ttl_and_watch_started() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("f1.txt"), "1").unwrap();

        // with_ttl(fl, Duration::ZERO)
        let idx_zero = Arc::new(FileSearchIndex::with_ttl(
            Arc::new(FileList::new()),
            Duration::ZERO,
        ));
        let res1 = idx_zero.search("k1", dir.path(), "", 10).await;
        assert_eq!(res1.files, vec!["f1.txt".to_string()]);
        assert_eq!(idx_zero.walk_count.load(Ordering::SeqCst), 1);

        fs::write(dir.path().join("f2.txt"), "2").unwrap();
        // Expired: the old snapshot is served and the refresh runs in the background.
        let res2 = idx_zero.search("k1", dir.path(), "", 10).await;
        assert_eq!(res2.files, vec!["f1.txt".to_string()]);
        idx_zero.settle("k1").await;
        assert_eq!(idx_zero.walk_count.load(Ordering::SeqCst), 2);
        let res2 = idx_zero.search("k1", dir.path(), "", 10).await;
        assert!(res2.files.contains(&"f2.txt".to_string()));

        // with_ttl(fl, Duration::from_secs(3600))
        let dir2 = tempfile::tempdir().unwrap();
        fs::write(dir2.path().join("g1.txt"), "1").unwrap();

        let idx_long = Arc::new(FileSearchIndex::with_ttl(
            Arc::new(FileList::new()),
            Duration::from_secs(3600),
        ));
        let r1 = idx_long.search("k2", dir2.path(), "", 10).await;
        assert_eq!(r1.files, vec!["g1.txt".to_string()]);
        assert_eq!(idx_long.walk_count.load(Ordering::SeqCst), 1);

        fs::write(dir2.path().join("g2.txt"), "2").unwrap();
        let r2 = idx_long.search("k2", dir2.path(), "", 10).await;
        assert!(!r2.files.contains(&"g2.txt".to_string()));
        assert_eq!(idx_long.walk_count.load(Ordering::SeqCst), 1);

        // watch_started after unwatched snapshot forces exactly one more re-walk then never expires
        idx_long.watch_started("k2").await;
        let _ = idx_long.search("k2", dir2.path(), "", 10).await;
        idx_long.settle("k2").await;
        let r3 = idx_long.search("k2", dir2.path(), "", 10).await;
        assert!(r3.files.contains(&"g2.txt".to_string()));
        assert_eq!(idx_long.walk_count.load(Ordering::SeqCst), 2);

        // After this, it never expires even if files change without watcher event
        fs::write(dir2.path().join("g3.txt"), "3").unwrap();
        let r4 = idx_long.search("k2", dir2.path(), "", 10).await;
        assert_eq!(idx_long.walk_count.load(Ordering::SeqCst), 2);
        assert!(!r4.files.contains(&"g3.txt".to_string()));

        // evict forces a re-walk
        idx_long.evict("k2").await;
        let r5 = idx_long.search("k2", dir2.path(), "", 10).await;
        assert!(r5.files.contains(&"g3.txt".to_string()));
        assert_eq!(idx_long.walk_count.load(Ordering::SeqCst), 3);
    }

    // 1.T5 Unit — concurrency:
    // build the index with FileSearchIndex::new (default 30 s TTL);
    // futures::future::join_all of 8 search calls on an absent key against a real temp dir -> walk_count == 1 and all results identical.
    #[tokio::test]
    async fn test_concurrency_single_walk() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("shared.txt"), "data").unwrap();

        let idx = Arc::new(FileSearchIndex::new(Arc::new(FileList::new())));
        let futures = (0..8).map(|_| {
            let idx = Arc::clone(&idx);
            let path = dir.path().to_path_buf();
            tokio::spawn(async move { idx.search("conc_key", &path, "", 10).await })
        });

        let results = futures::future::join_all(futures).await;
        assert_eq!(idx.walk_count.load(Ordering::SeqCst), 1);

        let first = results[0].as_ref().unwrap().files.clone();
        for res in results {
            assert_eq!(res.unwrap().files, first);
        }
    }

    // 1.T6 Unit — journal:
    // create added.rs on disk before the search. Using walk_hook: start search in a task,
    // wait on reached (the walk has already listed), then write late.rs to disk and call
    // insert(key, root, "added.rs") and insert(key, root, "late.rs"), signal release, join.
    // Assert: both files are in the results (late.rs only via journal replay),
    // entry stale == false and pending == None, and the next search does NOT re-walk.
    // Also: a remove of a walked path during the hook window is absent from the final results.
    #[tokio::test]
    async fn test_journal_replay_and_remove() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("initial.rs"), "").unwrap();
        fs::write(dir.path().join("to_remove.rs"), "").unwrap();

        let idx = Arc::new(FileSearchIndex::new(Arc::new(FileList::new())));
        let reached = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());

        idx.set_walk_hook(Arc::clone(&reached), Arc::clone(&release))
            .await;

        let idx_clone = Arc::clone(&idx);
        let path = dir.path().to_path_buf();
        let search_handle =
            tokio::spawn(async move { idx_clone.search("j_key", &path, "", 100).await });

        reached.notified().await;

        // While walk is paused:
        fs::write(dir.path().join("added.rs"), "").unwrap();
        fs::write(dir.path().join("late.rs"), "").unwrap();

        idx.insert("j_key", dir.path(), "added.rs").await;
        idx.insert("j_key", dir.path(), "late.rs").await;
        idx.remove("j_key", "to_remove.rs").await;

        release.notify_one();

        let res = search_handle.await.unwrap();
        assert!(res.files.contains(&"initial.rs".to_string()));
        assert!(res.files.contains(&"added.rs".to_string()));
        assert!(res.files.contains(&"late.rs".to_string()));
        assert!(
            !res.files.contains(&"to_remove.rs".to_string()),
            "removed file should not appear"
        );

        {
            let map = idx.index.read().await;
            let e = map.get("j_key").unwrap();
            assert!(!e.stale);
            assert!(e.pending.is_none());
        }

        let walks_before = idx.walk_count.load(Ordering::SeqCst);
        let res2 = idx.search("j_key", dir.path(), "", 100).await;
        assert_eq!(
            idx.walk_count.load(Ordering::SeqCst),
            walks_before,
            "next search does not re-walk"
        );
        assert_eq!(res.files, res2.files);
    }

    // 1.T7 Unit — gen guard:
    // with walk_hook, start search, wait on reached, call evict(key) then a second search
    // on the same key (new entry, new gen) completing its own walk; release the first walker
    // -> the entry still holds the second walk's data (first result discarded).
    #[tokio::test]
    async fn test_gen_guard_discards_stale_walker() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("v1.txt"), "1").unwrap();

        let idx = Arc::new(FileSearchIndex::new(Arc::new(FileList::new())));
        let reached = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());

        idx.set_walk_hook(Arc::clone(&reached), Arc::clone(&release))
            .await;

        let idx_clone = Arc::clone(&idx);
        let path = dir.path().to_path_buf();
        let search_handle1 =
            tokio::spawn(async move { idx_clone.search("gen_key", &path, "", 10).await });

        reached.notified().await;

        // Evict while first walk is paused, and add v2
        idx.evict("gen_key").await;
        fs::remove_file(dir.path().join("v1.txt")).unwrap();
        fs::write(dir.path().join("v2.txt"), "2").unwrap();

        // Clear hook so second search does not block
        {
            let mut g = idx.walk_hook.lock().await;
            *g = None;
        }

        // Second search runs and completes
        let res2 = idx.search("gen_key", dir.path(), "", 10).await;
        assert_eq!(res2.files, vec!["v2.txt".to_string()]);

        // Release first walker
        release.notify_one();
        let _ = search_handle1.await.unwrap();

        // Check entry: still has v2.txt (first walker was discarded)
        let res3 = idx.search("gen_key", dir.path(), "", 10).await;
        assert_eq!(res3.files, vec!["v2.txt".to_string()]);
    }

    // 1.T8 Unit — watch_started("k") before any entry, then search("k",…) with with_ttl(ZERO):
    // second search does NOT re-walk (watched_keys contains it); watch_started is idempotent; evict clears it.
    // Incremental: insert of an already-indexed path keeps its created_ms and is not journaled;
    // merge_subtree of a new directory stats its files (created_ms > 0).
    #[tokio::test]
    async fn test_watch_started_before_entry_and_incremental() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("file.txt"), "x").unwrap();

        let idx = Arc::new(FileSearchIndex::with_ttl(
            Arc::new(FileList::new()),
            Duration::ZERO,
        ));

        // watch_started before any entry
        idx.watch_started("k_early").await;
        idx.watch_started("k_early").await; // idempotent

        let r1 = idx.search("k_early", dir.path(), "", 10).await;
        assert_eq!(r1.files, vec!["file.txt".to_string()]);
        assert_eq!(idx.walk_count.load(Ordering::SeqCst), 1);

        // Even with ttl=ZERO, watched key does NOT re-walk
        let r2 = idx.search("k_early", dir.path(), "", 10).await;
        assert_eq!(r2.files, vec!["file.txt".to_string()]);
        assert_eq!(idx.walk_count.load(Ordering::SeqCst), 1);

        // evict clears watched_keys
        idx.evict("k_early").await;
        let r3 = idx.search("k_early", dir.path(), "", 10).await;
        assert_eq!(r3.files, vec!["file.txt".to_string()]);
        assert_eq!(idx.walk_count.load(Ordering::SeqCst), 2);

        // Incremental: insert of an already-indexed path keeps created_ms and is not journaled
        let (initial_ts, gen_before) = {
            let map = idx.index.read().await;
            let e = map.get("k_early").unwrap();
            (*e.files.get("file.txt").unwrap(), e.gen)
        };
        // Calling insert on already-indexed path
        idx.insert("k_early", dir.path(), "file.txt").await;
        {
            let map = idx.index.read().await;
            let e = map.get("k_early").unwrap();
            assert_eq!(*e.files.get("file.txt").unwrap(), initial_ts);
            assert_eq!(e.gen, gen_before);
            assert!(e.pending.is_none());
        }

        // merge_subtree of a new directory stats its files (created_ms > 0)
        let sub = dir.path().join("newdir");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("subfile.txt"), "sub").unwrap();

        idx.merge_subtree(
            "k_early",
            dir.path(),
            "newdir",
            vec!["newdir/subfile.txt".to_string()],
        )
        .await;

        {
            let map = idx.index.read().await;
            let e = map.get("k_early").unwrap();
            let ts = *e.files.get("newdir/subfile.txt").unwrap();
            assert!(ts > 0, "stat on merge_subtree should give ts > 0");
        }
    }

    #[tokio::test]
    async fn test_2_t1_walk_timeout_and_backoff() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("first.txt"), "hello").unwrap();

        let fl = Arc::new(FileList::new());
        let idx = Arc::new(FileSearchIndex::new(fl).with_walk_timeout(Duration::from_millis(50)));

        // Case A: first search on key with walk_delay = 500ms times out -> empty files, retry_after in future, pending None
        idx.set_walk_delay(Some(Duration::from_millis(500)));
        let start_fresh = Instant::now();
        let res_fresh = idx.search("k_fresh", dir.path(), "", 10).await;
        assert!(
            start_fresh.elapsed() < Duration::from_millis(300),
            "search should return promptly on timeout"
        );
        assert!(res_fresh.files.is_empty());
        assert!(res_fresh.indexing, "no data + listing timeout => indexing");
        {
            let map = idx.index.read().await;
            let e = map.get("k_fresh").unwrap();
            assert!(e.retry_after > Instant::now());
            assert!(e.pending.is_none());
        }
        // Second search inside backoff does not walk
        let res_fresh2 = idx.search("k_fresh", dir.path(), "", 10).await;
        assert!(res_fresh2.files.is_empty());
        assert_eq!(idx.walk_count.load(Ordering::SeqCst), 1);

        // Case B: key with previous entry's data
        idx.set_walk_delay(None);
        let res0 = idx.search("k_timeout", dir.path(), "", 10).await;
        assert_eq!(res0.files, vec!["first.txt".to_string()]);
        assert_eq!(idx.walk_count.load(Ordering::SeqCst), 2);

        // Make entry stale and set walk_delay = 500ms
        {
            let mut map = idx.index.write().await;
            let e = map.get_mut("k_timeout").unwrap();
            e.stale = true;
        }
        idx.set_walk_delay(Some(Duration::from_millis(500)));

        let start = Instant::now();
        let res1 = idx.search("k_timeout", dir.path(), "", 10).await;
        assert!(
            start.elapsed() < Duration::from_millis(300),
            "search should return promptly on timeout"
        );
        assert_eq!(res1.files, vec!["first.txt".to_string()]);
        idx.settle("k_timeout").await;
        assert_eq!(idx.walk_count.load(Ordering::SeqCst), 3);

        {
            let map = idx.index.read().await;
            let e = map.get("k_timeout").unwrap();
            assert!(e.retry_after > Instant::now());
            assert!(e.pending.is_none());
            assert!(e.stale);
        }

        // Second search inside backoff does not walk
        let res2 = idx.search("k_timeout", dir.path(), "", 10).await;
        assert_eq!(res2.files, vec!["first.txt".to_string()]);
        assert_eq!(idx.walk_count.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn test_2_t1_stat_phase_timeout_keeps_listing() {
        let dir = TempDir::new().unwrap();
        for n in 0..5 {
            fs::write(dir.path().join(format!("f{n}.txt")), "x").unwrap();
        }
        let fl = Arc::new(FileList::new());
        let idx = Arc::new(FileSearchIndex::new(fl).with_walk_timeout(Duration::from_millis(150)));
        // Each stat takes 100ms; the 150ms stat budget cannot cover 5 files.
        *idx.stat_delay.lock().unwrap() = Some(Duration::from_millis(100));

        let res = idx.search("k", dir.path(), "", 10).await;
        assert_eq!(res.files.len(), 5, "listing must survive a stat timeout");
        {
            let map = idx.index.read().await;
            let e = map.get("k").unwrap();
            assert!(e.stale, "incomplete stat leaves entry stale");
            assert!(e.files.values().any(|&t| t == 0));
            assert!(e.files.values().any(|&t| t > 0));
        }

        // Later walk (after backoff) backfills the un-stat'ed paths.
        *idx.stat_delay.lock().unwrap() = None;
        {
            let mut map = idx.index.write().await;
            map.get_mut("k").unwrap().retry_after = Instant::now();
        }
        let res = idx.search("k", dir.path(), "", 10).await;
        assert_eq!(res.files.len(), 5);
        idx.settle("k").await;
        let map = idx.index.read().await;
        let e = map.get("k").unwrap();
        assert!(!e.stale);
        assert!(e.files.values().all(|&t| t > 0));
    }

    #[tokio::test]
    async fn merge_subtree_delete_path_keeps_other_timestamps_and_journals() {
        let idx = index();
        seed(&idx, "wt1", vec!["src/sub/x.rs", "keep.rs"]).await;
        {
            let mut map = idx.index.write().await;
            let e = map.get_mut("wt1").unwrap();
            e.files.insert("keep.rs".into(), 777);
            e.pending = Some(Vec::new());
        }
        idx.merge_subtree("wt1", Path::new("/nonexistent"), "src/sub", vec![])
            .await;
        let map = idx.index.read().await;
        let e = map.get("wt1").unwrap();
        assert_eq!(e.files.get("keep.rs"), Some(&777));
        assert!(!e.files.contains_key("src/sub/x.rs"));
        assert!(matches!(
            e.pending.as_ref().unwrap().as_slice(),
            [Op::Merge { files, .. }] if files.is_empty()
        ));
    }

    async fn has_entry(idx: &FileSearchIndex, key: &str) -> bool {
        idx.index.read().await.contains_key(key)
    }

    #[tokio::test]
    async fn evict_scope_and_project_tree_free_entries_and_state() {
        let idx = index();
        let wt = index_key(WatchScope::Worktree, "w1");
        let wt2 = index_key(WatchScope::Worktree, "w2");
        let pr = index_key(WatchScope::Project, "p1");
        let other = index_key(WatchScope::Worktree, "keep");
        for k in [&wt, &wt2, &pr, &other] {
            seed(&idx, k, vec!["a.rs"]).await;
        }
        idx.watch_started(&wt).await;
        let _ = idx.walk_lock(&wt);

        idx.evict_scope(WatchScope::Worktree, "w1").await;
        assert!(!has_entry(&idx, &wt).await);
        assert!(!idx.is_watched(&wt), "watched key dropped");
        assert!(!idx.walk_locks.lock().unwrap().contains_key(&wt));

        idx.evict_project_tree("p1", vec!["w2".to_string()]).await;
        assert!(!has_entry(&idx, &wt2).await);
        assert!(!has_entry(&idx, &pr).await);
        assert!(has_entry(&idx, &other).await, "unrelated key untouched");
    }

    #[tokio::test]
    async fn sweep_drops_idle_unwatched_but_not_watched_or_current() {
        let idx = index();
        for k in ["idle", "watched", "current", "recent"] {
            seed(&idx, k, vec!["a.rs"]).await;
        }
        idx.watch_started("watched").await;
        // "recent" was queried just now; the rest were last queried at epoch.
        idx.touch("recent").await;

        // Nothing is idle yet at t = now.
        idx.sweep_idle_at(Instant::now(), None).await;
        assert!(has_entry(&idx, "idle").await);

        // Jump past the idle timeout: even the just-touched "recent" entry is
        // now idle, since idleness is measured against this later `now`.
        let later = Instant::now() + DEFAULT_IDLE_TIMEOUT + Duration::from_secs(1);
        idx.sweep_idle_at(later, Some("current")).await;
        assert!(!has_entry(&idx, "idle").await, "idle unwatched dropped");
        assert!(
            !has_entry(&idx, "recent").await,
            "idle past timeout dropped"
        );
        assert!(
            has_entry(&idx, "watched").await,
            "watched never idle-evicted"
        );
        assert!(has_entry(&idx, "current").await, "queried key excepted");
    }

    #[tokio::test]
    async fn search_runs_lazy_sweep_at_most_once_per_interval() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), "a").unwrap();
        let build = |interval| {
            Arc::new(
                FileSearchIndex::new(Arc::new(FileList::new()))
                    .with_idle_timeout(Duration::ZERO)
                    .with_sweep_interval(interval),
            )
        };

        // Zero interval: querying B sweeps the (zero-timeout idle) A, keeps B.
        let idx = build(Duration::ZERO);
        idx.search("a", dir.path(), "", 10).await;
        assert!(has_entry(&idx, "a").await);
        idx.search("b", dir.path(), "", 10).await;
        assert!(!has_entry(&idx, "a").await, "idle entry swept by search");
        assert!(has_entry(&idx, "b").await, "queried entry kept");

        // Long interval: no sweep from search, even with a zero idle timeout.
        let idx = build(Duration::from_secs(3600));
        idx.search("a", dir.path(), "", 10).await;
        idx.search("b", dir.path(), "", 10).await;
        assert!(has_entry(&idx, "a").await, "sweep throttled");
    }

    #[tokio::test]
    async fn expired_entry_is_served_stale_and_refreshed_in_background() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("old.txt"), "1").unwrap();
        let idx = Arc::new(FileSearchIndex::with_ttl(
            Arc::new(FileList::new()),
            Duration::ZERO,
        ));
        let r = idx.search("k", dir.path(), "", 10).await;
        assert_eq!(r.files, vec!["old.txt".to_string()]);
        assert!(!r.indexing);

        // Park the next (refresh) walk after it listed the directory.
        let reached = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        idx.set_walk_hook(Arc::clone(&reached), Arc::clone(&release))
            .await;
        fs::write(dir.path().join("new.txt"), "2").unwrap();

        let r = tokio::time::timeout(
            Duration::from_millis(500),
            idx.search("k", dir.path(), "", 10),
        )
        .await
        .expect("expired query must not block on the re-walk");
        assert_eq!(r.files, vec!["old.txt".to_string()], "old snapshot served");
        assert!(!r.indexing, "data exists => not indexing");

        reached.notified().await; // refresh is running (and parked)
                                  // A concurrent incremental update during the refresh is journaled.
        fs::write(dir.path().join("live.txt"), "3").unwrap();
        idx.insert("k", dir.path(), "live.txt").await;
        {
            let mut g = idx.walk_hook.lock().await;
            *g = None;
        }
        release.notify_one();
        idx.settle("k").await;

        let r = idx.search("k", dir.path(), "", 10).await;
        assert!(r.files.contains(&"live.txt".to_string()), "journal kept");
        idx.settle("k").await;
        let r = idx.search("k", dir.path(), "", 10).await;
        assert!(
            r.files.contains(&"new.txt".to_string()),
            "later query sees refresh"
        );
    }

    #[tokio::test]
    async fn concurrent_expired_queries_share_one_background_walk() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("f.txt"), "1").unwrap();
        let idx = Arc::new(FileSearchIndex::with_ttl(
            Arc::new(FileList::new()),
            Duration::ZERO,
        ));
        idx.search("k", dir.path(), "", 10).await;
        assert_eq!(idx.walk_count.load(Ordering::SeqCst), 1);

        let reached = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        idx.set_walk_hook(Arc::clone(&reached), Arc::clone(&release))
            .await;

        let results = futures::future::join_all((0..8).map(|_| {
            let idx = Arc::clone(&idx);
            let path = dir.path().to_path_buf();
            tokio::spawn(async move { idx.search("k", &path, "", 10).await })
        }))
        .await;
        for r in results {
            assert_eq!(r.unwrap().files, vec!["f.txt".to_string()]);
        }
        reached.notified().await;
        {
            let mut g = idx.walk_hook.lock().await;
            *g = None;
        }
        release.notify_one();
        idx.settle("k").await;
        assert_eq!(
            idx.walk_count.load(Ordering::SeqCst),
            2,
            "8 expired queries => exactly one refresh walk"
        );
    }

    #[tokio::test]
    async fn first_query_reports_indexing_then_data() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), "1").unwrap();
        let idx = Arc::new(
            FileSearchIndex::new(Arc::new(FileList::new()))
                .with_first_walk_wait(Duration::from_millis(20)),
        );
        idx.set_walk_delay(Some(Duration::from_millis(400)));

        let start = Instant::now();
        let r = idx.search("k", dir.path(), "", 10).await;
        assert!(
            start.elapsed() < Duration::from_millis(300),
            "returns promptly"
        );
        assert!(r.indexing);
        assert!(r.files.is_empty());
        assert!(!r.truncated);

        // Concurrent first queries join the one running walk.
        let r2 = idx.search("k", dir.path(), "", 10).await;
        assert!(r2.indexing);
        assert_eq!(idx.walk_count.load(Ordering::SeqCst), 1, "single flight");

        idx.settle("k").await;
        let r3 = idx.search("k", dir.path(), "", 10).await;
        assert_eq!(r3.files, vec!["a.txt".to_string()]);
        assert!(!r3.indexing, "indexing clears once data exists");
    }

    #[tokio::test]
    async fn empty_directory_is_loaded_not_indexing() {
        let dir = tempfile::tempdir().unwrap();
        let idx = index();
        let r = idx.search("k", dir.path(), "", 10).await;
        assert!(r.files.is_empty());
        assert!(!r.indexing, "an empty but walked tree is not 'indexing'");
    }

    #[tokio::test]
    async fn evict_during_first_walk_does_not_join_the_doomed_walk() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("v.txt"), "1").unwrap();
        let idx = Arc::new(FileSearchIndex::new(Arc::new(FileList::new())));
        let reached = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        idx.set_walk_hook(Arc::clone(&reached), Arc::clone(&release))
            .await;
        let i2 = Arc::clone(&idx);
        let p = dir.path().to_path_buf();
        let first = tokio::spawn(async move { i2.search("k", &p, "", 10).await });
        reached.notified().await;
        idx.evict("k").await;
        {
            let mut g = idx.walk_hook.lock().await;
            *g = None;
        }
        let r = idx.search("k", dir.path(), "", 10).await;
        assert_eq!(r.files, vec!["v.txt".to_string()]);
        release.notify_one();
        let _ = first.await;
    }
}

#[cfg(test)]
mod lifecycle_tests;
