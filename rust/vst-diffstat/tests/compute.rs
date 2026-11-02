//! `vst-diffstat` compute tests (plan Phase 4.T1).
//!
//! These use REAL temp git repos (unpaused tokio time, per the plan's clock
//! rule) so the ref resolution, `diff-index` invocation and `.git` handling are
//! exercised against actual git.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;

use vst_diffstat::compute::{ComputeInput, ComputeOutcome, DiffStatComputer};
use vst_types::rest::worktrees::DiffStatState;

// ---- repo helpers ---------------------------------------------------------

struct Repo {
    _temp: tempfile::TempDir,
    dir: PathBuf,
}

impl Repo {
    async fn new() -> Self {
        let temp = tempfile::tempdir().expect("tempdir");
        let dir = temp.path().join("repo");
        std::fs::create_dir_all(&dir).expect("repo dir");
        let repo = Self { _temp: temp, dir };
        repo.git(&["init", "-q", "-b", "main"]).await;
        repo.git(&["config", "user.email", "test@example.com"])
            .await;
        repo.git(&["config", "user.name", "Test"]).await;
        repo
    }

    async fn git(&self, args: &[&str]) -> String {
        let dir = self.dir.clone();
        let args: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
        tokio::task::spawn_blocking(move || {
            let out = Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(&args)
                .output()
                .expect("spawn git");
            assert!(
                out.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8(out.stdout)
                .expect("utf8")
                .trim()
                .to_string()
        })
        .await
        .expect("blocking git")
    }

    /// Write a file, stage it and commit.
    async fn commit(&self, file: &str, content: &str, message: &str) -> String {
        std::fs::write(self.dir.join(file), content).expect("write");
        self.git(&["add", file]).await;
        self.git(&["commit", "-qm", message]).await;
        self.git(&["rev-parse", "HEAD"]).await
    }

    fn write(&self, file: &str, content: &str) {
        std::fs::write(self.dir.join(file), content).expect("write");
    }

    async fn rev(&self, r#ref: &str) -> String {
        self.git(&["rev-parse", r#ref]).await
    }

    async fn set_ref(&self, name: &str, sha: &str) {
        self.git(&["update-ref", name, sha]).await;
    }

    /// Counts `git diff --shortstat <rev>` reports (the pre-change behaviour
    /// the daemon must match).
    async fn expected_shortstat(&self, rev: &str) -> (u64, u64) {
        let out = self.git(&["diff", "--shortstat", rev]).await;
        parse_counts(&out)
    }

    fn input(&self, base_branch: &str, base_sha: &str) -> ComputeInput {
        ComputeInput {
            worktree_id: "wt-1".to_string(),
            path: self.dir.clone(),
            base_branch: base_branch.to_string(),
            base_sha: base_sha.to_string(),
        }
    }
}

fn parse_counts(shortstat: &str) -> (u64, u64) {
    let mut insertions = 0;
    let mut deletions = 0;
    let words: Vec<&str> = shortstat.split_whitespace().collect();
    for pair in words.windows(2) {
        if let Ok(n) = pair[0].parse::<u64>() {
            if pair[1].starts_with("insertion") {
                insertions = n;
            } else if pair[1].starts_with("deletion") {
                deletions = n;
            }
        }
    }
    (insertions, deletions)
}

fn assert_ok(outcome: &ComputeOutcome, insertions: u64, deletions: u64) {
    assert_eq!(outcome.state, DiffStatState::Ok, "outcome: {outcome:?}");
    assert_eq!(
        (outcome.insertions, outcome.deletions),
        (insertions, deletions),
        "outcome: {outcome:?}"
    );
}

fn index_signature(repo: &Path) -> (Vec<u8>, u64) {
    let index = repo.join(".git/index");
    let bytes = std::fs::read(&index).expect("index readable");
    let mtime = u64::try_from(
        std::fs::metadata(&index)
            .expect("index metadata")
            .modified()
            .expect("mtime")
            .duration_since(UNIX_EPOCH)
            .expect("epoch")
            .as_nanos(),
    )
    .unwrap_or(u64::MAX);
    (bytes, mtime)
}

// ---- 1. counts match `git diff --shortstat <base>` ----------------------

#[tokio::test]
async fn counts_match_the_legacy_shortstat() {
    let repo = Repo::new().await;
    let base = repo.commit("f", "a\n", "c1").await;
    repo.set_ref("refs/remotes/origin/main", &base).await;
    // A worktree-style branch: HEAD moves on, the base branch stays put.
    repo.git(&["checkout", "-q", "--detach"]).await;
    repo.commit("f", "a\nb\nc\n", "c2").await;

    let expected = repo.expected_shortstat(&base).await;
    let computer = DiffStatComputer::new();
    let outcome = computer.compute(&repo.input("main", &base)).await;
    assert_ok(&outcome, expected.0, expected.1);
    assert_eq!(expected, (2, 0));
}

// ---- 2. untracked files are excluded ------------------------------------

#[tokio::test]
async fn untracked_files_are_excluded() {
    let repo = Repo::new().await;
    let base = repo.commit("f", "a\n", "c1").await;
    repo.set_ref("refs/remotes/origin/main", &base).await;
    repo.write("untracked.txt", "one\ntwo\nthree\n");

    let computer = DiffStatComputer::new();
    let outcome = computer.compute(&repo.input("main", &base)).await;
    assert_ok(&outcome, 0, 0);
}

// ---- 3. origin vs local ref choice --------------------------------------

#[tokio::test]
async fn local_descendant_is_chosen_over_origin() {
    let repo = Repo::new().await;
    let origin_sha = repo.commit("f", "a\n", "c1").await;
    repo.set_ref("refs/remotes/origin/main", &origin_sha).await;
    // main (local) is ahead of origin/main; HEAD is that local commit.
    repo.commit("f", "a\nb\n", "c2").await;
    // One unstaged change on top of the local commit.
    repo.write("f", "a\nb\nc\n");

    let expected = repo.expected_shortstat("HEAD").await;
    let computer = DiffStatComputer::new();
    let outcome = computer.compute(&repo.input("main", &origin_sha)).await;
    // Diffing against origin/main would also count c2's insertion.
    assert_ok(&outcome, expected.0, expected.1);
    assert_eq!(expected, (1, 0));
}

#[tokio::test]
async fn origin_descendant_is_chosen_over_local() {
    let repo = Repo::new().await;
    let base = repo.commit("f", "a\n", "c1").await;
    // origin/main advances on a detached HEAD; the local base branch stays put.
    repo.git(&["checkout", "-q", "--detach"]).await;
    let origin_sha = repo.commit("f", "a\nb\n", "origin-advance").await;
    repo.set_ref("refs/remotes/origin/main", &origin_sha).await;
    repo.set_ref("refs/heads/main", &base).await;
    // Move HEAD back to the base commit (this also restores the worktree).
    repo.git(&["checkout", "-q", "--detach", &base]).await;
    repo.write("g", "work\n");
    repo.git(&["add", "g"]).await;

    let expected = repo.expected_shortstat(&base).await;
    let computer = DiffStatComputer::new();
    let outcome = computer.compute(&repo.input("main", &base)).await;
    assert_ok(&outcome, expected.0, expected.1);
    assert_eq!(expected, (1, 0));
}

// ---- 4. no resolvable base ⇒ unavailable -------------------------------

#[tokio::test]
async fn unresolvable_base_is_unavailable() {
    let repo = Repo::new().await;
    repo.commit("f", "a\n", "c1").await;

    let computer = DiffStatComputer::new();
    let outcome = computer
        .compute(&repo.input("does-not-exist", &"f".repeat(40)))
        .await;
    assert_eq!(outcome.state, DiffStatState::Unavailable);
    assert_eq!((outcome.insertions, outcome.deletions), (0, 0));
}

#[tokio::test]
async fn empty_base_sha_without_refs_is_unavailable() {
    let repo = Repo::new().await;
    repo.commit("f", "a\n", "c1").await;

    let computer = DiffStatComputer::new();
    // Neither `origin/<branch>` nor `<branch>` resolves and there is no
    // recorded base_sha to fall back to.
    let outcome = computer.compute(&repo.input("does-not-exist", "")).await;
    assert_eq!(outcome.state, DiffStatState::Unavailable);
}

// ---- 5. a cache hit is exactly ONE exec --------------------------------

#[tokio::test]
async fn cache_hit_runs_one_exec_and_no_ref_resolution() {
    let repo = Repo::new().await;
    let origin_sha = repo.commit("f", "a\n", "c1").await;
    repo.set_ref("refs/remotes/origin/main", &origin_sha).await;
    repo.commit("f", "a\nb\n", "c2").await;

    let computer = DiffStatComputer::new();
    let input = repo.input("main", &origin_sha);

    let cold = computer.compute(&input).await;
    assert_eq!(cold.state, DiffStatState::Ok);
    let after_cold = computer.execs();
    assert!(
        after_cold >= 1,
        "a cold compute resolves the ref choice and diffs"
    );

    let warm = computer.compute(&input).await;
    assert_eq!(warm, cold, "the same refs must produce the same numbers");
    assert_eq!(
        computer.execs() - after_cold,
        1,
        "a cache hit must be ONE `diff-index` exec (no rev-parse/merge-base)"
    );
}

#[tokio::test]
async fn identical_refs_are_one_exec_cold_and_warm() {
    let repo = Repo::new().await;
    let sha = repo.commit("f", "a\n", "c1").await;
    repo.set_ref("refs/remotes/origin/main", &sha).await;
    repo.write("g", "one\n");

    let computer = DiffStatComputer::new();
    let input = repo.input("main", &sha);
    assert_eq!(computer.compute(&input).await.state, DiffStatState::Ok);
    assert_eq!(computer.execs(), 1, "equal refs need no ancestry exec");
    assert_eq!(computer.compute(&input).await.state, DiffStatState::Ok);
    assert_eq!(computer.execs(), 2);
}

// ---- 6. the index is never written --------------------------------------

#[tokio::test]
async fn compute_never_touches_the_index() {
    let repo = Repo::new().await;
    let base = repo.commit("f", "a\n", "c1").await;
    repo.set_ref("refs/remotes/origin/main", &base).await;
    repo.git(&["checkout", "-q", "--detach"]).await;
    repo.commit("f", "a\nb\n", "c2").await;
    repo.write("f", "a\nb\nc\n");

    let before = index_signature(&repo.dir);
    let computer = DiffStatComputer::new();
    let outcome = computer.compute(&repo.input("main", &base)).await;
    assert_eq!(outcome.state, DiffStatState::Ok);
    let after = index_signature(&repo.dir);
    assert_eq!(before, after, "`diff-index` must never rewrite the index");
}

// ---- 7. a stale `.git` file is broken, with no exec ---------------------

#[tokio::test]
async fn a_stale_dot_git_file_is_broken_without_running_git() {
    let temp = tempfile::tempdir().expect("tempdir");
    let worktree = temp.path().join("stale");
    std::fs::create_dir_all(&worktree).expect("worktree dir");
    std::fs::write(
        worktree.join(".git"),
        "gitdir: /home/gb/.vibe-station/projects/p/worktrees/wt-1\n",
    )
    .expect("write .git");

    let computer = DiffStatComputer::new();
    let input = ComputeInput {
        worktree_id: "wt-1".to_string(),
        path: worktree.clone(),
        base_branch: "main".to_string(),
        base_sha: "a".repeat(40),
    };
    let outcome = computer.compute(&input).await;
    assert_eq!(outcome.state, DiffStatState::Broken);
    assert_eq!(outcome.hint.as_deref(), Some("git worktree repair"));
    assert!(
        outcome.stamp.is_some(),
        "a broken outcome carries the .git stamp the poller compares"
    );
    assert_eq!(computer.execs(), 0, "a broken worktree must not run git");
}

// ---- 8. criss-cross history uses the merge-base fallback ----------------

#[tokio::test]
async fn criss_cross_history_falls_back_to_merge_base_plus_diff_index() {
    let repo = Repo::new().await;
    repo.commit("a", "A\n", "A").await;
    repo.git(&["branch", "side"]).await;
    let b = repo.commit("b", "B\n", "B").await;
    repo.git(&["checkout", "-q", "side"]).await;
    repo.commit("c", "C\n", "C").await;
    repo.git(&["checkout", "-q", "main"]).await;
    repo.git(&["merge", "-q", "--no-ff", "side", "-m", "M1"])
        .await;
    let m1 = repo.rev("main").await;
    repo.git(&["checkout", "-q", "side"]).await;
    repo.git(&["merge", "-q", "--no-ff", &b, "-m", "M2"]).await;
    let m2 = repo.rev("HEAD").await;
    assert_ne!(m1, m2);

    // HEAD detached at M1; origin/main = M2 (the criss-cross partner), local
    // main = B (an ancestor of M2) so the origin ref is the chosen one.
    repo.git(&["checkout", "-q", "--detach", &m1]).await;
    repo.set_ref("refs/remotes/origin/main", &m2).await;
    repo.set_ref("refs/heads/main", &b).await;

    // `git diff-index --merge-base origin/main` refuses ("multiple merge
    // bases"), so the fallback must pick one merge base and diff against it.
    let picked = repo.git(&["merge-base", "origin/main", "HEAD"]).await;
    let expected = repo.expected_shortstat(&picked).await;

    let computer = DiffStatComputer::new();
    let input = repo.input("main", &b);
    let outcome = computer.compute(&input).await;
    assert_ok(&outcome, expected.0, expected.1);

    // The criss-cross path is cached on the same key: a warm compute still
    // returns the same numbers.
    let warm = computer.compute(&input).await;
    assert_eq!(warm, outcome);
}

// ---- 9. diverged histories match the old resolve_base_sha rule ----------

#[tokio::test]
async fn diverged_origin_and_local_pick_the_advanced_fork_point() {
    // origin = F→C, local = F→A→B, HEAD = F→A→W ⇒ base A (the old rule).
    let repo = Repo::new().await;
    let f = repo.commit("f", "F\n", "F").await;
    let a = repo.commit("a", "A\n", "A").await;
    let b = repo.commit("b", "B\n", "B").await;
    repo.git(&["branch", "origin-side", &f]).await;
    repo.git(&["checkout", "-q", "origin-side"]).await;
    let c = repo.commit("c", "C\n", "C").await;
    repo.git(&["checkout", "-q", "main"]).await;
    // W branches from A.
    repo.git(&["checkout", "-q", "-b", "wt", &a]).await;
    repo.commit("w", "W\n", "W").await;

    repo.set_ref("refs/heads/main", &b).await;
    repo.set_ref("refs/remotes/origin/main", &c).await;
    let head = repo.rev("HEAD").await;

    // Old rule: l = merge-base(HEAD, local) = A; o = merge-base(HEAD, origin)
    // = F; F is an ancestor of A ⇒ local (A) wins.
    let local_mb = repo.git(&["merge-base", &head, &b]).await;
    let origin_mb = repo.git(&["merge-base", &head, &c]).await;
    assert_ne!(local_mb, origin_mb);
    let expected = repo.expected_shortstat(&local_mb).await;

    let computer = DiffStatComputer::new();
    let outcome = computer.compute(&repo.input("main", &b)).await;
    assert_ok(&outcome, expected.0, expected.1);
    assert_eq!(local_mb, a, "the chosen base must be A");
}

#[tokio::test]
async fn local_ancestor_of_head_is_the_chosen_ref() {
    // origin = F, local = F→A, HEAD = F→A→W ⇒ local (A) wins.
    let repo = Repo::new().await;
    let f = repo.commit("f", "F\n", "F").await;
    let a = repo.commit("a", "A\n", "A").await;
    repo.git(&["checkout", "-q", "-b", "wt", &a]).await;
    repo.commit("w", "W\n", "W").await;
    repo.set_ref("refs/heads/main", &a).await;
    repo.set_ref("refs/remotes/origin/main", &f).await;

    let expected = repo.expected_shortstat(&a).await;
    let computer = DiffStatComputer::new();
    let outcome = computer.compute(&repo.input("main", &a)).await;
    assert_ok(&outcome, expected.0, expected.1);
    assert_eq!(expected, (1, 0));
}

// ---- 10. `no merge base` walks the documented fallbacks -----------------

#[tokio::test]
async fn no_merge_base_falls_to_the_other_ref_then_the_base_sha() {
    let repo = Repo::new().await;
    // Two unrelated histories: main = A, origin/main = Z→Z2.
    let a = repo.commit("a", "A\n", "A").await;
    repo.git(&["checkout", "-q", "--orphan", "other"]).await;
    repo.git(&["rm", "-q", "-rf", "."]).await;
    let z = repo.commit("z", "Z\n", "Z").await;
    let z2 = repo.commit("z", "Z\nZ2\n", "Z2").await;
    // origin/main is the descendant of local main, so origin is chosen; HEAD
    // (A) shares no history with either, so both refs fail `no merge base` and
    // the recorded base_sha is the only usable base.
    repo.git(&["checkout", "-q", "--detach", &a]).await;
    repo.set_ref("refs/remotes/origin/main", &z2).await;
    repo.set_ref("refs/heads/main", &z).await;

    let computer = DiffStatComputer::new();
    let outcome = computer.compute(&repo.input("main", &a)).await;
    // HEAD == base_sha ⇒ an empty diff, but it must be Ok (not Unavailable).
    assert_ok(&outcome, 0, 0);
}

#[tokio::test]
async fn no_merge_base_and_no_valid_base_sha_is_unavailable() {
    let repo = Repo::new().await;
    let a = repo.commit("a", "A\n", "A").await;
    repo.git(&["checkout", "-q", "--orphan", "other"]).await;
    repo.git(&["rm", "-q", "-rf", "."]).await;
    let z = repo.commit("z", "Z\n", "Z").await;
    let z2 = repo.commit("z", "Z\nZ2\n", "Z2").await;
    repo.git(&["checkout", "-q", "--detach", &a]).await;
    repo.set_ref("refs/remotes/origin/main", &z2).await;
    repo.set_ref("refs/heads/main", &z).await;

    let computer = DiffStatComputer::new();
    let input = repo.input("main", &"b".repeat(40));
    let outcome = computer.compute(&input).await;
    assert_eq!(outcome.state, DiffStatState::Unavailable);

    // Unavailable is cached on the same key: no execs while nothing moves.
    let after_cold = computer.execs();
    let again = computer.compute(&input).await;
    assert_eq!(again.state, DiffStatState::Unavailable);
    assert_eq!(computer.execs() - after_cold, 0, "cached, zero execs");

    // HEAD moves onto a commit that merges the unrelated base: re-resolved.
    repo.git(&["merge", "-q", "--allow-unrelated-histories", "-m", "m", &z2])
        .await;
    let merged = computer.compute(&input).await;
    assert_eq!(merged.state, DiffStatState::Ok, "outcome: {merged:?}");
}

#[tokio::test]
async fn a_fallback_choice_is_recomputed_when_head_moves() {
    let repo = Repo::new().await;
    let a = repo.commit("a", "A\n", "A").await;
    repo.git(&["checkout", "-q", "--orphan", "other"]).await;
    repo.git(&["rm", "-q", "-rf", "."]).await;
    let z = repo.commit("z", "Z\n", "Z").await;
    let z2 = repo.commit("z", "Z\nZ2\n", "Z2").await;
    repo.git(&["checkout", "-q", "--detach", &a]).await;
    repo.set_ref("refs/remotes/origin/main", &z2).await;
    repo.set_ref("refs/heads/main", &z).await;

    let computer = DiffStatComputer::new();
    let input = repo.input("main", &a);
    assert_ok(&computer.compute(&input).await, 0, 0);
    let before = computer.execs();
    assert_ok(&computer.compute(&input).await, 0, 0);
    assert_eq!(computer.execs() - before, 1, "cached fallback: one exec");

    // HEAD moves: the choice is re-resolved (more than the single diff exec).
    repo.commit("a", "A\nA2\n", "A2").await;
    let before = computer.execs();
    assert_ok(&computer.compute(&input).await, 1, 0);
    assert!(
        computer.execs() - before > 1,
        "a moved HEAD must re-resolve the fallback choice"
    );
}

// ---- R1F-13: an absent ref is a definite answer (one exec per compute) ---

async fn warm_delta(repo: &Repo, input: &ComputeInput) -> u64 {
    let computer = DiffStatComputer::new();
    let cold = computer.compute(input).await;
    assert_eq!(cold.state, DiffStatState::Ok, "cold: {cold:?}");
    let before = computer.execs();
    let warm = computer.compute(input).await;
    assert_eq!(warm, cold);
    let _ = repo;
    computer.execs() - before
}

#[tokio::test]
async fn only_the_origin_ref_present_is_one_exec_when_warm() {
    let repo = Repo::new().await;
    let base = repo.commit("f", "a\n", "c1").await;
    repo.set_ref("refs/remotes/origin/main", &base).await;
    repo.git(&["checkout", "-q", "-b", "feat"]).await;
    repo.git(&["branch", "-q", "-D", "main"]).await;
    repo.commit("f", "a\nb\n", "c2").await;
    assert_eq!(warm_delta(&repo, &repo.input("main", "")).await, 1);
}

#[tokio::test]
async fn only_the_local_ref_present_is_one_exec_when_warm() {
    let repo = Repo::new().await;
    let base = repo.commit("f", "a\n", "c1").await;
    repo.git(&["checkout", "-q", "-b", "feat"]).await;
    repo.commit("f", "a\nb\n", "c2").await;
    assert_eq!(warm_delta(&repo, &repo.input("main", &base)).await, 1);
}

#[tokio::test]
async fn packed_only_refs_are_one_exec_when_warm() {
    let repo = Repo::new().await;
    let base = repo.commit("f", "a\n", "c1").await;
    repo.set_ref("refs/remotes/origin/main", &base).await;
    repo.git(&["checkout", "-q", "-b", "feat"]).await;
    repo.commit("f", "a\nb\n", "c2").await;
    repo.git(&["pack-refs", "--all"]).await;
    assert!(!repo.dir.join(".git/refs/remotes/origin/main").exists());
    assert_eq!(warm_delta(&repo, &repo.input("main", &base)).await, 1);
}

#[tokio::test]
async fn both_refs_missing_with_a_valid_base_sha_is_one_exec_when_warm() {
    let repo = Repo::new().await;
    let base = repo.commit("f", "a\n", "c1").await;
    repo.git(&["checkout", "-q", "-b", "feat"]).await;
    repo.git(&["branch", "-q", "-D", "main"]).await;
    repo.commit("f", "a\nb\n", "c2").await;
    assert_eq!(warm_delta(&repo, &repo.input("main", &base)).await, 1);
}

// ---- 11. pre-2.30 fallback path (parse only) ---------------------------

#[tokio::test]
async fn legacy_fallback_parses_the_shortstat() {
    use vst_git::GitVersion;

    let repo = Repo::new().await;
    let base = repo.commit("f", "a\n", "c1").await;
    repo.set_ref("refs/remotes/origin/main", &base).await;
    repo.git(&["checkout", "-q", "--detach"]).await;
    repo.commit("f", "a\nb\nc\n", "c2").await;
    repo.set_ref("refs/heads/main", &base).await;

    let expected = repo.expected_shortstat(&base).await;
    let computer = DiffStatComputer::new().with_version_override(GitVersion {
        major: 2,
        minor: 29,
        patch: 0,
    });
    let outcome = computer.compute(&repo.input("main", &base)).await;
    assert_ok(&outcome, expected.0, expected.1);
    assert_eq!(expected, (2, 0));
}

// ---- R2F-04: a remote-tracking or tag base resolves like git does --------

async fn base_ref_case(base_name: &str, set: &str, pack: bool) {
    let repo = Repo::new().await;
    let old = repo.commit("f", "a\n", "c1").await;
    let newer = repo.commit("f", "a\nb\n", "c2").await;
    repo.set_ref(set, &newer).await;
    repo.git(&["checkout", "-q", "-b", "feat"]).await;
    repo.git(&["branch", "-q", "-D", "main"]).await;
    repo.commit("f", "a\nb\nc\n", "c3").await;
    if pack {
        repo.git(&["pack-refs", "--all"]).await;
    }
    let expected = repo.expected_shortstat(&newer).await;
    assert_eq!(expected, (1, 0));
    let input = repo.input(base_name, &old);
    let computer = DiffStatComputer::new();
    let cold = computer.compute(&input).await;
    assert_ok(&cold, expected.0, expected.1);
    let before = computer.execs();
    assert_eq!(computer.compute(&input).await, cold);
    assert_eq!(computer.execs() - before, 1);
}

#[tokio::test]
async fn remote_tracking_base_resolves_like_git() {
    base_ref_case("origin/main", "refs/remotes/origin/main", false).await;
}

#[tokio::test]
async fn tag_base_resolves_like_git() {
    base_ref_case("v1", "refs/tags/v1", false).await;
}

#[tokio::test]
async fn packed_remote_tracking_base_resolves_like_git() {
    base_ref_case("origin/main", "refs/remotes/origin/main", true).await;
    base_ref_case("v1", "refs/tags/v1", true).await;
}

// ---- R2F-06: linked worktrees (the production layout) -------------------

fn run_git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("spawn git");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout)
        .expect("utf8")
        .trim()
        .to_string()
}

/// `git worktree add <tmp>/wt -b feature` from `repo` (which needs a commit).
fn add_linked(repo: &Repo) -> PathBuf {
    let wt = repo.dir.parent().expect("repo parent").join("wt");
    run_git(
        &repo.dir,
        &[
            "worktree",
            "add",
            "-q",
            wt.to_str().expect("utf8"),
            "-b",
            "feature",
        ],
    );
    wt
}

fn linked_input(wt: &Path, base_branch: &str, base_sha: &str) -> ComputeInput {
    ComputeInput {
        worktree_id: "wt-linked".to_string(),
        path: wt.to_path_buf(),
        base_branch: base_branch.to_string(),
        base_sha: base_sha.to_string(),
    }
}

async fn linked_counts_and_warm(pack: bool) {
    let repo = Repo::new().await;
    let base = repo.commit("f", "a\n", "c1").await;
    let wt = add_linked(&repo);
    std::fs::write(wt.join("f"), "a\nb\nc\n").expect("edit");
    if pack {
        repo.git(&["pack-refs", "--all"]).await;
    }
    let expected = parse_counts(&run_git(&wt, &["diff", "--shortstat", &base]));
    assert_eq!(expected, (2, 0));
    let input = linked_input(&wt, "main", &base);
    let computer = DiffStatComputer::new();
    let cold = computer.compute(&input).await;
    assert_ok(&cold, expected.0, expected.1);
    let before = computer.execs();
    assert_eq!(computer.compute(&input).await, cold);
    assert_eq!(computer.execs() - before, 1);
}

#[tokio::test]
async fn linked_worktree_counts_match_and_warm_is_one_exec() {
    linked_counts_and_warm(false).await;
}

#[tokio::test]
async fn linked_worktree_packed_refs_warm_is_one_exec() {
    linked_counts_and_warm(true).await;
}

#[tokio::test]
async fn linked_worktree_slash_base_branch() {
    for pack in [false, true] {
        let repo = Repo::new().await;
        let base = repo.commit("f", "a\n", "c1").await;
        repo.git(&["branch", "release/1.0", &base]).await;
        let wt = add_linked(&repo);
        std::fs::write(wt.join("f"), "a\nb\n").expect("edit");
        if pack {
            repo.git(&["pack-refs", "--all"]).await;
        }
        let input = linked_input(&wt, "release/1.0", "");
        let computer = DiffStatComputer::new();
        let cold = computer.compute(&input).await;
        assert_ok(&cold, 1, 0);
        let before = computer.execs();
        assert_eq!(computer.compute(&input).await, cold);
        assert_eq!(computer.execs() - before, 1, "pack={pack}");
    }
}

#[tokio::test]
async fn linked_worktree_never_touches_its_index() {
    let repo = Repo::new().await;
    let base = repo.commit("f", "a\n", "c1").await;
    let wt = add_linked(&repo);
    let gitdir = PathBuf::from(run_git(&wt, &["rev-parse", "--absolute-git-dir"]));
    let index = gitdir.join("index");
    assert!(index.exists(), "linked worktree has its own index");
    // Stat-dirty the file: same content, newer mtime.
    std::thread::sleep(std::time::Duration::from_millis(20));
    run_git(&wt, &["add", "f"]);
    let before_bytes = std::fs::read(&index).expect("index");
    let before_mtime = std::fs::metadata(&index)
        .expect("meta")
        .modified()
        .expect("mtime");
    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(wt.join("f"), "a\n").expect("touch");

    let computer = DiffStatComputer::new();
    let outcome = computer.compute(&linked_input(&wt, "main", &base)).await;
    assert_eq!(outcome.state, DiffStatState::Ok, "{outcome:?}");

    assert_eq!(std::fs::read(&index).expect("index"), before_bytes);
    assert_eq!(
        std::fs::metadata(&index)
            .expect("meta")
            .modified()
            .expect("mtime"),
        before_mtime
    );
    assert!(!gitdir.join("index.lock").exists());
}

#[tokio::test]
async fn deleted_linked_gitdir_is_broken_with_no_exec() {
    let repo = Repo::new().await;
    let base = repo.commit("f", "a\n", "c1").await;
    let wt = add_linked(&repo);
    let gitdir = PathBuf::from(run_git(&wt, &["rev-parse", "--absolute-git-dir"]));
    std::fs::remove_dir_all(&gitdir).expect("remove gitdir");

    let computer = DiffStatComputer::new();
    let outcome = computer.compute(&linked_input(&wt, "main", &base)).await;
    assert_eq!(outcome.state, DiffStatState::Broken);
    assert_eq!(computer.execs(), 0);
}

#[tokio::test]
async fn missing_worktree_directory_is_broken_with_missing_dir_hint() {
    let temp = tempfile::tempdir().expect("tempdir");
    let missing_worktree = temp.path().join("does_not_exist");
    let computer = DiffStatComputer::new();
    let input = ComputeInput {
        worktree_id: "wt-missing".into(),
        path: missing_worktree,
        base_branch: "main".into(),
        base_sha: "a".repeat(40),
    };
    let outcome = computer.compute(&input).await;
    assert_eq!(outcome.state, DiffStatState::Broken);
    assert_eq!(
        outcome.hint.as_deref(),
        Some("worktree directory is missing")
    );
    assert_eq!(computer.execs(), 0);
}

#[tokio::test]
async fn non_c_locale_in_parent_still_classifies_correctly() {
    let exe = std::env::current_exe().expect("current test exe");
    let output = std::process::Command::new(exe)
        .arg("--exact")
        .arg("criss_cross_history_falls_back_to_merge_base_plus_diff_index")
        .env("LC_ALL", "de_DE.UTF-8")
        .env("LANG", "de_DE.UTF-8")
        .env("LANGUAGE", "de_DE:de")
        .output()
        .expect("run test binary in child with non-C locale");
    assert!(
        output.status.success(),
        "test in non-C locale failed:\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn non_c_locale_no_merge_base_still_classifies_correctly() {
    let exe = std::env::current_exe().expect("current test exe");
    let output = std::process::Command::new(exe)
        .arg("--exact")
        .arg("no_merge_base_falls_to_the_other_ref_then_the_base_sha")
        .env("LC_ALL", "fr_FR.UTF-8")
        .env("LANG", "fr_FR.UTF-8")
        .env("LANGUAGE", "fr_FR:fr")
        .output()
        .expect("run test binary in child with non-C locale");
    assert!(
        output.status.success(),
        "test in non-C locale failed:\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
