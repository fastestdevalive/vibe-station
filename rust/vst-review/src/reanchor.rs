//! Re-anchoring: keep every comment's anchor true to the file as it is now.
//!
//! Triggers are push-only (no polling): the bounded [`PathWatcher`] reports
//! changes of commented files and of a worktree's git state, and the artifacts
//! owner reports moves and disappearances of artifact files. Events mark a scope
//! dirty; a scope is re-checked 500 ms after its LAST event (never later than 5 s
//! after its first), one pass in flight per scope, and the results leave as the
//! owner's usual coalesced `comments:changed` (one event per scope per window).
//!
//! - Content changes re-anchor the comments of the changed path; a HEAD / index
//!   change re-anchors only the diff-surface comments of that worktree.
//! - A repo file that vanished is followed through `git diff -M` renames
//!   (`rename_map`), otherwise it is `file_missing`; an artifact that vanished
//!   additionally goes through `ArtifactsHandle::revalidate_paths` so the
//!   Artifacts list agrees (R114). An artifact `Moved` event rewrites the path
//!   and records `movedFrom`.
//! - A watcher or artifact-stream `Lagged` means events were lost: everything is
//!   re-checked (artifacts via `list(scope)`).
//! - A failed read or git call keeps the last known anchor.
//! - Paths whose directory lost its watch (over budget) are `cant_check`
//!   (`watch_limit`) until the slot returns.
//!
//! Bodies are never logged: only ids, counts and scope ids.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{broadcast, Notify, Semaphore};
use tokio::time::Instant;
use vst_artifacts::{ArtifactChange, ReadOutcome, ScopeResolver};
use vst_fswatch::path_watcher::{PathWatcher, WatchEvent};
use vst_store::comments::AnchorUpdate;
use vst_types::artifacts::{ScopeKey, ScopeKind};
use vst_types::review::{
    AnchorReason, CommentSurface, DiffScope, DiffSide, PathKind, ReviewComment,
};
use vst_types::ServerEvent;

use crate::anchor::{anchor_comment, old_side_lines, Corpus, Outcome, MAX_ANCHOR_BYTES};
use crate::md_plain::md_plain_lines;
use crate::service::{lock, or_warn, ReviewHandle};

/// A scope is re-checked this long after its last watch event.
pub const REANCHOR_DEBOUNCE: Duration = Duration::from_millis(500);
/// ... but never later than this after its first.
pub const REANCHOR_MAX_WAIT: Duration = Duration::from_secs(5);
/// Scopes re-anchored at the same time.
const CONCURRENT_PASSES: usize = 2;
/// Renames followed in one chain (`a -> b -> c`).
const MAX_RENAME_HOPS: usize = 8;

/// What changed in a scope since its last pass.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Dirty {
    /// Re-check every comment (boot, resync after lost events).
    pub all: bool,
    /// HEAD / index changed: re-check diff-surface comments.
    pub git: bool,
    /// Re-check every artifact comment (an artifact row was removed, resync).
    pub artifacts: bool,
    /// Absolute paths whose content (or existence) changed.
    pub paths: HashSet<PathBuf>,
    /// Artifact moves `(from, to)` to follow.
    pub moves: Vec<(PathBuf, PathBuf)>,
}

struct DirtyEntry {
    dirty: Dirty,
    first: Instant,
    due: Instant,
}

/// The watcher side of a [`ReviewHandle`].
pub(crate) struct Watching {
    watcher: PathWatcher,
    resolver: Arc<dyn ScopeResolver>,
    dirty: Mutex<HashMap<ScopeKey, DirtyEntry>>,
    in_flight: Mutex<HashSet<ScopeKey>>,
    wake: Notify,
    passes: Semaphore,
}

impl Watching {
    pub(crate) fn new(watcher: PathWatcher, resolver: Arc<dyn ScopeResolver>) -> Self {
        Watching {
            watcher,
            resolver,
            dirty: Mutex::new(HashMap::new()),
            in_flight: Mutex::new(HashSet::new()),
            wake: Notify::new(),
            passes: Semaphore::new(CONCURRENT_PASSES),
        }
    }
}

/// The key under which a scope's git state is watched.
fn git_key(scope: &ScopeKey) -> String {
    match scope.scope_kind {
        ScopeKind::Worktree => scope.scope_id.clone(),
        ScopeKind::Project => format!("project:{}", scope.scope_id),
    }
}

fn scope_of_git_key(key: &str) -> ScopeKey {
    match key.strip_prefix("project:") {
        Some(id) => ScopeKey::project(id),
        None => ScopeKey::worktree(key),
    }
}

fn abs_path(root: &Path, c: &ReviewComment) -> PathBuf {
    match c.path_kind {
        PathKind::Repo => root.join(&c.path),
        PathKind::Artifact => PathBuf::from(&c.path),
    }
}

/// A file as the last read left it.
#[derive(Clone)]
enum FileState {
    Text(Arc<String>),
    TooLarge,
    Missing,
    Failed,
}

/// A parent directory swapped for a symlink after the canonical check would
/// make the opened fd point outside the checkout: ask the fd where it really is.
fn fd_inside_root(file: &std::fs::File, canon_root: &Path) -> bool {
    match vst_artifacts::reader::fd_real_path(file) {
        Some(real) => real.starts_with(canon_root),
        None => true,
    }
}

fn read_text_blocking(root: &Path, path: &Path) -> FileState {
    use std::io::Read;
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return FileState::Missing,
        Err(_) => return FileState::Failed,
    };
    if !meta.is_file() {
        return FileState::Missing;
    }
    // A symlink must not lead the read out of the checkout.
    let (canon_root, inside) = match (std::fs::canonicalize(root), std::fs::canonicalize(path)) {
        (Ok(r), Ok(p)) => {
            let inside = p.starts_with(&r);
            (r, inside)
        }
        _ => return FileState::Failed,
    };
    if !inside {
        return FileState::Failed;
    }
    if meta.len() > MAX_ANCHOR_BYTES {
        return FileState::TooLarge;
    }
    let Ok(file) = std::fs::File::open(path) else {
        return FileState::Failed;
    };
    if !fd_inside_root(&file, &canon_root) {
        return FileState::Failed;
    }
    let mut buf = Vec::new();
    if file
        .take(MAX_ANCHOR_BYTES + 1)
        .read_to_end(&mut buf)
        .is_err()
    {
        return FileState::Failed;
    }
    if buf.len() as u64 > MAX_ANCHOR_BYTES {
        return FileState::TooLarge;
    }
    FileState::Text(Arc::new(String::from_utf8_lossy(&buf).into_owned()))
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum CorpusKind {
    Plain,
    Markdown,
}

fn build_corpus(text: &str, kind: CorpusKind) -> Corpus {
    match kind {
        CorpusKind::Plain => Corpus::from_text(text),
        CorpusKind::Markdown => {
            let lines = md_plain_lines(text);
            Corpus::from_lines(lines.iter().map(|(n, t)| (*n, t.as_str())))
        }
    }
}

type Base = (DiffScope, Option<String>);

/// Per-pass caches: a file read once however many comments point at it.
struct PassCtx {
    root: PathBuf,
    scope: ScopeKey,
    files: HashMap<PathBuf, FileState>,
    corpora: HashMap<(PathBuf, CorpusKind), Arc<Corpus>>,
    renames: HashMap<Base, Option<HashMap<String, String>>>,
    diffs: HashMap<(String, Option<String>, Base), Option<Arc<Corpus>>>,
    worktree_base: Option<Option<String>>,
}

impl PassCtx {
    fn new(root: PathBuf, scope: ScopeKey) -> Self {
        PassCtx {
            root,
            scope,
            files: HashMap::new(),
            corpora: HashMap::new(),
            renames: HashMap::new(),
            diffs: HashMap::new(),
            worktree_base: None,
        }
    }

    async fn file(&mut self, path: &Path) -> FileState {
        if let Some(f) = self.files.get(path) {
            return f.clone();
        }
        let (root, p) = (self.root.clone(), path.to_path_buf());
        let state = tokio::task::spawn_blocking(move || read_text_blocking(&root, &p))
            .await
            .unwrap_or(FileState::Failed);
        self.files.insert(path.to_path_buf(), state.clone());
        state
    }

    fn corpus(&mut self, path: &Path, text: &Arc<String>, kind: CorpusKind) -> Arc<Corpus> {
        Arc::clone(
            self.corpora
                .entry((path.to_path_buf(), kind))
                .or_insert_with(|| Arc::new(build_corpus(text, kind))),
        )
    }

    /// The rename map of a diff base; `None` when git failed (keep last known).
    async fn renames(&mut self, base: &Base) -> Option<HashMap<String, String>> {
        if let Some(m) = self.renames.get(base) {
            return m.clone();
        }
        let map = vst_git::rename_map(&self.root, base.0, base.1.as_deref())
            .await
            .ok();
        self.renames.insert(base.clone(), map.clone());
        map
    }
}

/// Removes a scope from `in_flight` and wakes the loop when its pass ends,
/// normally or by panic.
struct FlightGuard<'a> {
    w: &'a Watching,
    scope: &'a ScopeKey,
}

impl Drop for FlightGuard<'_> {
    fn drop(&mut self) {
        lock(&self.w.in_flight).remove(self.scope);
        self.w.wake.notify_one();
    }
}

impl ReviewHandle {
    fn watching(&self) -> Option<&Watching> {
        self.0.watching.as_ref()
    }

    // ── Dirty bookkeeping ─────────────────────────────────────────────────────

    fn mark(&self, scope: &ScopeKey, f: impl FnOnce(&mut Dirty)) {
        let Some(w) = self.watching() else { return };
        let now = Instant::now();
        {
            let mut map = lock(&w.dirty);
            let e = map.entry(scope.clone()).or_insert_with(|| DirtyEntry {
                dirty: Dirty::default(),
                first: now,
                due: now,
            });
            f(&mut e.dirty);
            e.due = (now + REANCHOR_DEBOUNCE).min(e.first + REANCHOR_MAX_WAIT);
        }
        w.wake.notify_one();
    }

    /// Make `scope` due right now (boot, resync).
    fn mark_all_now(&self, scope: &ScopeKey) {
        self.mark(scope, |d| d.all = true);
        if let Some(w) = self.watching() {
            if let Some(e) = lock(&w.dirty).get_mut(scope) {
                e.due = Instant::now();
            }
        }
    }

    /// Scopes whose debounce elapsed and that have no pass in flight; they leave
    /// the dirty map and become in flight. `force` ignores the debounce.
    fn take_ready(&self, force: bool) -> Vec<(ScopeKey, Dirty)> {
        let Some(w) = self.watching() else {
            return Vec::new();
        };
        let now = Instant::now();
        let mut map = lock(&w.dirty);
        let mut flying = lock(&w.in_flight);
        let ready: Vec<ScopeKey> = map
            .iter()
            .filter(|(s, e)| (force || e.due <= now) && !flying.contains(*s))
            .map(|(s, _)| s.clone())
            .collect();
        ready
            .into_iter()
            .filter_map(|s| {
                let e = map.remove(&s)?;
                flying.insert(s.clone());
                Some((s, e.dirty))
            })
            .collect()
    }

    /// When the next not-in-flight scope is due.
    fn next_due(&self) -> Option<Instant> {
        let w = self.watching()?;
        let map = lock(&w.dirty);
        let flying = lock(&w.in_flight);
        map.iter()
            .filter(|(s, _)| !flying.contains(*s))
            .map(|(_, e)| e.due)
            .min()
    }

    async fn run_pass(&self, scope: ScopeKey, dirty: Dirty) -> usize {
        let Some(w) = self.watching() else { return 0 };
        // Clears the in-flight marker even if the pass panics, so the scope can
        // be re-anchored again.
        let _flight = FlightGuard { w, scope: &scope };
        let n = match w.passes.acquire().await {
            Ok(_permit) => self.reanchor_scope(&scope, &dirty).await,
            Err(_) => 0,
        };
        if w.watcher.has_failed() {
            w.watcher.retry_failed().await;
        }
        n
    }

    /// Re-check every dirty scope now, ignoring the debounce, and wait for the
    /// passes. Returns how many comments changed. (Tests, shutdown.)
    pub async fn flush_reanchor(&self) -> usize {
        let ready = self.take_ready(true);
        let mut total = 0;
        for (scope, dirty) in ready {
            total += self.run_pass(scope, dirty).await;
        }
        total
    }

    // ── Event intake ──────────────────────────────────────────────────────────

    /// Fold one watcher event into the dirty map.
    pub fn on_watch_event(&self, ev: WatchEvent) {
        match ev {
            WatchEvent::PathChanged { scope, path } => {
                self.mark(&scope, |d| {
                    d.paths.insert(path);
                });
            }
            WatchEvent::GitStateChanged { worktree_id } => {
                self.mark(&scope_of_git_key(&worktree_id), |d| d.git = true);
            }
            WatchEvent::Evicted { paths } | WatchEvent::Restored { paths } => {
                for (scope, path) in paths {
                    self.mark(&scope, |d| {
                        d.paths.insert(path);
                    });
                }
            }
        }
    }

    /// Fold one artifact change into the dirty map.
    pub fn on_artifact_change(&self, change: ArtifactChange) {
        match change {
            ArtifactChange::Written { scope, path, .. }
            | ArtifactChange::Missing { scope, path, .. } => {
                self.mark(&scope, |d| {
                    d.paths.insert(path);
                });
            }
            ArtifactChange::Moved {
                scope, from, to, ..
            } => self.mark(&scope, |d| d.moves.push((from, to))),
            ArtifactChange::Removed { scope, .. } => self.mark(&scope, |d| d.artifacts = true),
        }
    }

    /// The watcher lost events: re-check every scope that has comments.
    pub async fn on_watch_lagged(&self) {
        for scope in or_warn(
            self.0.store.list_comment_scopes().await,
            "list comment scopes",
        ) {
            self.mark_all_now(&scope);
        }
    }

    /// The artifact stream lost events: resync each scope that has artifact
    /// comments through `list(scope)` (which re-validates the rows), then
    /// re-check those comments.
    pub async fn on_artifact_lagged(&self) {
        for scope in or_warn(
            self.0.store.list_comment_scopes().await,
            "list comment scopes",
        ) {
            let has_artifact = self
                .0
                .store
                .list_comments(&scope, None, false)
                .await
                .is_ok_and(|cs| cs.iter().any(|c| c.path_kind == PathKind::Artifact));
            if has_artifact {
                let _ = self.0.artifacts.list(&scope).await;
                self.mark(&scope, |d| d.artifacts = true);
            }
        }
    }

    async fn on_bus_event(&self, ev: ServerEvent) {
        match ev {
            ServerEvent::WorktreeDeleted { worktree_id } => {
                self.purge_scope(&ScopeKey::worktree(worktree_id)).await;
            }
            ServerEvent::ProjectDeleted { project_id } => {
                self.purge_scope(&ScopeKey::project(project_id)).await;
                // Its worktrees went with it.
                self.purge_missing_scopes().await;
            }
            _ => {}
        }
    }

    // ── The loop ──────────────────────────────────────────────────────────────

    /// The watch-driven loop. Returns at once when no watcher is attached.
    pub(crate) async fn run_reanchor(&self) {
        let Some(w) = self.watching() else { return };
        let mut watch_rx = w.watcher.subscribe();
        let mut art_rx = self.0.artifacts.subscribe_changes();
        let mut bus_rx = self.0.broadcaster.subscribe();
        // Boot: one lazy pass over every scope that has comments.
        for scope in or_warn(
            self.0.store.list_comment_scopes().await,
            "list comment scopes",
        ) {
            self.sync_watches(&scope).await;
            self.mark_all_now(&scope);
        }
        loop {
            let due = self.next_due();
            tokio::select! {
                ev = watch_rx.recv() => match ev {
                    Ok(e) => self.on_watch_event(e),
                    Err(broadcast::error::RecvError::Lagged(_)) => self.on_watch_lagged().await,
                    Err(broadcast::error::RecvError::Closed) => return,
                },
                ch = art_rx.recv() => match ch {
                    Ok(c) => self.on_artifact_change(c),
                    Err(broadcast::error::RecvError::Lagged(_)) => self.on_artifact_lagged().await,
                    Err(broadcast::error::RecvError::Closed) => return,
                },
                ev = bus_rx.recv() => match ev {
                    Ok(e) => self.on_bus_event(e).await,
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        self.purge_missing_scopes().await;
                        self.on_watch_lagged().await;
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                },
                () = async {
                    match due {
                        Some(t) => tokio::time::sleep_until(t).await,
                        None => std::future::pending().await,
                    }
                } => {}
                () = w.wake.notified() => {}
            }
            for (scope, dirty) in self.take_ready(false) {
                let me = self.clone();
                tokio::spawn(async move {
                    me.run_pass(scope, dirty).await;
                });
            }
        }
    }

    // ── Watch registration ────────────────────────────────────────────────────

    /// Make the watcher's registrations for `scope` equal to its comments' files
    /// (and its git state, when it has diff comments). Newly watched paths are
    /// re-checked once, closing the gap before the watch existed.
    pub async fn sync_watches(&self, scope: &ScopeKey) {
        let Some(w) = self.watching() else { return };
        let root = w.resolver.scope_root(scope).await;
        let comments = match &root {
            Some(_) => match self.0.store.list_comments(scope, None, false).await {
                Ok(c) => c,
                Err(e) => {
                    // Keep the current registrations: an unreadable store is not
                    // "no comments".
                    tracing::warn!(scope_id = %scope.scope_id, "watch sync could not list comments: {e}");
                    return;
                }
            },
            None => Vec::new(),
        };
        let key = git_key(scope);
        let Some(root) = root.filter(|_| !comments.is_empty()) else {
            w.watcher.unwatch_scope(scope).await;
            w.watcher.unwatch_git_state(&key).await;
            return;
        };
        let mut desired: HashMap<PathBuf, String> = HashMap::new();
        for c in &comments {
            let stamp = desired.entry(abs_path(&root, c)).or_default();
            if c.created_at > *stamp {
                stamp.clone_from(&c.created_at);
            }
        }
        let registered = w.watcher.registered(scope);
        let mut fresh = Vec::new();
        for (path, stamp) in &desired {
            if registered.get(path) != Some(stamp) {
                w.watcher.watch(scope, path, stamp).await;
                if !registered.contains_key(path) {
                    fresh.push(path.clone());
                }
            }
        }
        for path in registered.keys().filter(|p| !desired.contains_key(*p)) {
            w.watcher.unwatch(scope, path).await;
        }
        if !fresh.is_empty() {
            self.mark(scope, |d| d.paths.extend(fresh));
        }
        let has_diff = comments.iter().any(|c| c.surface == CommentSurface::Diff);
        if !has_diff {
            w.watcher.unwatch_git_state(&key).await;
        } else if !w.watcher.watches_git_state(&key) {
            match vst_git::git_dir(&root).await {
                Ok(dir) => {
                    w.watcher.watch_git_state(&key, &dir).await;
                    // HEAD may have moved before the watch existed.
                    self.mark(scope, |d| d.git = true);
                }
                Err(e) => {
                    tracing::debug!(scope = %scope.scope_id, "[vst] no git dir to watch: {e}");
                }
            }
        }
    }

    /// How many paths of `scope` the watcher currently has registered.
    pub fn watch_registered(&self, scope: &ScopeKey) -> usize {
        self.watching()
            .map_or(0, |w| w.watcher.registered(scope).len())
    }

    // ── Purge ─────────────────────────────────────────────────────────────────

    /// Drop a deleted scope's comments (held ones included) and its watches.
    pub async fn purge_scope(&self, scope: &ScopeKey) {
        match self.0.store.purge_scope_comments(scope).await {
            Ok(n) if n > 0 => {
                tracing::info!(scope = %scope.scope_id, "[vst] purged {n} comment(s) of a deleted scope");
            }
            Ok(_) => {}
            Err(e) => tracing::warn!("[vst] comment purge failed: {e}"),
        }
        if let Some(w) = self.watching() {
            w.watcher.unwatch_scope(scope).await;
            w.watcher.unwatch_git_state(&git_key(scope)).await;
            lock(&w.dirty).remove(scope);
        }
    }

    /// Purge every comment scope whose worktree / project no longer exists.
    /// For live events only: boot uses the store's guarded orphan purge.
    pub async fn purge_missing_scopes(&self) -> usize {
        let Some(w) = self.watching() else { return 0 };
        let mut purged = 0;
        for scope in or_warn(
            self.0.store.list_comment_scopes().await,
            "list comment scopes",
        ) {
            if !w.resolver.scope_exists(&scope).await {
                self.purge_scope(&scope).await;
                purged += 1;
            }
        }
        purged
    }

    // ── One pass ──────────────────────────────────────────────────────────────

    /// Re-anchor the comments of `scope` that `dirty` touches. Returns how many
    /// comments changed (and were queued for `comments:changed`).
    pub async fn reanchor_scope(&self, scope: &ScopeKey, dirty: &Dirty) -> usize {
        let Some(w) = self.watching() else { return 0 };
        let Some(root) = w.resolver.scope_root(scope).await else {
            return 0;
        };
        let Ok(comments) = self.0.store.list_comments(scope, None, false).await else {
            return 0;
        };
        let mut ctx = PassCtx::new(root, scope.clone());
        let mut updates = Vec::new();
        for mut c in comments {
            let mut moved = false;
            if c.path_kind == PathKind::Artifact {
                for _ in 0..MAX_RENAME_HOPS {
                    let Some((_, to)) = dirty.moves.iter().find(|(f, _)| f == Path::new(&c.path))
                    else {
                        break;
                    };
                    c.moved_from = Some(std::mem::replace(
                        &mut c.path,
                        to.to_string_lossy().into_owned(),
                    ));
                    moved = true;
                }
            }
            let abs = abs_path(&ctx.root, &c);
            let hit = dirty.all
                || moved
                || dirty.paths.contains(&abs)
                || (dirty.git && c.surface == CommentSurface::Diff)
                || (dirty.artifacts && c.path_kind == PathKind::Artifact);
            if !hit {
                continue;
            }
            if let Some(u) = self.anchor_one(w, &mut ctx, c).await {
                updates.push(u);
            }
        }
        match self.0.store.apply_anchor_updates(updates).await {
            Ok(changed) => {
                let n = changed.len();
                if n > 0 {
                    tracing::debug!(scope = %scope.scope_id, "[vst] re-anchored {n} comment(s)");
                    self.push_upserts(changed);
                }
                n
            }
            Err(e) => {
                tracing::warn!("[vst] anchor write failed: {e}");
                0
            }
        }
    }

    async fn anchor_one(
        &self,
        w: &Watching,
        ctx: &mut PassCtx,
        mut c: ReviewComment,
    ) -> Option<AnchorUpdate> {
        let abs = abs_path(&ctx.root, &c);
        let outcome = if w.watcher.is_evicted(&ctx.scope, &abs) {
            Outcome::cant_check(AnchorReason::WatchLimit)
        } else if c.path_kind == PathKind::Artifact {
            self.anchor_artifact(ctx, &c).await?
        } else {
            self.anchor_repo(ctx, &mut c).await?
        };
        Some(AnchorUpdate {
            id: c.id,
            path: c.path,
            moved_from: c.moved_from,
            anchor: outcome.anchor,
            reason: outcome.reason,
            current: outcome.current,
        })
    }

    async fn anchor_repo(&self, ctx: &mut PassCtx, c: &mut ReviewComment) -> Option<Outcome> {
        let mut abs = ctx.root.join(&c.path);
        let mut state = ctx.file(&abs).await;
        if matches!(state, FileState::Missing) {
            match self.find_move(ctx, c).await {
                Some(new_rel) => {
                    c.moved_from = Some(std::mem::replace(&mut c.path, new_rel));
                    abs = ctx.root.join(&c.path);
                    state = ctx.file(&abs).await;
                }
                None => return Some(Outcome::file_missing()),
            }
        }
        let text = match state {
            FileState::Text(t) => t,
            FileState::TooLarge => return Some(Outcome::cant_check(AnchorReason::FileTooLarge)),
            FileState::Missing => return Some(Outcome::file_missing()),
            FileState::Failed => return None,
        };
        let corpus = match (c.surface, c.side) {
            (CommentSurface::Markdown, _) => ctx.corpus(&abs, &text, CorpusKind::Markdown),
            (CommentSurface::Diff, Some(DiffSide::Old)) => self.old_side_corpus(ctx, c).await?,
            _ => ctx.corpus(&abs, &text, CorpusKind::Plain),
        };
        Some(anchor_comment(c, &corpus))
    }

    /// The old side of the comment's diff as a corpus; `None` keeps the last
    /// known anchor (git failed).
    async fn old_side_corpus(&self, ctx: &mut PassCtx, c: &ReviewComment) -> Option<Arc<Corpus>> {
        let scope = c.diff_scope.unwrap_or(DiffScope::Local);
        let base: Base = (
            scope,
            c.base_sha.clone().filter(|_| scope == DiffScope::Branch),
        );
        let old_path = ctx
            .renames(&base)
            .await?
            .into_iter()
            .find(|(_, new)| *new == c.path)
            .map(|(old, _)| old);
        let key = (c.path.clone(), old_path.clone(), base.clone());
        if let Some(cached) = ctx.diffs.get(&key) {
            return cached.clone();
        }
        let corpus = vst_git::file_diff(
            &ctx.root,
            base.0,
            base.1.as_deref(),
            &c.path,
            old_path.as_deref(),
        )
        .await
        .ok()
        .map(|diff| {
            let rows = old_side_lines(&diff);
            Arc::new(Corpus::from_lines(
                rows.iter().map(|(n, t)| (*n, t.as_str())),
            ))
        });
        ctx.diffs.insert(key, corpus.clone());
        corpus
    }

    /// Where a vanished repo file went (a path relative to the root), if a
    /// rename is found. A git failure counts as "no rename": the file IS gone,
    /// and the next change re-checks it.
    async fn find_move(&self, ctx: &mut PassCtx, c: &ReviewComment) -> Option<String> {
        // A file moved back to where the comment came from has no rename
        // against any base any more; follow it home directly.
        if let Some(prev) = c.moved_from.as_ref().filter(|p| **p != c.path) {
            if ctx.root.join(prev).is_file() {
                return Some(prev.clone());
            }
        }
        let mut bases: Vec<Base> = vec![(DiffScope::Local, None)];
        if let Some(sha) = c.base_sha.clone().filter(|s| !s.is_empty()) {
            bases.push((DiffScope::Branch, Some(sha)));
        }
        if ctx.worktree_base.is_none() {
            let sha = match ctx.scope.scope_kind {
                ScopeKind::Worktree => self
                    .0
                    .store
                    .get_all_projects()
                    .await
                    .into_iter()
                    .flat_map(|p| p.worktrees)
                    .find(|wt| wt.id == ctx.scope.scope_id)
                    .map(|wt| wt.base_sha)
                    .filter(|s| !s.is_empty()),
                ScopeKind::Project => None,
            };
            ctx.worktree_base = Some(sha);
        }
        if let Some(Some(sha)) = &ctx.worktree_base {
            let b = (DiffScope::Branch, Some(sha.clone()));
            if !bases.contains(&b) {
                bases.push(b);
            }
        }
        for base in &bases {
            let Some(map) = ctx.renames(base).await else {
                continue;
            };
            let mut cur = c.path.clone();
            for _ in 0..MAX_RENAME_HOPS {
                match map.get(&cur) {
                    Some(next) => cur.clone_from(next),
                    None => break,
                }
            }
            if cur != c.path && ctx.root.join(&cur).is_file() {
                return Some(cur);
            }
        }
        None
    }

    async fn anchor_artifact(&self, ctx: &mut PassCtx, c: &ReviewComment) -> Option<Outcome> {
        let scope = &ctx.scope;
        let path = PathBuf::from(&c.path);
        let gone = tokio::fs::symlink_metadata(&path)
            .await
            .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound);
        if gone {
            // R114: the Artifacts list must agree before the comment says so.
            self.0
                .artifacts
                .revalidate_paths(scope, std::slice::from_ref(&path))
                .await;
            return Some(Outcome::file_missing());
        }
        let Some(id) = self.0.artifacts.authorize_read(scope, &path).await else {
            return Some(Outcome::file_missing());
        };
        match self.0.artifacts.read_content(&id).await {
            ReadOutcome::Text {
                bytes,
                total,
                truncated,
                ..
            } => {
                if truncated || total > MAX_ANCHOR_BYTES {
                    return Some(Outcome::cant_check(AnchorReason::FileTooLarge));
                }
                let text = String::from_utf8_lossy(&bytes);
                let kind = if c.surface == CommentSurface::Markdown {
                    CorpusKind::Markdown
                } else {
                    CorpusKind::Plain
                };
                Some(anchor_comment(c, &build_corpus(&text, kind)))
            }
            ReadOutcome::TooLarge { .. } => Some(Outcome::cant_check(AnchorReason::FileTooLarge)),
            ReadOutcome::Missing => {
                self.0
                    .artifacts
                    .revalidate_paths(scope, std::slice::from_ref(&path))
                    .await;
                Some(Outcome::file_missing())
            }
            ReadOutcome::NotFound => Some(Outcome::file_missing()),
            ReadOutcome::Binary { .. } | ReadOutcome::Image { .. } => Some(Outcome::outdated()),
            _ => None,
        }
    }
}

#[cfg(test)]
mod fd_root_tests {
    use super::*;

    #[test]
    fn an_fd_opened_through_a_swapped_parent_is_outside_the_root() {
        let d = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(d.path()).unwrap();
        std::fs::create_dir_all(base.join("root")).unwrap();
        std::fs::create_dir_all(base.join("elsewhere")).unwrap();
        std::fs::write(base.join("root/a.txt"), "in").unwrap();
        std::fs::write(base.join("elsewhere/a.txt"), "out").unwrap();
        let root = base.join("root");
        let inside = std::fs::File::open(root.join("a.txt")).unwrap();
        assert!(fd_inside_root(&inside, &root));
        // The check path says `root/sub/a.txt`; `sub` is swapped for a symlink out.
        std::os::unix::fs::symlink(base.join("elsewhere"), root.join("sub")).unwrap();
        let swapped = std::fs::File::open(root.join("sub/a.txt")).unwrap();
        assert!(!fd_inside_root(&swapped, &root));
    }
}
