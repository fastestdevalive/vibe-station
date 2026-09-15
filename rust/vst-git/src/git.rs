//! Ports `git.ts` — low-level git plumbing invoked as one-shot
//! `tokio::process::Command` requests.
//!
//! All functions shell out to the `git` CLI using `Command` with args passed
//! directly (no shell interpolation), preventing injection from user-supplied
//! paths/branches. The only stateful part is [`GitService`], which owns
//! `fetchOrigin`'s in-flight-dedupe + success-only-cooldown maps.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use tokio::process::Command;
use tokio::sync::Notify;

/// The well-known empty-tree SHA (`git hash-object -t tree /dev/null`).
pub const EMPTY_TREE_SHA: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// Errors surfaced by the low-level git operations.
#[derive(Debug, thiserror::Error)]
pub enum GitError {
    /// `git` exited non-zero; includes the invocation and stderr.
    #[error("git {args} failed: {stderr}")]
    Command { args: String, stderr: String },
    /// The subprocess could not be spawned (e.g. `git` missing from PATH).
    #[error("failed to run git: {0}")]
    Io(#[from] std::io::Error),
}

type GitResult<T> = Result<T, GitError>;

/// Run `git <args>` (optionally with `cwd`), returning trimmed stdout.
async fn run_git(args: &[&str], cwd: Option<&Path>) -> GitResult<String> {
    let mut cmd = Command::new("git");
    cmd.args(args);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    let out = cmd.output().await?;
    if !out.status.success() {
        return Err(GitError::Command {
            args: args.join(" "),
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Like [`run_git`], but returns raw untrimmed stdout. `git submodule status`'s
/// clean-status lines start with a significant leading space (the status flag
/// column), which `.trim()` would silently eat off the first line only.
async fn run_git_raw(args: &[&str], cwd: Option<&Path>) -> GitResult<String> {
    let mut cmd = Command::new("git");
    cmd.args(args);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    let out = cmd.output().await?;
    if !out.status.success() {
        return Err(GitError::Command {
            args: args.join(" "),
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Returns true if `dir` is inside a git repository.
pub async fn is_git_repo(dir: &str) -> bool {
    run_git(&["-C", dir, "rev-parse", "--git-dir"], Some(Path::new(dir)))
        .await
        .is_ok()
}

/// Returns true if `dir`'s HEAD resolves to a commit (the repo has at least
/// one commit).
pub async fn has_commits(dir: &str) -> bool {
    run_git(
        &["-C", dir, "rev-parse", "--verify", "HEAD"],
        Some(Path::new(dir)),
    )
    .await
    .is_ok()
}

/// Detect the default branch for a repo using the fallback chain:
/// 1. `git symbolic-ref refs/remotes/origin/HEAD`
/// 2. local branch "master"
/// 3. local branch "main"
/// 4. first branch in `git branch --list`
pub async fn detect_default_branch(repo_path: &str) -> Option<String> {
    // 1. origin/HEAD symref
    if let Ok(ref_) = run_git(
        &["-C", repo_path, "symbolic-ref", "refs/remotes/origin/HEAD"],
        Some(Path::new(repo_path)),
    )
    .await
    {
        let branch = ref_.rsplit('/').next().unwrap_or("").to_string();
        if !branch.is_empty() {
            return Some(branch);
        }
    }

    // 2. "master" exists locally
    if run_git(
        &["-C", repo_path, "rev-parse", "--verify", "master"],
        Some(Path::new(repo_path)),
    )
    .await
    .is_ok()
    {
        return Some("master".to_string());
    }

    // 3. "main" exists locally
    if run_git(
        &["-C", repo_path, "rev-parse", "--verify", "main"],
        Some(Path::new(repo_path)),
    )
    .await
    .is_ok()
    {
        return Some("main".to_string());
    }

    // 4. First branch in `git branch --list`
    if let Ok(output) = run_git(
        &["-C", repo_path, "branch", "--list"],
        Some(Path::new(repo_path)),
    )
    .await
    {
        let lines: Vec<String> = output
            .split('\n')
            .map(|l| l.trim_start_matches(['*', ' ']).trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        if let Some(first) = lines.first() {
            return Some(first.clone());
        }
    }

    None
}

/// Returns true if `branch` exists locally in the repo at `repo_path`.
pub async fn branch_exists(repo_path: &str, branch: &str) -> bool {
    run_git(
        &["-C", repo_path, "rev-parse", "--verify", branch],
        Some(Path::new(repo_path)),
    )
    .await
    .is_ok()
}

/// List local branch names in the repo, sorted by most-recent commit first.
pub async fn list_branches(repo_path: &str) -> Vec<String> {
    let out = run_git(
        &[
            "-C",
            repo_path,
            "branch",
            "--list",
            "--sort=-committerdate",
            "--format=%(refname:short)",
        ],
        Some(Path::new(repo_path)),
    )
    .await
    .unwrap_or_default();
    out.split('\n')
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// Returns the full SHA of `ref` in the repo.
pub async fn rev_parse(repo_path: &str, r#ref: &str) -> GitResult<String> {
    run_git(
        &["-C", repo_path, "rev-parse", r#ref],
        Some(Path::new(repo_path)),
    )
    .await
}

/// Resolve the parent of `sha` for a commit-scoped diff. Tries `<sha>^1`
/// first; if it fails only because `sha` is a root commit, falls back to
/// `EMPTY_TREE_SHA`. Any other failure is re-thrown (verified via
/// `git rev-list --max-parents=0`, not by pattern-matching git's message).
pub async fn resolve_parent_sha(repo_path: &str, sha: &str) -> GitResult<String> {
    match run_git(
        &["-C", repo_path, "rev-parse", &format!("{sha}^1")],
        Some(Path::new(repo_path)),
    )
    .await
    {
        Ok(parent) => Ok(parent),
        Err(original) => {
            let mut is_root_commit = false;
            let resolved = rev_parse(repo_path, sha).await;
            let nearest_root = run_git(
                &["-C", repo_path, "rev-list", "--max-parents=0", "-1", sha],
                Some(Path::new(repo_path)),
            )
            .await;
            if let (Ok(resolved), Ok(nearest_root)) = (resolved, nearest_root) {
                is_root_commit = resolved == nearest_root;
            }
            if is_root_commit {
                Ok(EMPTY_TREE_SHA.to_string())
            } else {
                Err(original)
            }
        }
    }
}

/// Returns true if `ancestor` is an ancestor of (or equal to) `descendant`.
/// Exit code 0 = true, 1 = false; any other failure propagates.
async fn is_ancestor(repo_path: &str, ancestor: &str, descendant: &str) -> GitResult<bool> {
    let mut cmd = Command::new("git");
    cmd.args([
        "-C",
        repo_path,
        "merge-base",
        "--is-ancestor",
        ancestor,
        descendant,
    ]);
    cmd.current_dir(repo_path);
    let status = cmd.status().await?;
    if status.success() {
        Ok(true)
    } else if status.code() == Some(1) {
        Ok(false)
    } else {
        Err(GitError::Command {
            args: format!("merge-base --is-ancestor {ancestor} {descendant}"),
            stderr: format!("exit status {:?}", status.code()),
        })
    }
}

/// Resolve the *current* fork point between `HEAD` and `baseBranch`, preferring
/// `origin/<baseBranch>` over the local `baseBranch`, falling back to
/// `fallback_base_sha`. Returns `Ok(None)` if nothing resolves.
pub async fn resolve_base_sha(
    repo_path: &str,
    base_branch: Option<&str>,
    fallback_base_sha: Option<&str>,
) -> GitResult<Option<String>> {
    if let Some(base_branch) = base_branch {
        let origin_merge_base = run_git(
            &[
                "-C",
                repo_path,
                "merge-base",
                "HEAD",
                &format!("origin/{base_branch}"),
            ],
            Some(Path::new(repo_path)),
        )
        .await
        .ok();
        let local_merge_base = run_git(
            &["-C", repo_path, "merge-base", "HEAD", base_branch],
            Some(Path::new(repo_path)),
        )
        .await
        .ok();

        match (origin_merge_base, local_merge_base) {
            (Some(o), Some(l)) if o == l => return Ok(Some(o)),
            (Some(o), Some(l)) => {
                // The more-advanced fork point is the one that is NOT an
                // ancestor of the other. Check both directions explicitly.
                if let Ok(true) = is_ancestor(repo_path, &l, &o).await {
                    return Ok(Some(o));
                }
                if let Ok(true) = is_ancestor(repo_path, &o, &l).await {
                    return Ok(Some(l));
                }
                // Divergent histories with no ancestor relationship — fall
                // back to origin defensively.
                return Ok(Some(o));
            }
            (Some(o), None) => return Ok(Some(o)),
            (None, Some(l)) => return Ok(Some(l)),
            (None, None) => {}
        }
    }

    if let Some(fallback) = fallback_base_sha {
        // `cat-file -e` checks the object actually exists in the odb.
        if run_git(
            &["-C", repo_path, "cat-file", "-e", fallback],
            Some(Path::new(repo_path)),
        )
        .await
        .is_ok()
        {
            return Ok(Some(fallback.to_string()));
        }
    }

    Ok(None)
}

/// Summed insertions/deletions for the worktree sidebar's `+N -N` indicator.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DiffStat {
    pub insertions: u64,
    pub deletions: u64,
}

/// Parse `git diff --shortstat <baseSha>` output.
pub async fn get_diff_stat(repo_path: &str, base_sha: &str) -> GitResult<DiffStat> {
    let stdout = run_git(
        &["-C", repo_path, "diff", "--shortstat", base_sha],
        Some(Path::new(repo_path)),
    )
    .await?;
    Ok(parse_shortstat(&stdout))
}

fn parse_shortstat(stdout: &str) -> DiffStat {
    let insertions = capture_number(stdout, r"(\d+) insertions?\(\+\)");
    let deletions = capture_number(stdout, r"(\d+) deletions?\(-\)");
    DiffStat {
        insertions,
        deletions,
    }
}

fn capture_number(text: &str, pattern: &str) -> u64 {
    let re = regex::Regex::new(pattern).unwrap();
    re.captures(text)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<u64>().ok())
        .unwrap_or(0)
}

/// Add a git worktree with a new branch.
pub async fn worktree_add(
    repo_path: &str,
    worktree_path: &str,
    branch: &str,
    base_branch: &str,
) -> GitResult<()> {
    run_git(
        &[
            "-C",
            repo_path,
            "worktree",
            "add",
            "-b",
            branch,
            worktree_path,
            base_branch,
        ],
        Some(Path::new(repo_path)),
    )
    .await?;
    Ok(())
}

/// Remove a git worktree (`--force`).
pub async fn worktree_remove(repo_path: &str, worktree_path: &str) -> GitResult<()> {
    run_git(
        &[
            "-C",
            repo_path,
            "worktree",
            "remove",
            "--force",
            worktree_path,
        ],
        Some(Path::new(repo_path)),
    )
    .await?;
    Ok(())
}

/// Delete a local branch (`--force`).
pub async fn delete_branch(repo_path: &str, branch: &str) -> GitResult<()> {
    run_git(
        &["-C", repo_path, "branch", "-D", branch],
        Some(Path::new(repo_path)),
    )
    .await?;
    Ok(())
}

/// Initialize a new git repository in `dir`.
pub async fn git_init(dir: &str) -> GitResult<()> {
    run_git(&["init", dir], None).await?;
    Ok(())
}

/// Standard `.gitignore` content for new projects.
pub const DEFAULT_GITIGNORE: &str = ".DS_Store\nnode_modules/\n.env\n.env.local\n*.log\n";

/// Create a standard `.gitignore` file in `dir`.
pub async fn create_gitignore(dir: &str) -> GitResult<()> {
    tokio::fs::write(Path::new(dir).join(".gitignore"), DEFAULT_GITIGNORE).await?;
    Ok(())
}

/// One entry in the VCS commit timeline.
#[derive(Debug, Clone, PartialEq)]
pub struct CommitLogEntry {
    pub sha: String,
    pub short_sha: String,
    pub author_name: String,
    pub author_email: String,
    /// ISO 8601, author date.
    pub date: String,
    pub subject: String,
    /// Full raw commit message (subject + body), untrimmed of internal newlines.
    pub body: String,
    pub insertions: u64,
    pub deletions: u64,
    /// True if any changed file's diff couldn't be summarized as text.
    pub has_binary_changes: bool,
    /// True if reachable from HEAD but not from the `base_sha` passed in.
    pub is_on_branch: bool,
}

// Record separator (0x1e) delimits commits; unit separator (0x1f) delimits
// fields within one commit's header line.
const RS: char = '\u{1e}';
const US: char = '\u{1f}';

fn is_full_sha(s: &str) -> bool {
    s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// List commits reachable from HEAD, most recent first, each annotated with its
/// line-level diffstat versus its first parent. When `base_sha` is passed, each
/// commit is also annotated with `is_on_branch`.
pub async fn list_commits(
    repo_path: &str,
    limit: usize,
    base_sha: Option<&str>,
) -> GitResult<Vec<CommitLogEntry>> {
    let stdout = match run_git(
        &[
            "-C",
            repo_path,
            "log",
            &format!("-n{limit}"),
            "--diff-merges=first-parent",
            &format!("--pretty=format:{RS}%H{US}%h{US}%an{US}%ae{US}%aI{US}%s"),
            "--numstat",
        ],
        Some(Path::new(repo_path)),
    )
    .await
    {
        Ok(s) => s,
        // Empty repo (no commits yet) or not a git dir — treat as no history.
        Err(_) => return Ok(Vec::new()),
    };

    let mut commits: Vec<CommitLogEntry> = Vec::new();
    for block in stdout.split(RS).map(str::trim).filter(|b| !b.is_empty()) {
        let mut lines = block.split('\n');
        let header = lines.next().unwrap_or("").to_string();
        let fields: Vec<&str> = header.split(US).collect();
        let sha = fields.first().copied().unwrap_or("").to_string();
        if !is_full_sha(&sha) {
            continue;
        }
        let short_sha = fields.get(1).copied().unwrap_or("").to_string();
        let author_name = fields.get(2).copied().unwrap_or("").to_string();
        let author_email = fields.get(3).copied().unwrap_or("").to_string();
        let date = fields.get(4).copied().unwrap_or("").to_string();
        let subject = fields.get(5).copied().unwrap_or("").to_string();

        let mut insertions: u64 = 0;
        let mut deletions: u64 = 0;
        let mut has_binary_changes = false;
        for line in lines {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let mut parts = line.split('\t');
            let added = parts.next().unwrap_or("");
            let removed = parts.next().unwrap_or("");
            if added == "-" || removed == "-" {
                has_binary_changes = true;
                continue;
            }
            if let Ok(a) = added.parse::<u64>() {
                insertions += a;
            }
            if let Ok(r) = removed.parse::<u64>() {
                deletions += r;
            }
        }

        let short_sha = if short_sha.is_empty() {
            sha.chars().take(7).collect()
        } else {
            short_sha
        };

        commits.push(CommitLogEntry {
            sha,
            short_sha,
            author_name,
            author_email,
            date,
            subject: subject.clone(),
            body: subject,
            insertions,
            deletions,
            has_binary_changes,
            // Provisional; overwritten below once the base-branch SHA set is known.
            is_on_branch: true,
        });
    }

    if !commits.is_empty() {
        attach_full_bodies(repo_path, &mut commits).await;
    }

    if let Some(base_sha) = base_sha {
        if let Some(on_branch_shas) = list_shas_not_in(repo_path, base_sha).await {
            for commit in &mut commits {
                commit.is_on_branch = on_branch_shas.contains(&commit.sha);
            }
        }
        // On failure, leave every commit's provisional `is_on_branch: true`.
    }

    Ok(commits)
}

/// Per-path line-level diffstat from `git diff --numstat -z`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PathNumstat {
    /// `None` for a binary file (numstat reports `-`).
    pub insertions: Option<u64>,
    pub deletions: Option<u64>,
}

/// Parse `git diff --numstat -z` output into a map from path (new path for
/// renames/copies) to insertions/deletions.
pub fn parse_numstat_z(stdout: &str) -> HashMap<String, PathNumstat> {
    let mut result = HashMap::new();
    let tokens: Vec<&str> = stdout.split('\0').collect();
    let mut i = 0;
    while i < tokens.len() {
        let rec = tokens[i];
        if rec.is_empty() {
            i += 1;
            continue;
        }
        let first_tab = rec.find('\t');
        let Some(first_tab) = first_tab else {
            i += 1;
            continue;
        };
        let second_tab = rec[first_tab + 1..].find('\t').map(|x| x + first_tab + 1);
        let Some(second_tab) = second_tab else {
            i += 1;
            continue;
        };
        let added_str = &rec[..first_tab];
        let removed_str = &rec[first_tab + 1..second_tab];
        let inline_path = &rec[second_tab + 1..];

        let path: String;
        if inline_path.is_empty() {
            // Rename/copy: old and new paths follow as separate NUL-delimited
            // tokens; only the new path is kept.
            let new_path = tokens.get(i + 2).copied().unwrap_or("");
            i += 3;
            if new_path.is_empty() {
                continue;
            }
            path = new_path.to_string();
        } else {
            path = inline_path.to_string();
            i += 1;
        }

        if added_str == "-" || removed_str == "-" {
            result.insert(
                path,
                PathNumstat {
                    insertions: None,
                    deletions: None,
                },
            );
            continue;
        }
        let insertions = added_str.parse::<u64>().ok();
        let deletions = removed_str.parse::<u64>().ok();
        result.insert(
            path,
            PathNumstat {
                insertions,
                deletions,
            },
        );
    }
    result
}

/// Returns the set of full SHAs reachable from `HEAD` but not from `base_sha`,
/// or `None` on failure so callers can fail open.
async fn list_shas_not_in(repo_path: &str, base_sha: &str) -> Option<HashSet<String>> {
    // `--not` negates every ref that follows it, so `base_sha` must come after
    // HEAD — otherwise HEAD itself would be negated too.
    let stdout = run_git(
        &["-C", repo_path, "rev-list", "HEAD", "--not", base_sha],
        Some(Path::new(repo_path)),
    )
    .await
    .ok()?;
    let set: HashSet<String> = stdout
        .split('\n')
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    Some(set)
}

/// Fills in `body` (full raw commit message) for each entry, mutating in place.
/// Best-effort: on failure every commit keeps `body === subject`.
async fn attach_full_bodies(repo_path: &str, commits: &mut [CommitLogEntry]) {
    let stdout = match run_git(
        &[
            "-C",
            repo_path,
            "log",
            &format!("-n{}", commits.len()),
            &format!("--pretty=format:{RS}%H{US}%B"),
        ],
        Some(Path::new(repo_path)),
    )
    .await
    {
        Ok(s) => s,
        Err(_) => return,
    };

    let mut bodies: HashMap<String, String> = HashMap::new();
    for block in stdout.split(RS) {
        let Some(sep_idx) = block.find(US) else {
            continue;
        };
        let sha = &block[..sep_idx];
        let body = block[sep_idx + 1..].trim().to_string();
        if !sha.is_empty() {
            bodies.insert(sha.to_string(), body);
        }
    }

    for commit in commits.iter_mut() {
        if let Some(body) = bodies.get(&commit.sha) {
            commit.body = body.clone();
        }
    }
}

/// Check if git is available in PATH.
pub async fn is_git_available() -> bool {
    run_git(&["--version"], None).await.is_ok()
}

/// One top-level submodule entry.
#[derive(Debug, Clone, PartialEq)]
pub struct SubmoduleInfo {
    pub path: String,
    pub sha: Option<String>,
    pub short_sha: Option<String>,
    pub branch: Option<String>,
    pub subject: Option<String>,
    pub status: SubmoduleStatus,
}

/// A submodule's working-tree / pin state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubmoduleStatus {
    Clean,
    Modified,
    OutOfDate,
    Uninitialized,
}

/// Parse `.gitmodules`' `path`/`branch` pairs into `path -> branch`.
async fn parse_gitmodules_branches(repo_path: &str) -> HashMap<String, Option<String>> {
    let mut branch_by_path: HashMap<String, Option<String>> = HashMap::new();
    let text = match tokio::fs::read_to_string(Path::new(repo_path).join(".gitmodules")).await {
        Ok(t) => t,
        Err(_) => return branch_by_path,
    };

    let mut cur_path: Option<String> = None;
    let mut cur_branch: Option<String> = None;
    for raw in text.split('\n') {
        let line = raw.trim();
        if line.starts_with("[submodule") {
            if let Some(path) = cur_path.take() {
                branch_by_path.insert(path, cur_branch.take());
            }
            continue;
        }
        if let Some(eq) = line.find('=') {
            let key = line[..eq].trim();
            let value = line[eq + 1..].trim();
            if key == "path" {
                cur_path = Some(value.to_string());
            } else if key == "branch" {
                cur_branch = Some(value.to_string());
            }
        }
    }
    if let Some(path) = cur_path.take() {
        branch_by_path.insert(path, cur_branch.take());
    }
    branch_by_path
}

/// Parse one `git submodule status` line.
fn parse_submodule_status_line(line: &str) -> Option<(char, String, String)> {
    let line = line.trim_end();
    let bytes = line.as_bytes();
    if bytes.len() < 42 {
        return None;
    }
    let flag = line.chars().next()?;
    let sha = &line[1..41];
    if !is_full_sha(sha) {
        return None;
    }
    let rest = line[41..].trim();
    // `path (describe)` or bare `path` — the describe suffix is not needed.
    let path = rest
        .trim()
        .split(" (")
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    Some((flag, sha.to_string(), path))
}

/// Lists this repo's top-level submodules, joined with `git submodule status`.
pub async fn list_submodules(repo_path: &str) -> Vec<SubmoduleInfo> {
    let branch_by_path = parse_gitmodules_branches(repo_path).await;
    if branch_by_path.is_empty() {
        return Vec::new();
    }

    let stdout = match run_git_raw(
        &["-C", repo_path, "submodule", "status"],
        Some(Path::new(repo_path)),
    )
    .await
    {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let mut result: Vec<SubmoduleInfo> = Vec::new();
    for raw_line in stdout.split('\n') {
        let line = raw_line.trim_end();
        if line.trim().is_empty() {
            continue;
        }
        let Some((flag, sha, path)) = parse_submodule_status_line(line) else {
            continue;
        };
        let short_sha = sha.chars().take(7).collect::<String>();
        let branch = branch_by_path.get(&path).cloned().flatten();

        if flag == '-' {
            result.push(SubmoduleInfo {
                path,
                sha: Some(sha),
                short_sha: Some(short_sha),
                branch,
                subject: None,
                status: SubmoduleStatus::Uninitialized,
            });
            continue;
        }

        let submodule_path = Path::new(repo_path).join(&path);
        let subject = run_git(
            &[
                "-C",
                submodule_path.to_str().unwrap_or(""),
                "log",
                "-1",
                "--format=%s",
            ],
            Some(&submodule_path),
        )
        .await
        .ok()
        .filter(|s| !s.is_empty());

        let status = if flag == 'U' {
            SubmoduleStatus::Modified
        } else {
            // `+` means only "checked-out SHA differs from the pin"; a dirty
            // working tree at the pin gets flag `" "` and still needs the dirty
            // check.
            let mut dirty = false;
            if let Ok(porcelain) = run_git(
                &[
                    "-C",
                    submodule_path.to_str().unwrap_or(""),
                    "status",
                    "--porcelain",
                ],
                Some(&submodule_path),
            )
            .await
            {
                dirty = !porcelain.trim().is_empty();
            }
            if flag == '+' {
                SubmoduleStatus::OutOfDate
            } else if dirty {
                SubmoduleStatus::Modified
            } else {
                SubmoduleStatus::Clean
            }
        };

        result.push(SubmoduleInfo {
            path,
            sha: Some(sha),
            short_sha: Some(short_sha),
            branch,
            subject,
            status,
        });
    }
    result
}

// ---------------------------------------------------------------------------
// fetchOrigin — in-flight dedupe + success-only cooldown
// ---------------------------------------------------------------------------

/// Bounded timeout for `fetchOrigin`'s underlying call.
const FETCH_ORIGIN_TIMEOUT_MS: u64 = 8_000;
/// Cooldown after a successful `(repoPath, ref)` fetch.
const FETCH_ORIGIN_COOLDOWN_MS: u64 = 5_000;

/// A clock for [`GitService`]'s cooldown timestamps (injectable for tests).
pub type Clock = Arc<dyn Fn() -> SystemTime + Send + Sync>;

fn real_clock() -> Clock {
    Arc::new(SystemTime::now)
}

struct FetchState {
    in_flight: HashMap<String, Arc<Notify>>,
    cooldown_until: HashMap<String, SystemTime>,
}

/// A handle for stateful git operations. Currently owns `fetchOrigin`'s
/// in-flight-dedupe and cooldown maps.
#[derive(Clone)]
pub struct GitService(Arc<GitServiceInner>);

struct GitServiceInner {
    git_bin: String,
    now: Clock,
    state: std::sync::Mutex<FetchState>,
}

impl std::fmt::Debug for GitService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GitService").finish_non_exhaustive()
    }
}

impl GitService {
    /// A service running real `git` with the system clock.
    pub fn new() -> Self {
        Self::with_deps("git".to_string(), real_clock())
    }

    /// Test seam: a service pointed at a specific git binary and clock.
    #[doc(hidden)]
    pub fn with_deps(git_bin: String, now: Clock) -> Self {
        GitService(Arc::new(GitServiceInner {
            git_bin,
            now,
            state: std::sync::Mutex::new(FetchState {
                in_flight: HashMap::new(),
                cooldown_until: HashMap::new(),
            }),
        }))
    }

    /// Fetch a ref from origin (best-effort, swallows errors). Uses the default
    /// production timeout.
    pub async fn fetch_origin(&self, repo_path: &str, r#ref: &str) {
        self.fetch_origin_with_timeout(repo_path, r#ref, FETCH_ORIGIN_TIMEOUT_MS)
            .await;
    }

    /// Fetch a ref from origin with an explicit timeout. Best-effort — a
    /// failed fetch (no remote, network error, timeout) never blocks a
    /// subsequent real attempt.
    pub async fn fetch_origin_with_timeout(&self, repo_path: &str, r#ref: &str, timeout_ms: u64) {
        let key = format!("{repo_path}::{ref}");

        // Cooldown: resolve immediately if a successful fetch completed recently.
        {
            let state = self.0.state.lock().unwrap();
            if let Some(until) = state.cooldown_until.get(&key) {
                if *until > (self.0.now)() {
                    return;
                }
            }
        }

        // In-flight dedupe: concurrent callers share ONE underlying fetch. The
        // guard is dropped when this block ends — before any `.await` — so the
        // lock is never held across an await point.
        enum Decision {
            Wait(Arc<Notify>),
            Run(Arc<Notify>),
        }
        let decision = {
            let mut state = self.0.state.lock().unwrap();
            if let Some(existing) = state.in_flight.get(&key) {
                Decision::Wait(existing.clone())
            } else {
                let notify = Arc::new(Notify::new());
                state.in_flight.insert(key.clone(), notify.clone());
                Decision::Run(notify)
            }
        };

        let notify = match decision {
            Decision::Wait(notify) => {
                notify.notified().await;
                return;
            }
            Decision::Run(notify) => notify,
        };

        let success = self.run_fetch(repo_path, r#ref, timeout_ms).await;

        let mut state = self.0.state.lock().unwrap();
        state.in_flight.remove(&key);
        // Only stamp the cooldown on a SUCCESSFUL fetch — a failed fetch must
        // not block a subsequent real attempt within the window.
        if success {
            let now = (self.0.now)();
            state
                .cooldown_until
                .insert(key, now + Duration::from_millis(FETCH_ORIGIN_COOLDOWN_MS));
        }
        notify.notify_waiters();
    }

    async fn run_fetch(&self, repo_path: &str, r#ref: &str, timeout_ms: u64) -> bool {
        let mut cmd = Command::new(&self.0.git_bin);
        cmd.args(["-C", repo_path, "fetch", "origin", r#ref]);
        cmd.current_dir(repo_path);
        // Keep a remote that needs credentials from ever blocking on an
        // interactive prompt / SSH hang.
        cmd.env("GIT_TERMINAL_PROMPT", "0");
        cmd.env(
            "GIT_SSH_COMMAND",
            "ssh -o BatchMode=yes -o ConnectTimeout=5",
        );
        let fut = cmd.output();
        let out = tokio::time::timeout(Duration::from_millis(timeout_ms), fut).await;
        match out {
            Ok(Ok(output)) => output.status.success(),
            _ => false,
        }
    }

    /// Test-only: clears `fetchOrigin`'s in-flight-dedupe and cooldown maps.
    pub fn clear_fetch_origin_state_for_test(&self) {
        let mut state = self.0.state.lock().unwrap();
        state.in_flight.clear();
        state.cooldown_until.clear();
    }
}

impl Default for GitService {
    fn default() -> Self {
        Self::new()
    }
}
