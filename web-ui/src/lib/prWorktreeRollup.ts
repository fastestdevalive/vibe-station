import type { Session, Worktree } from "@/api/types";

export interface PrWorktreeGroup {
  worktree: Worktree;
  /** Only the sessions from the input that put this worktree in the PR
   *  bucket — NOT every session in the worktree (found in review: a
   *  `working` sibling not in this group must not win the group's status). */
  sessions: Session[];
}

/**
 * Group Session[] already known to be in the PR bucket by worktree — one
 * entry per branch, in first-seen order. `bucketForRollup` already proved
 * each session's worktree has an open/merged PR; this collapses siblings on
 * the same worktree into a single group instead of one row per session,
 * while keeping the group's own sessions (not the worktree's full session
 * list) so a caller can pick a representative status from sessions that
 * actually belong in this bucket.
 */
export function rollupPrSessionsByWorktree(
  sessions: Session[],
  worktreeById: Map<string, Worktree>,
): PrWorktreeGroup[] {
  // Map preserves insertion order, so first-seen worktree order falls out
  // of iteration order below with no separate index bookkeeping.
  const groups = new Map<string, PrWorktreeGroup>();
  for (const s of sessions) {
    const wt = s.worktreeId ? worktreeById.get(s.worktreeId) : undefined;
    if (!wt) continue;
    const existing = groups.get(wt.id);
    if (existing) {
      existing.sessions.push(s);
    } else {
      groups.set(wt.id, { worktree: wt, sessions: [s] });
    }
  }
  return Array.from(groups.values());
}
