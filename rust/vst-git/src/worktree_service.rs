//! Ports `worktreeService.ts` — worktree creation service
//! (instant-draft-agent, Decision 2).
//!
//! Extracts the git-dir creation + `WorktreeRecord` insert from the inline body
//! of `POST /worktrees` so both that handler and draft promotion create a
//! worktree through one shared path. The helper does NOT create a session —
//! the caller supplies the sessions via `build_sessions`.

use vst_store::StoreHandle;
use vst_types::ProjectRecord;

use crate::branch_validator::{branch_exists_in_repo, validate_branch};
use crate::git::{rev_parse, worktree_add, GitError};
use crate::naming::slugify_prompt;
use crate::paths::Paths;
use crate::session_id::reserve_next_worktree_num;

/// Resolve a branch name for a new worktree: an explicit `branch` wins; else
/// derive a slug from `prompt`; else fall back to a `wip/<wtId>` placeholder.
pub async fn resolve_branch_for_create(
    repo_path: &str,
    prompt: Option<&str>,
    wt_id: &str,
) -> Result<(String, bool), GitError> {
    if let Some(prompt) = prompt {
        let slug = slugify_prompt(prompt);
        if !slug.is_empty() {
            let mut candidates = vec![slug.clone()];
            for i in 2..=21 {
                candidates.push(format!("{slug}-{i}"));
            }
            for candidate in candidates {
                if !validate_branch(&candidate).ok {
                    continue;
                }
                if !branch_exists_in_repo(repo_path, &candidate).await {
                    return Ok((candidate, false));
                }
            }
        }
    }

    let placeholder = format!("wip/{wt_id}");
    if !branch_exists_in_repo(repo_path, &placeholder).await {
        return Ok((placeholder, true));
    }
    for n in 2..1000 {
        let candidate = format!("{placeholder}-{n}");
        if !branch_exists_in_repo(repo_path, &candidate).await {
            return Ok((candidate, true));
        }
    }
    let timestamped = format!("{placeholder}-{}", now_ms());
    Ok((timestamped, true))
}

/// Builds the sessions that belong in a new worktree (the caller decides which).
pub type BuildSessions = Box<dyn Fn(&str) -> Vec<vst_types::SessionRecord> + Send>;

/// Options for [`create_worktree_record`].
pub struct CreateWorktreeOpts {
    pub project: ProjectRecord,
    pub branch: Option<String>,
    pub base_branch: String,
    pub prompt: Option<String>,
    pub name: Option<String>,
    pub build_sessions: BuildSessions,
}

/// Create a git worktree directory + persist its `WorktreeRecord` in the DB.
///
/// Reserves the worktree id (bumping `nextWorktreeNum`), resolves the branch,
/// captures `baseSha`, runs `git worktree add`, builds the record, and inserts
/// it into the project's `worktrees` array — all in one path. The caller
/// decides whether to roll back on failure.
pub async fn create_worktree_record(
    store: &StoreHandle,
    paths: &Paths,
    opts: CreateWorktreeOpts,
) -> Result<vst_types::WorktreeRecord, GitError> {
    let project_id = opts.project.id.clone();

    // Reserve + bump `nextWorktreeNum` atomically inside a single mutate.
    let wt_num = std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0));
    let wt_num_closure = wt_num.clone();
    let reserve_paths = paths.clone();
    let reserve_project_id = project_id.clone();
    let fresh_project = store
        .mutate_project(&project_id, move |p| {
            let n = reserve_next_worktree_num(p, &|wt_id| {
                reserve_paths
                    .worktree_path(&reserve_project_id, wt_id)
                    .exists()
            });
            wt_num_closure.store(n, std::sync::atomic::Ordering::SeqCst);
            p.next_worktree_num = Some(n + 1);
            Ok(p.clone())
        })
        .await
        .map_err(|e| GitError::Command {
            args: "mutate_project (reserve worktree num)".to_string(),
            stderr: e.to_string(),
        })?;
    let wt_num = wt_num.load(std::sync::atomic::Ordering::SeqCst);
    let wt_id = format!("{}-{}", fresh_project.prefix, wt_num);
    let wt_path = paths.worktree_path(&project_id, &wt_id);

    // Resolve the branch name now that `wtId` exists.
    let (branch, branch_is_placeholder) = match opts.branch {
        Some(branch) => (branch, false),
        None => {
            resolve_branch_for_create(&opts.project.absolute_path, opts.prompt.as_deref(), &wt_id)
                .await?
        }
    };

    // Capture baseSha before creating the worktree, then git worktree add.
    let base_sha = rev_parse(&opts.project.absolute_path, &opts.base_branch).await?;
    worktree_add(
        &opts.project.absolute_path,
        &wt_path.to_string_lossy(),
        &branch,
        &opts.base_branch,
    )
    .await?;

    let sessions = (opts.build_sessions)(&wt_id);

    let worktree_record = vst_types::WorktreeRecord {
        id: wt_id,
        name: opts.name,
        branch,
        branch_is_placeholder: branch_is_placeholder.then_some(true),
        base_branch: opts.base_branch,
        base_sha,
        created_at: now_iso(),
        pinned_at: None,
        hidden_at: None,
        sort_order: now_ms() as f64,
        terminal_seq: Some(0),
        agent_seq: Some(0),
        sessions,
    };

    // Persist to manifest (structural change — immediate write).
    let record_for_insert = worktree_record.clone();
    store
        .mutate_project(&project_id, move |p| {
            p.worktrees.push(record_for_insert.clone());
            Ok(p.clone())
        })
        .await
        .map_err(|e| GitError::Command {
            args: "mutate_project (insert worktree)".to_string(),
            stderr: e.to_string(),
        })?;

    Ok(worktree_record)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn now_iso() -> String {
    let now = std::time::SystemTime::now();
    let secs = now
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // ISO8601 in UTC (second precision).
    format_iso(secs)
}

fn format_iso(unix_secs: i64) -> String {
    let days = unix_secs.div_euclid(86_400);
    let rem = unix_secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let hh = rem / 3600;
    let mm = (rem % 3600) / 60;
    let ss = rem % 60;
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.000Z")
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}
