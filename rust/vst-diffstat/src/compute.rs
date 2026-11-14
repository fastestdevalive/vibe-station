//! Diffstat compute for one worktree (plan Decisions 4–5).
//!
//! Steady state is ONE git exec: `git diff-index --shortstat --merge-base
//! <ref>`. The `origin/<base>` vs `<base>` ref choice is cached per worktree,
//! keyed on the two ref SHAs (plus `HEAD`'s SHA only when the refs diverge), so
//! a cache hit never re-runs `rev-parse`/`merge-base`/`is-ancestor`.
//!
//! `diff-index` never rewrites the index (`git diff`/`git status` can), so a
//! compute cannot race an agent's own `git add` (index.lock). Git older than
//! 2.30 has no `diff-index --merge-base`; that path falls back to `merge-base`
//! + `git diff --shortstat` and may touch the index (documented, tested for its
//! parse only).
//!
//! A worktree whose `.git` file points at a missing gitdir is `broken` — no
//! git exec at all, and the poller never retries it on a timer (only when the
//! `.git` file's length/mtime changes).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use vst_git::git::{
    diff_index_shortstat, diff_shortstat, git_version, is_ancestor, object_exists, rev_parse,
    run_git_env, GitError, GitVersion,
};
use vst_git::parse_shortstat;
use vst_types::rest::worktrees::DiffStatState;

/// Tooltip shown for a `broken` worktree.
pub const BROKEN_HINT: &str = "git worktree repair";
/// Tooltip shown when the worktree directory itself is missing.
pub const MISSING_DIR_HINT: &str = "worktree directory is missing";

/// Standard git environment passed to every git invocation in compute.
pub const GIT_ENV: [(&str, &str); 3] = [
    ("GIT_OPTIONAL_LOCKS", "0"),
    ("LC_ALL", "C"),
    ("LANGUAGE", "C"),
];

/// `<worktree>/.git` `(len, mtime in nanoseconds)` — the stat-only stamp the
/// poller compares to decide whether a `broken` worktree is worth re-checking.
pub type GitFileStamp = (u64, u64);

/// Read the `.git` stamp (no git exec). `None` when `.git` does not exist.
#[must_use]
pub fn git_file_stamp(worktree: &Path) -> Option<GitFileStamp> {
    let meta = std::fs::metadata(worktree.join(".git")).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_nanos() as u64;
    Some((meta.len(), mtime))
}

/// Everything one compute needs about its worktree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComputeInput {
    pub worktree_id: String,
    pub path: PathBuf,
    /// The worktree's recorded base branch (`origin/<base>` / `<base>`).
    pub base_branch: String,
    /// The worktree's recorded `base_sha` — the last-resort diff base.
    pub base_sha: String,
}

/// One compute's result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComputeOutcome {
    pub insertions: u64,
    pub deletions: u64,
    pub state: DiffStatState,
    pub hint: Option<String>,
    /// The `.git` stamp observed when `state == Broken` (the poller stores it
    /// and re-checks only when the file changes).
    pub stamp: Option<GitFileStamp>,
}

impl ComputeOutcome {
    #[must_use]
    pub fn ok(insertions: u64, deletions: u64) -> Self {
        Self {
            insertions,
            deletions,
            state: DiffStatState::Ok,
            hint: None,
            stamp: None,
        }
    }

    /// Transient failure (git timeout / exec error). The poller keeps the last
    /// value and broadcasts nothing when one exists.
    #[must_use]
    pub fn unknown() -> Self {
        Self {
            insertions: 0,
            deletions: 0,
            state: DiffStatState::Unknown,
            hint: None,
            stamp: None,
        }
    }

    /// No usable base at all.
    #[must_use]
    pub fn unavailable() -> Self {
        Self {
            insertions: 0,
            deletions: 0,
            state: DiffStatState::Unavailable,
            hint: None,
            stamp: None,
        }
    }

    #[must_use]
    pub fn broken_with_hint(hint: &str, stamp: Option<GitFileStamp>) -> Self {
        Self {
            insertions: 0,
            deletions: 0,
            state: DiffStatState::Broken,
            hint: Some(hint.to_string()),
            stamp,
        }
    }

    #[must_use]
    pub fn broken(stamp: Option<GitFileStamp>) -> Self {
        Self::broken_with_hint(BROKEN_HINT, stamp)
    }
}

/// The ref a worktree's diff is computed against.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChosenRef {
    /// `origin/<base>` (its merge base with HEAD).
    Origin,
    /// `<base>` (its merge base with HEAD).
    Local,
    /// The worktree's recorded `base_sha` (verified present in the odb).
    BaseSha,
    /// Nothing resolves.
    Unavailable,
}

/// Cached ref choice. Revalidated only when the refs it depended on change.
#[derive(Clone, Debug)]
struct ChoiceCache {
    origin_sha: Option<String>,
    local_sha: Option<String>,
    /// `HEAD`'s SHA — only recorded when the two refs diverge (the old
    /// merge-base rule depends on it).
    head_sha: Option<String>,
    /// The `base_sha` this choice was verified against (BaseSha / Unavailable).
    base_sha: Option<String>,
    chosen: ChosenRef,
    /// A criss-cross history needs `merge-base` + a direct `diff-index`.
    criss_cross: bool,
}

/// Why one exec attempt failed.
enum Fail {
    Broken,
    Transient,
    NoMergeBase,
    CrissCross,
    Unavailable,
}

/// One candidate diff base for a worktree.
enum Candidate {
    Ref(String),
    BaseSha,
}

/// The resolved git directories of a worktree.
pub(crate) struct GitDirs {
    /// The worktree's private gitdir (`<common>/worktrees/<id>`), whose `HEAD`
    /// points at the worktree's own branch.
    pub(crate) gitdir: PathBuf,
    /// The repository's shared gitdir (`<repo>/.git`) — holds `refs/`.
    pub(crate) common_dir: PathBuf,
}

/// Per-worktree ref-choice cache + compute.
pub struct DiffStatComputer {
    choices: Mutex<HashMap<String, ChoiceCache>>,
    execs: AtomicU64,
    version_override: Option<GitVersion>,
}

impl std::fmt::Debug for DiffStatComputer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DiffStatComputer").finish_non_exhaustive()
    }
}

impl DiffStatComputer {
    #[must_use]
    pub fn new() -> Self {
        Self {
            choices: Mutex::new(HashMap::new()),
            execs: AtomicU64::new(0),
            version_override: None,
        }
    }

    /// Force the pre-2.30 fallback path (tests). Production always probes the
    /// real `git --version` once.
    #[doc(hidden)]
    #[must_use]
    pub fn with_version_override(mut self, version: GitVersion) -> Self {
        self.version_override = Some(version);
        self
    }

    /// Number of git execs this computer attempted (test/diagnostic seam).
    #[doc(hidden)]
    #[must_use]
    pub fn execs(&self) -> u64 {
        self.execs.load(Ordering::Relaxed)
    }

    /// Forget one worktree's cached ref choice (eviction).
    pub fn forget(&self, worktree_id: &str) {
        if let Ok(mut choices) = self.choices.lock() {
            choices.remove(worktree_id);
        }
    }

    /// Drop every cached ref choice whose worktree is not in `keep`.
    pub fn retain(&self, keep: &HashSet<String>) {
        if let Ok(mut choices) = self.choices.lock() {
            choices.retain(|id, _| keep.contains(id));
        }
    }

    /// Number of cached ref choices (test/diagnostic seam).
    #[doc(hidden)]
    #[must_use]
    pub fn cached_choices(&self) -> usize {
        self.choices.lock().map_or(0, |choices| choices.len())
    }

    /// Forget every cached ref choice.
    pub fn clear(&self) {
        if let Ok(mut choices) = self.choices.lock() {
            choices.clear();
        }
    }

    /// Compute one worktree's diffstat.
    pub async fn compute(&self, input: &ComputeInput) -> ComputeOutcome {
        let worktree = input.path.as_path();
        let Some(dirs) = git_dirs(worktree) else {
            let hint = if !worktree.is_dir() {
                MISSING_DIR_HINT
            } else {
                BROKEN_HINT
            };
            let outcome = ComputeOutcome::broken_with_hint(hint, git_file_stamp(worktree));
            tracing::debug!(
                worktree_id = %input.worktree_id,
                hint = ?outcome.hint,
                "diffstat outcome: broken"
            );
            return outcome;
        };
        let version = match self.version_override {
            Some(version) => Some(version),
            None => git_version().await,
        };
        // `diff-index --merge-base` landed in git 2.30.
        let legacy = version.is_some_and(|v| (v.major, v.minor) < (2, 30));

        let mut cache = match self.resolve_choice(input, &dirs).await {
            Ok(cache) => cache,
            Err(()) => {
                tracing::debug!(
                    worktree_id = %input.worktree_id,
                    "diffstat outcome: transient (resolve_choice)"
                );
                return ComputeOutcome::unknown();
            }
        };
        let outcome = self.run_choice(input, &dirs, &mut cache, legacy).await;
        match outcome.state {
            DiffStatState::Broken => {
                tracing::debug!(
                    worktree_id = %input.worktree_id,
                    hint = ?outcome.hint,
                    "diffstat outcome: broken"
                );
            }
            DiffStatState::Unavailable => {
                tracing::debug!(
                    worktree_id = %input.worktree_id,
                    hint = ?outcome.hint,
                    "diffstat outcome: unavailable"
                );
            }
            DiffStatState::Unknown => {
                tracing::debug!(
                    worktree_id = %input.worktree_id,
                    "diffstat outcome: transient"
                );
            }
            DiffStatState::Ok => {}
        }
        if outcome.state == DiffStatState::Broken {
            self.forget(&input.worktree_id);
        } else if let Ok(mut choices) = self.choices.lock() {
            choices.insert(input.worktree_id.clone(), cache);
        }
        outcome
    }

    fn count(&self) {
        self.execs.fetch_add(1, Ordering::Relaxed);
    }

    /// Resolve (or reuse) the ref choice for this worktree.
    async fn resolve_choice(
        &self,
        input: &ComputeInput,
        dirs: &GitDirs,
    ) -> Result<ChoiceCache, ()> {
        let worktree = input.path.as_path();
        let base = input.base_branch.as_str();
        let origin_name = format!("refs/remotes/origin/{base}");
        let origin_sha = self
            .read_ref(&dirs.common_dir, &origin_name, worktree)
            .await?;
        let local_sha = self.read_base_ref(&dirs.common_dir, base, worktree).await?;

        if let Some(cached) = self.cached_choice(&input.worktree_id) {
            let key_matches = cached.origin_sha == origin_sha
                && cached.local_sha == local_sha
                && cached
                    .base_sha
                    .as_deref()
                    .map_or(true, |sha| sha == input.base_sha);
            if key_matches {
                let head_matches = match cached.head_sha.as_deref() {
                    None => true,
                    Some(head) => self.read_head(dirs, worktree).await.as_deref() == Some(head),
                };
                if head_matches {
                    return Ok(cached);
                }
            }
        }

        let (chosen, head_sha, base_sha) = match (&origin_sha, &local_sha) {
            (None, None) => {
                // Always record the base_sha this answer was verified against
                // (even when empty) so a later change to it re-resolves.
                if input.base_sha.is_empty() {
                    (ChosenRef::Unavailable, None, Some(String::new()))
                } else {
                    self.count();
                    // A timeout is not "absent": propagate as unknown.
                    let exists = object_exists(&worktree.to_string_lossy(), &input.base_sha)
                        .await
                        .map_err(|_| ())?;
                    let chosen = if exists {
                        ChosenRef::BaseSha
                    } else {
                        ChosenRef::Unavailable
                    };
                    (chosen, None, Some(input.base_sha.clone()))
                }
            }
            (Some(_), None) => (ChosenRef::Origin, None, None),
            (None, Some(_)) => (ChosenRef::Local, None, None),
            (Some(origin), Some(local)) if origin == local => (ChosenRef::Origin, None, None),
            (Some(origin), Some(local)) => {
                // Descendant wins: the more advanced ref is the fork point.
                self.count();
                if is_ancestor(&worktree.to_string_lossy(), origin, local)
                    .await
                    .map_err(|_| ())?
                {
                    (ChosenRef::Local, None, None)
                } else {
                    self.count();
                    if is_ancestor(&worktree.to_string_lossy(), local, origin)
                        .await
                        .map_err(|_| ())?
                    {
                        (ChosenRef::Origin, None, None)
                    } else {
                        // Diverged: the pre-existing rule, which needs HEAD.
                        let head_sha = self.read_head(dirs, worktree).await;
                        let chosen = self.diverged_choice(worktree, base).await?;
                        (chosen, head_sha, None)
                    }
                }
            }
        };

        Ok(ChoiceCache {
            origin_sha,
            local_sha,
            head_sha,
            base_sha,
            chosen,
            criss_cross: false,
        })
    }

    fn cached_choice(&self, worktree_id: &str) -> Option<ChoiceCache> {
        self.choices
            .lock()
            .ok()
            .and_then(|choices| choices.get(worktree_id).cloned())
    }

    /// The old `resolve_base_sha` rule for genuinely divergent refs:
    /// `o = merge-base HEAD origin/<b>`, `l = merge-base HEAD <b>`; `l` an
    /// ancestor of `o` ⇒ origin, `o` an ancestor of `l` ⇒ local, otherwise
    /// origin.
    async fn diverged_choice(&self, worktree: &Path, base: &str) -> Result<ChosenRef, ()> {
        let wt = worktree.to_string_lossy();
        self.count();
        let origin_mb = merge_base(&wt, "HEAD", &format!("origin/{base}")).await?;
        self.count();
        let local_mb = merge_base(&wt, "HEAD", base).await?;
        match (origin_mb, local_mb) {
            (Some(origin), Some(local)) if origin == local => Ok(ChosenRef::Origin),
            (Some(origin), Some(local)) => {
                self.count();
                if is_ancestor(&wt, &local, &origin).await.map_err(|_| ())? {
                    Ok(ChosenRef::Origin)
                } else {
                    self.count();
                    if is_ancestor(&wt, &origin, &local).await.map_err(|_| ())? {
                        Ok(ChosenRef::Local)
                    } else {
                        Ok(ChosenRef::Origin)
                    }
                }
            }
            (Some(_), None) => Ok(ChosenRef::Origin),
            (None, Some(_)) => Ok(ChosenRef::Local),
            // Neither has a merge base with HEAD (unrelated/shallow): the exec
            // path turns this into `no merge base` and walks the fallbacks.
            (None, None) => Ok(ChosenRef::Origin),
        }
    }

    /// Try the chosen candidate, then the documented fallbacks (`no merge
    /// base` ⇒ the other ref ⇒ `base_sha` ⇒ `unavailable`).
    async fn run_choice(
        &self,
        input: &ComputeInput,
        dirs: &GitDirs,
        cache: &mut ChoiceCache,
        legacy: bool,
    ) -> ComputeOutcome {
        let worktree = input.path.as_path();
        let base = input.base_branch.as_str();
        let origin_ref = format!("origin/{base}");
        let local_ref = base.to_string();

        let mut candidates: Vec<Candidate> = Vec::new();
        match cache.chosen {
            ChosenRef::Unavailable => return ComputeOutcome::unavailable(),
            ChosenRef::Origin => candidates.push(Candidate::Ref(origin_ref.clone())),
            ChosenRef::Local => candidates.push(Candidate::Ref(local_ref.clone())),
            ChosenRef::BaseSha => candidates.push(Candidate::BaseSha),
        }
        match cache.chosen {
            ChosenRef::Origin if cache.local_sha.is_some() => {
                candidates.push(Candidate::Ref(local_ref.clone()));
            }
            ChosenRef::Local if cache.origin_sha.is_some() => {
                candidates.push(Candidate::Ref(origin_ref.clone()));
            }
            _ => {}
        }
        if cache.chosen != ChosenRef::BaseSha {
            candidates.push(Candidate::BaseSha);
        }

        for (index, candidate) in candidates.into_iter().enumerate() {
            let mut result = self.run_candidate(input, cache, &candidate, legacy).await;
            if matches!(result, Err(Fail::CrissCross)) {
                // Criss-cross history: `git merge-base <ref> HEAD` (git picks
                // one) + a direct `diff-index --shortstat <sha>`, cached on the
                // same key so the retry happens once per key change.
                cache.criss_cross = true;
                result = self.run_candidate(input, cache, &candidate, legacy).await;
            }
            match result {
                Ok((insertions, deletions)) => {
                    match &candidate {
                        Candidate::Ref(r) if r == &origin_ref => cache.chosen = ChosenRef::Origin,
                        Candidate::Ref(_) => cache.chosen = ChosenRef::Local,
                        Candidate::BaseSha => {
                            cache.chosen = ChosenRef::BaseSha;
                            cache.base_sha = Some(input.base_sha.clone());
                        }
                    }
                    if index > 0 {
                        // A fallback choice depends on HEAD (the merge base
                        // that failed may start existing): re-resolve when it
                        // moves.
                        cache.head_sha = self.read_head(dirs, worktree).await;
                    }
                    return ComputeOutcome::ok(insertions, deletions);
                }
                Err(Fail::Broken) => return ComputeOutcome::broken(git_file_stamp(worktree)),
                Err(Fail::Transient) => return ComputeOutcome::unknown(),
                // Try the next documented fallback.
                Err(Fail::NoMergeBase | Fail::Unavailable | Fail::CrissCross) => continue,
            }
        }

        // Every candidate exhausted: cache `Unavailable` on the same key. It is
        // only re-evaluated when a ref, the base_sha or HEAD changes (never on
        // a timer).
        cache.chosen = ChosenRef::Unavailable;
        cache.base_sha = Some(input.base_sha.clone());
        cache.head_sha = self.read_head(dirs, worktree).await;
        ComputeOutcome::unavailable()
    }

    async fn run_candidate(
        &self,
        input: &ComputeInput,
        cache: &ChoiceCache,
        candidate: &Candidate,
        legacy: bool,
    ) -> Result<(u64, u64), Fail> {
        let wt = input.path.to_string_lossy();
        match candidate {
            Candidate::Ref(r) => {
                if legacy {
                    self.legacy_diff(&wt, r).await
                } else if cache.criss_cross {
                    self.criss_cross_diff(&wt, r).await
                } else {
                    self.diff_index(&wt, r).await
                }
            }
            Candidate::BaseSha => self.base_sha_diff(input, cache, &wt, legacy).await,
        }
    }

    /// The steady-state one exec.
    async fn diff_index(&self, wt: &str, r#ref: &str) -> Result<(u64, u64), Fail> {
        self.count();
        diff_index_shortstat(wt, r#ref)
            .await
            .map(|stat| (stat.insertions, stat.deletions))
            .map_err(classify)
    }

    /// `diff-index --shortstat <rev>` without `--merge-base` (criss-cross /
    /// verified `base_sha`).
    async fn diff_index_against(&self, wt: &str, rev: &str) -> Result<(u64, u64), Fail> {
        self.count();
        let stdout = run_git_env(
            &["-C", wt, "diff-index", "--shortstat", rev],
            &GIT_ENV,
            Some(Path::new(wt)),
        )
        .await
        .map_err(classify)?;
        let stat = parse_shortstat(&stdout);
        Ok((stat.insertions, stat.deletions))
    }

    /// Pre-2.30 fallback: `merge-base HEAD <ref>` + `git diff --shortstat`.
    async fn legacy_diff(&self, wt: &str, r#ref: &str) -> Result<(u64, u64), Fail> {
        self.count();
        let sha = match run_git_env(
            &["-C", wt, "merge-base", "HEAD", r#ref],
            &GIT_ENV,
            Some(Path::new(wt)),
        )
        .await
        {
            Ok(sha) if !sha.is_empty() => sha,
            Ok(_) => return Err(Fail::Unavailable),
            Err(e) => return Err(classify(e)),
        };
        self.count();
        diff_shortstat(wt, &sha)
            .await
            .map(|stat| (stat.insertions, stat.deletions))
            .map_err(classify)
    }

    /// Criss-cross fallback: `merge-base <ref> HEAD` + a direct diff against
    /// that SHA.
    async fn criss_cross_diff(&self, wt: &str, r#ref: &str) -> Result<(u64, u64), Fail> {
        self.count();
        let sha = match run_git_env(
            &["-C", wt, "merge-base", r#ref, "HEAD"],
            &GIT_ENV,
            Some(Path::new(wt)),
        )
        .await
        {
            Ok(sha) if !sha.is_empty() => sha,
            Ok(_) => return Err(Fail::Unavailable),
            Err(e) => return Err(classify(e)),
        };
        self.diff_index_against(wt, &sha).await
    }

    async fn base_sha_diff(
        &self,
        input: &ComputeInput,
        cache: &ChoiceCache,
        wt: &str,
        legacy: bool,
    ) -> Result<(u64, u64), Fail> {
        if input.base_sha.is_empty() {
            return Err(Fail::Unavailable);
        }
        // `cat-file -e` is only needed when this exact base_sha has not already
        // been verified (Decision 4).
        let verified = cache.chosen == ChosenRef::BaseSha
            && cache.base_sha.as_deref() == Some(input.base_sha.as_str());
        if !verified {
            self.count();
            match object_exists(wt, &input.base_sha).await {
                Ok(true) => {}
                Ok(false) => return Err(Fail::Unavailable),
                Err(_) => return Err(Fail::Transient),
            }
        }
        if legacy {
            self.count();
            diff_shortstat(wt, &input.base_sha)
                .await
                .map(|stat| (stat.insertions, stat.deletions))
                .map_err(classify)
        } else {
            self.diff_index_against(wt, &input.base_sha).await
        }
    }

    /// `<base>` as git would resolve it: a local branch, else a remote-tracking
    /// ref (`origin/main`) or a tag, which `create_worktree` also accepts.
    async fn read_base_ref(
        &self,
        common_dir: &Path,
        base: &str,
        worktree: &Path,
    ) -> Result<Option<String>, ()> {
        for prefix in ["refs/heads", "refs/remotes", "refs/tags"] {
            if let Some(sha) = self
                .read_ref(common_dir, &format!("{prefix}/{base}"), worktree)
                .await?
            {
                return Ok(Some(sha));
            }
        }
        Ok(None)
    }

    /// `Ok(Some)` found, `Ok(None)` definitely absent, `Err` transient.
    async fn read_ref(
        &self,
        common_dir: &Path,
        name: &str,
        worktree: &Path,
    ) -> Result<Option<String>, ()> {
        match read_ref_file(common_dir, name) {
            RefLookup::Found(sha) => Ok(Some(sha)),
            // An absent ref is a definite answer: no exec.
            RefLookup::Absent => Ok(None),
            RefLookup::Unreadable => {
                self.count();
                match rev_parse(&worktree.to_string_lossy(), name).await {
                    Ok(sha) => Ok(Some(sha).filter(|sha| is_sha(sha))),
                    Err(e) if is_transient(&e) => Err(()),
                    Err(_) => Ok(None),
                }
            }
        }
    }

    async fn read_head(&self, dirs: &GitDirs, worktree: &Path) -> Option<String> {
        if let Some(sha) = read_head_file(&dirs.gitdir, &dirs.common_dir) {
            return Some(sha);
        }
        self.count();
        rev_parse(&worktree.to_string_lossy(), "HEAD")
            .await
            .ok()
            .filter(|sha| is_sha(sha))
    }
}

impl Default for DiffStatComputer {
    fn default() -> Self {
        Self::new()
    }
}

fn classify(error: GitError) -> Fail {
    match error {
        GitError::Io(_) | GitError::Timeout { .. } => Fail::Transient,
        GitError::Command { stderr, .. } => {
            if stderr.contains("not a git repository") {
                Fail::Broken
            } else if stderr.contains("no merge base") {
                Fail::NoMergeBase
            } else if stderr.contains("multiple merge bases") {
                Fail::CrissCross
            } else {
                Fail::Transient
            }
        }
    }
}

/// A failure that says nothing about the repository (timeout / spawn error).
fn is_transient(error: &GitError) -> bool {
    matches!(error, GitError::Io(_) | GitError::Timeout { .. })
}

/// `Ok(None)`: no merge base (definite). `Err`: timeout / spawn failure.
async fn merge_base(repo: &str, a: &str, b: &str) -> Result<Option<String>, ()> {
    match run_git_env(
        &["-C", repo, "merge-base", a, b],
        &GIT_ENV,
        Some(Path::new(repo)),
    )
    .await
    {
        Ok(sha) => Ok(Some(sha).filter(|sha| !sha.is_empty())),
        Err(e) if is_transient(&e) => Err(()),
        Err(_) => Ok(None),
    }
}

/// Resolve a worktree's gitdir + the repository's common gitdir from `.git`
/// alone (no exec). `None` when `.git` is missing or points at a missing
/// gitdir — a `broken` worktree (Decision 5).
pub(crate) fn git_dirs(worktree: &Path) -> Option<GitDirs> {
    let dot_git = worktree.join(".git");
    let meta = std::fs::metadata(&dot_git).ok()?;
    if meta.is_dir() {
        return Some(GitDirs {
            gitdir: dot_git.clone(),
            common_dir: dot_git,
        });
    }
    let text = std::fs::read_to_string(&dot_git).ok()?;
    let target = text.trim().strip_prefix("gitdir:")?.trim().to_string();
    if target.is_empty() {
        return None;
    }
    let gitdir = PathBuf::from(&target);
    let gitdir = if gitdir.is_absolute() {
        gitdir
    } else {
        worktree.join(gitdir)
    };
    if !gitdir.exists() {
        return None;
    }
    // A linked worktree's gitdir carries a `commondir` file (usually
    // `../..`); a gitdir without one (a submodule checkout) is its own common
    // dir. Absence of a ref is authoritative, so a wrong path is not allowed.
    let common_dir = match std::fs::read_to_string(gitdir.join("commondir")) {
        Ok(text) => {
            let common = gitdir.join(text.trim());
            if !common.exists() {
                return None;
            }
            common
        }
        Err(_) => gitdir.clone(),
    };
    Some(GitDirs { gitdir, common_dir })
}

pub(crate) fn is_sha(text: &str) -> bool {
    text.len() >= 7 && text.chars().all(|c| c.is_ascii_hexdigit())
}

/// Outcome of reading one ref straight from the ref files.
pub(crate) enum RefLookup {
    Found(String),
    /// Definitely not there (no loose file, no `packed-refs` entry).
    Absent,
    /// Cannot be decided from files (reftable, symbolic ref, IO error): the
    /// caller must ask git.
    Unreadable,
}

/// Read one ref from `<common>/<name>`, then `<common>/packed-refs`.
pub(crate) fn read_ref_file(common_dir: &Path, name: &str) -> RefLookup {
    if common_dir.join("reftable").exists() {
        return RefLookup::Unreadable;
    }
    match std::fs::read_to_string(common_dir.join(name)) {
        Ok(text) => {
            let text = text.trim();
            return if is_sha(text) {
                RefLookup::Found(text.to_string())
            } else {
                RefLookup::Unreadable
            };
        }
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::IsADirectory
            ) => {}
        Err(_) => return RefLookup::Unreadable,
    }
    let packed = match std::fs::read_to_string(common_dir.join("packed-refs")) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return RefLookup::Absent,
        Err(_) => return RefLookup::Unreadable,
    };
    for line in packed.lines() {
        if line.starts_with('#') || line.starts_with('^') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let (Some(sha), Some(refname)) = (parts.next(), parts.next()) else {
            continue;
        };
        if refname == name && is_sha(sha) {
            return RefLookup::Found(sha.to_string());
        }
    }
    RefLookup::Absent
}

/// Read `<gitdir>/HEAD` (a symbolic ref into the common dir, or a raw SHA).
pub(crate) fn read_head_file(gitdir: &Path, common_dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(gitdir.join("HEAD")).ok()?;
    let text = text.trim();
    if let Some(refname) = text.strip_prefix("ref:") {
        return match read_ref_file(common_dir, refname.trim()) {
            RefLookup::Found(sha) => Some(sha),
            RefLookup::Absent | RefLookup::Unreadable => None,
        };
    }
    is_sha(text).then(|| text.to_string())
}
