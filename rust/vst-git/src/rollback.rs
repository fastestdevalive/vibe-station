//! Ports `rollback.ts` — rollback helpers for worktree creation failure
//! (HIGH-LEVEL-DESIGN.md §5).

use vst_proc::Tmux;
use vst_types::{ProjectRecord, WorktreeRecord};

use crate::direct_pty::DirectPtyRegistry;
use crate::git::{delete_branch, worktree_remove};
use crate::paths::Paths;

/// Roll back a failed worktree + session creation.
///
/// Steps (best-effort, each step's failure recorded):
/// 1. Kill tmux session (or direct-pty stream) for each session
/// 2. `git worktree remove --force`
/// 3. `git branch -D` (if the branch was freshly created)
///
/// Returns a list of error messages for any steps that failed (empty = clean).
pub async fn rollback_worktree_create(
    project: &ProjectRecord,
    worktree: &WorktreeRecord,
    tmux: &Tmux,
    direct_pty: &DirectPtyRegistry,
    paths: &Paths,
) -> Vec<String> {
    let mut errors: Vec<String> = Vec::new();

    // 1. Kill sessions (tmux or direct-pty)
    for session in &worktree.sessions {
        if !session.use_tmux {
            if let Some(kill) = direct_pty.get(&session.id) {
                kill.kill();
            }
        } else {
            tmux.kill_session(&session.tmux_name);
        }
    }

    // 2. Remove git worktree
    let wt_path = paths.worktree_path(&project.id, &worktree.id);
    if let Err(e) = worktree_remove(&project.absolute_path, &wt_path.to_string_lossy()).await {
        errors.push(format!("git worktree remove '{}': {e}", wt_path.display()));
    }

    // 3. Delete the branch
    if let Err(e) = delete_branch(&project.absolute_path, &worktree.branch).await {
        errors.push(format!("git branch -D '{}': {e}", worktree.branch));
    }

    errors
}
