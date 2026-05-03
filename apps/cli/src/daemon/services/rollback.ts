/**
 * Rollback helpers for worktree creation failure.
 * Implements the rollback sequence from HIGH-LEVEL-DESIGN.md §5.
 */
import { killSession } from "./tmux.js";
import { directPtyRegistry } from "../state/directPtyRegistry.js";
import { worktreeRemove, deleteBranch } from "./git.js";
import { worktreePath as getWorktreePath } from "./paths.js";
import type { ProjectRecord, WorktreeRecord } from "../types.js";

/**
 * Roll back a failed worktree + session creation.
 * Steps (best-effort, each step logged on failure):
 * 1. Kill tmux session (if any)
 * 2. git worktree remove --force
 * 3. git branch -D (if branch was freshly created)
 * 4. Remove worktree record from manifest (caller must persist)
 *
 * @returns Array of error messages for any steps that failed (empty = clean rollback)
 */
export async function rollbackWorktreeCreate(
  project: ProjectRecord,
  worktree: WorktreeRecord,
): Promise<string[]> {
  const errors: string[] = [];

  // 1. Kill sessions (tmux or direct-pty)
  for (const session of worktree.sessions) {
    if (!session.useTmux) {
      // Direct-pty: kill via registry stream (public kill() method).
      directPtyRegistry.get(session.id)?.kill?.();
    } else {
      try {
        await killSession(session.tmuxName);
      } catch (err) {
        errors.push(`tmux kill-session '${session.tmuxName}': ${String(err)}`);
      }
    }
  }

  // 2. Remove git worktree
  const wtPath = getWorktreePath(project.id, worktree.id);
  try {
    await worktreeRemove(project.absolutePath, wtPath);
  } catch (err) {
    errors.push(`git worktree remove '${wtPath}': ${String(err)}`);
  }

  // 3. Delete the branch
  try {
    await deleteBranch(project.absolutePath, worktree.branch);
  } catch (err) {
    errors.push(`git branch -D '${worktree.branch}': ${String(err)}`);
  }

  return errors;
}
