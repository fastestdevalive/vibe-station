//! `PathWatcher` — a bounded watcher over the files review comments point at,
//! plus the git state files of the worktrees that have diff comments.
//!
//! It is the one `notify` watcher of the daemon for that job (the inotify
//! instance cap is 128 on stock Linux, so one per scope would not scale) and it
//! is bounded by DIRECTORIES, not files: spike C4 measured FSEvents `watch()` at
//! roughly O(N^2) in the number of registrations (2000 file paths took 46 s,
//! 200 directory watches 0.54 s). A file is watched by watching its parent
//! directory non-recursively and filtering events to the registered paths, the
//! same idea as [`crate::file_watcher::FileWatcher::watch_file`] (which is
//! unusable here because it creates one `notify` watcher per file).
//!
//! - At most [`WATCHED_DIR_LIMIT`] directories are watched. When more are asked
//!   for, the directory whose NEWEST registration is oldest is unwatched and
//!   announced as [`WatchEvent::Evicted`]; when a slot frees it is watched again
//!   ([`WatchEvent::Restored`]), newest first.
//! - Registration touches the filesystem, so it always runs on
//!   `spawn_blocking` and is serialised by one async lock; the state mutex is
//!   never held across an await.
//! - The git state files of a worktree (`HEAD`, `index`, `logs/HEAD` of its git
//!   dir; for a linked worktree that dir lives outside the worktree root) are
//!   outside the budget: a few directories per worktree with a diff comment.
//! - Raw events become [`WatchEvent`]s on a lossy broadcast channel; a lagging
//!   receiver must resync (the owner re-checks everything).
//! - `Access` events are ignored, so reading a file never wakes its watcher.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use notify::{RecursiveMode, Watcher as NotifyWatcher};
use tokio::sync::{broadcast, mpsc};
use vst_types::artifacts::ScopeKey;

/// Most directories watched at once (spike C4).
pub const WATCHED_DIR_LIMIT: usize = 200;

const EVENT_CHANNEL: usize = 1024;

/// A registered path of a scope, as the caller gave it.
pub type Registration = (ScopeKey, PathBuf);

/// What the watcher reports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WatchEvent {
    /// Something happened to a registered path (created, changed, removed, moved).
    PathChanged { scope: ScopeKey, path: PathBuf },
    /// `HEAD`, `index` or `logs/HEAD` of the worktree's git dir changed.
    GitStateChanged { worktree_id: String },
    /// These paths lost their directory watch (over the budget).
    Evicted { paths: Vec<Registration> },
    /// These paths are watched again.
    Restored { paths: Vec<Registration> },
}

/// The OS watch API for directories. The real one is [`NotifyBackend`]; tests
/// inject a fake (for instance one whose `watch_dir` blocks).
pub trait DirBackend: Send + Sync + 'static {
    /// Start a NON-recursive watch of `dir`. Blocking.
    ///
    /// # Errors
    /// A message when the watch could not be established.
    fn watch_dir(&self, dir: &Path) -> Result<(), String>;
    /// Stop watching `dir`. Blocking, best-effort.
    fn unwatch_dir(&self, dir: &Path);
}

/// One `notify` watcher shared by every registration.
pub struct NotifyBackend {
    watcher: Mutex<notify::RecommendedWatcher>,
}

impl NotifyBackend {
    /// Build the watcher; every non-`Access` event path goes to `raw`.
    ///
    /// # Errors
    /// The `notify` error when the OS watcher cannot be created.
    pub fn new(raw: mpsc::UnboundedSender<PathBuf>) -> Result<Self, notify::Error> {
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(ev) = res else { return };
            if matches!(ev.kind, notify::EventKind::Access(_)) {
                return;
            }
            for p in ev.paths {
                let _ = raw.send(p);
            }
        })?;
        Ok(NotifyBackend {
            watcher: Mutex::new(watcher),
        })
    }
}

impl DirBackend for NotifyBackend {
    fn watch_dir(&self, dir: &Path) -> Result<(), String> {
        self.watcher
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .watch(dir, RecursiveMode::NonRecursive)
            .map_err(|e| e.to_string())
    }

    fn unwatch_dir(&self, dir: &Path) {
        let _ = self
            .watcher
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .unwatch(dir);
    }
}

#[derive(Default)]
struct DirEntry {
    /// Registration -> stamp (larger = newer; opaque ordered text).
    paths: HashMap<Registration, String>,
    /// Insertion order, the tie-break between equal stamps.
    seq: u64,
    watched: bool,
    /// Lost its watch to the budget (cleared when it is restored).
    evicted: bool,
    /// The backend refused the watch (directory gone, OS limit); retried on demand.
    failed: bool,
}

impl DirEntry {
    fn newest(&self) -> &str {
        self.paths.values().map(String::as_str).max().unwrap_or("")
    }
}

struct GitEntry {
    dirs: Vec<PathBuf>,
    files: Vec<PathBuf>,
}

#[derive(Default)]
struct State {
    limit: usize,
    /// Canonical parent dir -> entry.
    dirs: HashMap<PathBuf, DirEntry>,
    /// Event path (as given and canonical) -> registrations.
    index: HashMap<PathBuf, Vec<Registration>>,
    git: HashMap<String, GitEntry>,
    git_files: HashMap<PathBuf, String>,
    /// Directory -> how many owners need the backend watch.
    phys: HashMap<PathBuf, usize>,
    next_seq: u64,
}

/// Backend work decided under the state lock, run after it is released.
#[derive(Default)]
struct Plan {
    watch: Vec<PathBuf>,
    unwatch: Vec<PathBuf>,
    evicted: Vec<Registration>,
    restored: Vec<Registration>,
}

impl State {
    fn phys_inc(&mut self, dir: &Path, plan: &mut Plan) {
        let n = self.phys.entry(dir.to_path_buf()).or_insert(0);
        *n += 1;
        if *n == 1 {
            plan.watch.push(dir.to_path_buf());
        }
    }

    fn phys_dec(&mut self, dir: &Path, plan: &mut Plan) {
        if let Some(n) = self.phys.get_mut(dir) {
            *n -= 1;
            if *n == 0 {
                self.phys.remove(dir);
                plan.unwatch.push(dir.to_path_buf());
            }
        }
    }

    /// Bring the watched set in line with the budget.
    fn rebalance(&mut self, plan: &mut Plan) {
        let mut order: Vec<(&PathBuf, String, u64)> = self
            .dirs
            .iter()
            .filter(|(_, e)| !e.failed)
            .map(|(d, e)| (d, e.newest().to_string(), e.seq))
            .collect();
        order.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.cmp(&a.2)));
        let keep: HashSet<PathBuf> = order
            .iter()
            .take(self.limit)
            .map(|(d, _, _)| (*d).clone())
            .collect();
        let dirs: Vec<PathBuf> = self.dirs.keys().cloned().collect();
        for dir in dirs {
            let want = keep.contains(&dir);
            let Some(entry) = self.dirs.get(&dir) else {
                continue;
            };
            let (was_watched, was_evicted) = (entry.watched, entry.evicted);
            let regs: Vec<Registration> = entry.paths.keys().cloned().collect();
            if want && !was_watched {
                self.phys_inc(&dir, plan);
                if let Some(e) = self.dirs.get_mut(&dir) {
                    e.watched = true;
                    e.evicted = false;
                }
                if was_evicted {
                    plan.restored.extend(regs);
                }
            } else if !want && was_watched {
                self.phys_dec(&dir, plan);
                if let Some(e) = self.dirs.get_mut(&dir) {
                    e.watched = false;
                    e.evicted = true;
                }
                plan.evicted.extend(regs);
            } else if !want && !was_evicted && !entry.failed {
                // Never got a slot: announce once.
                if let Some(e) = self.dirs.get_mut(&dir) {
                    e.evicted = true;
                }
                plan.evicted.extend(regs);
            }
        }
    }

    fn index_add(&mut self, key: PathBuf, reg: &Registration) {
        let v = self.index.entry(key).or_default();
        if !v.contains(reg) {
            v.push(reg.clone());
        }
    }

    fn index_remove(&mut self, key: &Path, reg: &Registration) {
        if let Some(v) = self.index.get_mut(key) {
            v.retain(|r| r != reg);
            if v.is_empty() {
                self.index.remove(key);
            }
        }
    }

    fn classify(&self, p: &Path) -> Vec<WatchEvent> {
        let mut out = Vec::new();
        if let Some(regs) = self.index.get(p) {
            for (scope, path) in regs {
                out.push(WatchEvent::PathChanged {
                    scope: scope.clone(),
                    path: path.clone(),
                });
            }
        }
        if let Some(wt) = self.git_files.get(p) {
            out.push(WatchEvent::GitStateChanged {
                worktree_id: wt.clone(),
            });
        }
        out
    }
}

struct Shared {
    state: Arc<Mutex<State>>,
    events: broadcast::Sender<WatchEvent>,
    backend: Arc<dyn DirBackend>,
    /// Serialises plan + execution so state and backend never disagree.
    op: tokio::sync::Mutex<()>,
    /// Keeps the raw channel open for as long as the watcher lives.
    _raw: mpsc::UnboundedSender<PathBuf>,
}

/// Handle to the bounded watcher. Clone is cheap.
#[derive(Clone)]
pub struct PathWatcher(Arc<Shared>);

impl std::fmt::Debug for PathWatcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PathWatcher").finish_non_exhaustive()
    }
}

fn lock(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn canonical_dir(dir: &Path) -> PathBuf {
    std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf())
}

impl PathWatcher {
    /// The daemon's watcher: one `notify` backend, [`WATCHED_DIR_LIMIT`] dirs.
    /// Must be called inside a tokio runtime (it spawns the event dispatcher).
    ///
    /// # Errors
    /// The `notify` error when the OS watcher cannot be created.
    pub fn native() -> Result<Self, notify::Error> {
        let (tx, rx) = mpsc::unbounded_channel();
        let backend = Arc::new(NotifyBackend::new(tx.clone())?);
        Ok(Self::build(backend, tx, rx, WATCHED_DIR_LIMIT))
    }

    /// A watcher over a custom backend (tests). `make` receives the sender the
    /// backend feeds raw event paths into. Must be called inside a tokio runtime.
    pub fn with_backend(
        make: impl FnOnce(mpsc::UnboundedSender<PathBuf>) -> Arc<dyn DirBackend>,
        limit: usize,
    ) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let backend = make(tx.clone());
        Self::build(backend, tx, rx, limit)
    }

    fn build(
        backend: Arc<dyn DirBackend>,
        tx: mpsc::UnboundedSender<PathBuf>,
        mut rx: mpsc::UnboundedReceiver<PathBuf>,
        limit: usize,
    ) -> Self {
        let state = Arc::new(Mutex::new(State {
            limit,
            ..State::default()
        }));
        let (events, _) = broadcast::channel(EVENT_CHANNEL);
        let (st, ev) = (Arc::clone(&state), events.clone());
        tokio::spawn(async move {
            while let Some(p) = rx.recv().await {
                let found = lock(&st).classify(&p);
                for e in found {
                    let _ = ev.send(e);
                }
            }
        });
        PathWatcher(Arc::new(Shared {
            state,
            events,
            backend,
            op: tokio::sync::Mutex::new(()),
            _raw: tx,
        }))
    }

    /// Follow what happens to registered paths. On `RecvError::Lagged` events
    /// were lost: re-check everything.
    pub fn subscribe(&self) -> broadcast::Receiver<WatchEvent> {
        self.0.events.subscribe()
    }

    /// Watch `path` of `scope`. `stamp` orders registrations by recency (larger
    /// is newer); calling again for the same path only refreshes its stamp.
    pub async fn watch(&self, scope: &ScopeKey, path: &Path, stamp: &str) {
        let _op = self.0.op.lock().await;
        let Some(parent) = path.parent().map(Path::to_path_buf) else {
            return;
        };
        let name = path.file_name().map(std::ffi::OsStr::to_os_string);
        let canon = {
            let p = parent.clone();
            tokio::task::spawn_blocking(move || canonical_dir(&p))
                .await
                .unwrap_or(parent)
        };
        let reg: Registration = (scope.clone(), path.to_path_buf());
        let mut plan = Plan::default();
        {
            let mut st = lock(&self.0.state);
            // A parent that did not exist (or was spelled through a symlink)
            // when this path was first watched is keyed by another spelling:
            // drop that stale entry so one registration lives in one dir.
            Self::remove_from_dirs(&mut st, &reg, Some(&canon), &mut plan);
            st.next_seq += 1;
            let seq = st.next_seq;
            let entry = st.dirs.entry(canon.clone()).or_insert_with(|| DirEntry {
                seq,
                ..DirEntry::default()
            });
            entry.paths.insert(reg.clone(), stamp.to_string());
            st.index_add(path.to_path_buf(), &reg);
            if let Some(name) = name {
                st.index_add(canon.join(name), &reg);
            }
            st.rebalance(&mut plan);
        }
        self.execute(plan).await;
    }

    /// Stop watching `path` of `scope`; frees its directory's slot with the last
    /// path (and re-watches an evicted directory in its place).
    pub async fn unwatch(&self, scope: &ScopeKey, path: &Path) {
        let _op = self.0.op.lock().await;
        let mut plan = Plan::default();
        {
            let mut st = lock(&self.0.state);
            Self::remove_registration(&mut st, scope, path, &mut plan);
            st.rebalance(&mut plan);
        }
        self.execute(plan).await;
    }

    /// Drop every registration of `scope`.
    pub async fn unwatch_scope(&self, scope: &ScopeKey) {
        let _op = self.0.op.lock().await;
        let mut plan = Plan::default();
        {
            let mut st = lock(&self.0.state);
            let paths: Vec<PathBuf> = st
                .dirs
                .values()
                .flat_map(|e| e.paths.keys())
                .filter(|(s, _)| s == scope)
                .map(|(_, p)| p.clone())
                .collect();
            for p in paths {
                Self::remove_registration(&mut st, scope, &p, &mut plan);
            }
            st.rebalance(&mut plan);
        }
        self.execute(plan).await;
    }

    fn remove_registration(st: &mut State, scope: &ScopeKey, path: &Path, plan: &mut Plan) {
        let reg: Registration = (scope.clone(), path.to_path_buf());
        Self::remove_from_dirs(st, &reg, None, plan);
    }

    /// Remove `reg` from EVERY directory entry holding it (except `keep`),
    /// freeing the entries it leaves empty.
    fn remove_from_dirs(st: &mut State, reg: &Registration, keep: Option<&Path>, plan: &mut Plan) {
        let path = &reg.1;
        let dirs: Vec<PathBuf> = st
            .dirs
            .iter()
            .filter(|(d, e)| e.paths.contains_key(reg) && keep != Some(d.as_path()))
            .map(|(d, _)| d.clone())
            .collect();
        for dir in dirs {
            st.index_remove(path, reg);
            if let Some(name) = path.file_name() {
                st.index_remove(&dir.join(name), reg);
            }
            let empty = st.dirs.get_mut(&dir).is_some_and(|e| {
                e.paths.remove(reg);
                e.paths.is_empty()
            });
            if empty {
                if let Some(e) = st.dirs.remove(&dir) {
                    if e.watched {
                        st.phys_dec(&dir, plan);
                    }
                }
            }
        }
    }

    /// The registered paths of `scope` with their stamps.
    pub fn registered(&self, scope: &ScopeKey) -> HashMap<PathBuf, String> {
        let st = lock(&self.0.state);
        st.dirs
            .values()
            .flat_map(|e| e.paths.iter())
            .filter(|((s, _), _)| s == scope)
            .map(|((_, p), stamp)| (p.clone(), stamp.clone()))
            .collect()
    }

    /// Is this path registered but without a directory watch (over the budget)?
    pub fn is_evicted(&self, scope: &ScopeKey, path: &Path) -> bool {
        let reg: Registration = (scope.clone(), path.to_path_buf());
        lock(&self.0.state)
            .dirs
            .values()
            .any(|e| e.evicted && e.paths.contains_key(&reg))
    }

    /// How many directories currently hold a watch (git state dirs excluded).
    pub fn watched_dir_count(&self) -> usize {
        lock(&self.0.state)
            .dirs
            .values()
            .filter(|e| e.watched)
            .count()
    }

    /// Does any directory wait for a retry after a failed registration?
    pub fn has_failed(&self) -> bool {
        lock(&self.0.state).dirs.values().any(|e| e.failed)
    }

    /// Try again the directories whose watch failed (they may exist now).
    pub async fn retry_failed(&self) {
        let _op = self.0.op.lock().await;
        let mut plan = Plan::default();
        {
            let mut st = lock(&self.0.state);
            for e in st.dirs.values_mut() {
                e.failed = false;
            }
            st.rebalance(&mut plan);
        }
        self.execute(plan).await;
    }

    /// Watch the git state files of `worktree_id` (`git_dir` is its absolute git
    /// dir). Outside the directory budget. Idempotent; replaces a different dir.
    pub async fn watch_git_state(&self, worktree_id: &str, git_dir: &Path) {
        let _op = self.0.op.lock().await;
        let git_dir = git_dir.to_path_buf();
        let (canon, has_logs) = {
            let g = git_dir.clone();
            tokio::task::spawn_blocking(move || {
                let canon = canonical_dir(&g);
                let logs = canon.join("logs").is_dir();
                (canon, logs)
            })
            .await
            .unwrap_or((git_dir.clone(), false))
        };
        let mut dirs = vec![canon.clone()];
        let mut files = vec![
            canon.join("HEAD"),
            canon.join("index"),
            canon.join("logs").join("HEAD"),
        ];
        if has_logs {
            dirs.push(canon.join("logs"));
        }
        for f in ["HEAD", "index"] {
            files.push(git_dir.join(f));
        }
        files.push(git_dir.join("logs").join("HEAD"));
        let mut plan = Plan::default();
        {
            let mut st = lock(&self.0.state);
            if st.git.get(worktree_id).is_some_and(|g| g.dirs == dirs) {
                return;
            }
            Self::remove_git(&mut st, worktree_id, &mut plan);
            for d in &dirs {
                st.phys_inc(d, &mut plan);
            }
            for f in &files {
                st.git_files.insert(f.clone(), worktree_id.to_string());
            }
            st.git
                .insert(worktree_id.to_string(), GitEntry { dirs, files });
        }
        self.execute(plan).await;
    }

    /// Stop watching the git state files of `worktree_id`.
    pub async fn unwatch_git_state(&self, worktree_id: &str) {
        let _op = self.0.op.lock().await;
        let mut plan = Plan::default();
        {
            let mut st = lock(&self.0.state);
            Self::remove_git(&mut st, worktree_id, &mut plan);
        }
        self.execute(plan).await;
    }

    fn remove_git(st: &mut State, worktree_id: &str, plan: &mut Plan) {
        if let Some(g) = st.git.remove(worktree_id) {
            for f in &g.files {
                st.git_files.remove(f);
            }
            for d in &g.dirs {
                st.phys_dec(d, plan);
            }
        }
    }

    /// Whether `worktree_id` currently has its git state watched.
    pub fn watches_git_state(&self, worktree_id: &str) -> bool {
        lock(&self.0.state).git.contains_key(worktree_id)
    }

    /// Run the backend work of a plan on blocking threads, then announce it.
    /// A failed directory watch is excluded and the budget rebalanced again, so a
    /// dead directory never keeps a healthy one out of its slot; evict/restore
    /// pairs that cancel within one call are not announced.
    async fn execute(&self, plan: Plan) {
        let mut plan = plan;
        let mut evicted: Vec<Registration> = Vec::new();
        let mut restored: Vec<Registration> = Vec::new();
        loop {
            let Plan {
                watch,
                unwatch,
                evicted: ev,
                restored: re,
            } = plan;
            for r in ev {
                if let Some(i) = restored.iter().position(|x| *x == r) {
                    restored.swap_remove(i);
                } else {
                    evicted.push(r);
                }
            }
            for r in re {
                if let Some(i) = evicted.iter().position(|x| *x == r) {
                    evicted.swap_remove(i);
                } else {
                    restored.push(r);
                }
            }
            if !unwatch.is_empty() {
                let backend = Arc::clone(&self.0.backend);
                let _ = tokio::task::spawn_blocking(move || {
                    for d in &unwatch {
                        backend.unwatch_dir(d);
                    }
                })
                .await;
            }
            let mut any_failed = false;
            for dir in watch {
                let backend = Arc::clone(&self.0.backend);
                let d = dir.clone();
                let res = tokio::task::spawn_blocking(move || backend.watch_dir(&d))
                    .await
                    .unwrap_or_else(|e| Err(e.to_string()));
                if let Err(e) = res {
                    any_failed = true;
                    tracing::warn!(dir = %dir.display(), "[vst] directory watch failed: {e}");
                    let mut st = lock(&self.0.state);
                    st.phys.remove(&dir);
                    if let Some(entry) = st.dirs.get_mut(&dir) {
                        entry.watched = false;
                        entry.failed = true;
                        // Neither evicted nor restored: nothing is announced for it.
                        let regs: HashSet<Registration> = entry.paths.keys().cloned().collect();
                        evicted.retain(|r| !regs.contains(r));
                        restored.retain(|r| !regs.contains(r));
                    }
                    // A git-state entry whose directory cannot be watched would
                    // claim a watch it does not have: drop it so the owner
                    // re-registers it on its next sync.
                    let broken: Vec<String> = st
                        .git
                        .iter()
                        .filter(|(_, g)| g.dirs.contains(&dir))
                        .map(|(id, _)| id.clone())
                        .collect();
                    for id in broken {
                        tracing::warn!(worktree_id = %id, "[vst] git state watch dropped after a failed directory watch");
                        let mut next = Plan::default();
                        Self::remove_git(&mut st, &id, &mut next);
                        // Only unwatches matter here; collected below.
                        plan_unwatch_now(&self.0.backend, next.unwatch);
                    }
                }
            }
            if !any_failed {
                break;
            }
            let mut next = Plan::default();
            lock(&self.0.state).rebalance(&mut next);
            if next.watch.is_empty()
                && next.unwatch.is_empty()
                && next.evicted.is_empty()
                && next.restored.is_empty()
            {
                break;
            }
            plan = next;
        }
        if !evicted.is_empty() {
            let _ = self.0.events.send(WatchEvent::Evicted { paths: evicted });
        }
        if !restored.is_empty() {
            let _ = self.0.events.send(WatchEvent::Restored { paths: restored });
        }
    }
}

/// Unwatch directories synchronously (a cheap backend call, used on the failure
/// path while the state lock is held).
fn plan_unwatch_now(backend: &Arc<dyn DirBackend>, dirs: Vec<PathBuf>) {
    for d in &dirs {
        backend.unwatch_dir(d);
    }
}
