//! Worktree head/base observation and the bounded background base refresh
//! (plan `tools-pane-rework` Decisions 1-2). `DiffStatPollerHandle` is the
//! single writer of `worktree:head`: it observes after every compute, and its
//! background `git fetch origin <base>` is never run from a request.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use vst_git::git::GitService;
use vst_types::ServerEvent;

use crate::compute::{git_dirs, read_head_file, read_ref_file, RefLookup};
use crate::{unix_ms_now, BoxFuture, DiffStatPollerHandle};

/// Background fetch seam: `(repo_path, base_branch) -> fetched ok`. Tests
/// replace it so no `git` process is spawned.
pub type FetchFn = Arc<dyn Fn(String, String) -> BoxFuture<'static, bool> + Send + Sync>;

/// Seconds between background base fetches after a success.
const FETCH_OK_SPACING_SECS: u64 = 120;
/// Base of the failure backoff (`30 s * 2^(failures-1)`).
const FETCH_BACKOFF_BASE_SECS: u64 = 30;
/// Failure backoff cap.
const FETCH_BACKOFF_CAP_SECS: u64 = 900;

/// What one observation saw: the checked-out head and the base-branch tip.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct HeadObservation {
    pub(crate) head: Option<String>,
    pub(crate) base: Option<String>,
}

/// Per-worktree head tracker state (lives on the poller handle).
#[derive(Debug, Default)]
pub(crate) struct HeadState {
    /// The previous observation; the default (`None`, `None`) means "nothing
    /// known yet", so a first observation that knows nothing emits nothing.
    pub(crate) last: HeadObservation,
    pub(crate) rev: u64,
    pub(crate) failures: u32,
    pub(crate) next_fetch_at: Option<Instant>,
    pub(crate) fetching: bool,
}

/// Read the head sha and the base-branch tip from the ref files (no git exec).
/// The base prefers `refs/remotes/origin/<b>` over `refs/heads/<b>`.
pub(crate) fn observe_refs(worktree: &Path, base_branch: &str) -> HeadObservation {
    let Some(dirs) = git_dirs(worktree) else {
        return HeadObservation::default();
    };
    let head = read_head_file(&dirs.gitdir, &dirs.common_dir);
    let branch = base_branch.strip_prefix("origin/").unwrap_or(base_branch);
    let base = if branch.is_empty() {
        None
    } else {
        [
            format!("refs/remotes/origin/{branch}"),
            format!("refs/heads/{branch}"),
        ]
        .iter()
        .find_map(|name| match read_ref_file(&dirs.common_dir, name) {
            RefLookup::Found(sha) => Some(sha),
            RefLookup::Absent | RefLookup::Unreadable => None,
        })
    };
    HeadObservation { head, base }
}

/// Earliest instant of the next background fetch: success spaces it by
/// [`FETCH_OK_SPACING_SECS`]; failure backs off `30 s * 2^(failures-1)`,
/// capped at 900 s.
pub(crate) fn next_allowed_after(ok: bool, failures: &mut u32, now: Instant) -> Instant {
    if ok {
        *failures = 0;
        now + Duration::from_secs(FETCH_OK_SPACING_SECS)
    } else {
        *failures = failures.saturating_add(1);
        let shift = (*failures - 1).min(5);
        let secs = (FETCH_BACKOFF_BASE_SECS << shift).min(FETCH_BACKOFF_CAP_SECS);
        now + Duration::from_secs(secs)
    }
}

/// The production fetch: bounded, kill-on-drop `git fetch origin <base>`.
pub(crate) fn production_fetch() -> FetchFn {
    let git = GitService::new();
    Arc::new(move |repo: String, base: String| {
        let git = git.clone();
        Box::pin(async move { git.fetch_origin_ok(&repo, &base).await })
    })
}

/// A fetch seam that never runs git and always reports failure (the test default).
pub(crate) fn inert_fetch() -> FetchFn {
    Arc::new(|_repo: String, _base: String| Box::pin(async { false }))
}

impl DiffStatPollerHandle {
    /// Observe the worktree's head/base: emit `worktree:head` on any change
    /// (including the first observation), and start a background base fetch
    /// when one is due. Never holds a lock across an await.
    pub(crate) fn observe_head(
        &self,
        worktree_id: &str,
        path: &Path,
        base_branch: &str,
        repo_path: &str,
    ) {
        let observation = observe_refs(path, base_branch);
        let branch = base_branch
            .strip_prefix("origin/")
            .unwrap_or(base_branch)
            .to_string();
        let now = crate::now();
        let (announce, fetch_due) = {
            let Ok(mut heads) = self.heads.lock() else {
                return;
            };
            // (0) `forget` removes the index entry before the heads entry. A
            // compute that finished after that must not re-create state.
            let known = self
                .index
                .lock()
                .is_ok_and(|index| index.worktrees.contains_key(worktree_id));
            if !known {
                return;
            }
            let state = heads.entry(worktree_id.to_string()).or_default();
            let announce = if state.last == observation {
                None
            } else {
                // `rev = max(prev + 1, unix_ms_now)` — monotonic and restart-safe.
                state.rev = state.rev.saturating_add(1).max(unix_ms_now());
                state.last = observation.clone();
                Some(state.rev)
            };
            let fetch_due = !branch.is_empty()
                && !state.fetching
                && state.next_fetch_at.map_or(true, |at| now >= at);
            if fetch_due {
                state.fetching = true;
            }
            (announce, fetch_due)
        };

        if let Some(rev) = announce {
            self.broadcaster.send(ServerEvent::WorktreeHead {
                worktree_id: worktree_id.to_string(),
                head_sha: observation.head.clone(),
                base_sha: observation.base.clone(),
                rev,
            });
        }

        if fetch_due {
            let this = self.clone();
            let fetch = self.fetch.clone();
            let worktree_id = worktree_id.to_string();
            let path = path.to_path_buf();
            let base_branch = base_branch.to_string();
            let repo_path = repo_path.to_string();
            tokio::spawn(async move {
                let ok = fetch(repo_path.clone(), branch).await;
                if let Ok(mut heads) = this.heads.lock() {
                    if let Some(state) = heads.get_mut(&worktree_id) {
                        state.fetching = false;
                        state.next_fetch_at =
                            Some(next_allowed_after(ok, &mut state.failures, crate::now()));
                    }
                }
                // Re-observe: a moved base is announced now. `next_fetch_at`
                // is in the future, so this cannot start another fetch.
                this.observe_head(&worktree_id, &path, &base_branch, &repo_path);
            });
        }
    }

    /// Test hook: whether head state is tracked for `worktree_id`.
    #[doc(hidden)]
    #[must_use]
    pub fn head_state_tracked(&self, worktree_id: &str) -> bool {
        self.heads
            .lock()
            .is_ok_and(|heads| heads.contains_key(worktree_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_allowed_after_success_spaces_two_minutes_and_resets() {
        let now = Instant::now();
        let mut failures = 3;
        let at = next_allowed_after(true, &mut failures, now);
        assert_eq!(failures, 0);
        assert_eq!(at - now, Duration::from_secs(120));
    }

    #[test]
    fn next_allowed_after_failure_backs_off_then_caps() {
        let now = Instant::now();
        let mut failures = 0;
        let gaps: Vec<u64> = (0..3)
            .map(|_| (next_allowed_after(false, &mut failures, now) - now).as_secs())
            .collect();
        assert_eq!(gaps, vec![30, 60, 120]);
        let mut many = 0;
        let mut last = now;
        for _ in 0..19 {
            last = next_allowed_after(false, &mut many, now);
        }
        assert_eq!(many, 19);
        assert_eq!((last - now).as_secs(), 900, "failure 20 caps at 900 s");
    }

    #[test]
    fn observe_refs_reads_head_and_base_from_loose_refs() {
        let dir = tempfile::tempdir().unwrap();
        let git = dir.path().join(".git");
        std::fs::create_dir_all(git.join("refs/heads")).unwrap();
        std::fs::create_dir_all(git.join("refs/remotes/origin")).unwrap();
        let head = "a".repeat(40);
        let base = "b".repeat(40);
        std::fs::write(git.join("HEAD"), "ref: refs/heads/feat\n").unwrap();
        std::fs::write(git.join("refs/heads/feat"), format!("{head}\n")).unwrap();
        std::fs::write(git.join("refs/remotes/origin/main"), format!("{base}\n")).unwrap();

        let want = HeadObservation {
            head: Some(head.clone()),
            base: Some(base.clone()),
        };
        assert_eq!(observe_refs(dir.path(), "main"), want);
        assert_eq!(observe_refs(dir.path(), "origin/main"), want);
    }

    #[test]
    fn observe_refs_missing_base_ref_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let git = dir.path().join(".git");
        std::fs::create_dir_all(git.join("refs/heads")).unwrap();
        let head = "c".repeat(40);
        std::fs::write(git.join("HEAD"), "ref: refs/heads/feat\n").unwrap();
        std::fs::write(git.join("refs/heads/feat"), format!("{head}\n")).unwrap();
        let obs = observe_refs(dir.path(), "main");
        assert_eq!(obs.head, Some(head));
        assert_eq!(obs.base, None);
    }

    #[test]
    fn observe_refs_resolves_packed_refs_only_repo() {
        let dir = tempfile::tempdir().unwrap();
        let git = dir.path().join(".git");
        std::fs::create_dir_all(&git).unwrap();
        let head = "d".repeat(40);
        let base = "e".repeat(40);
        std::fs::write(git.join("HEAD"), format!("{head}\n")).unwrap();
        std::fs::write(
            git.join("packed-refs"),
            format!(
                "# pack-refs with: peeled\n{base} refs/remotes/origin/main\n{head} refs/heads/feat\n"
            ),
        )
        .unwrap();
        let obs = observe_refs(dir.path(), "main");
        assert_eq!(obs.head, Some(head));
        assert_eq!(obs.base, Some(base));
    }
}
