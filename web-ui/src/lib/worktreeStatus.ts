import type { Session, SessionState } from "@/api/types";

export type WorktreeRolledUpStatus =
  | "waiting_for_human"
  | "working"
  | "spawning"
  | "idle"
  | "done"
  | "exited"
  | "none";

// PRD R8 precedence: waiting_for_human outranks working — one session
// actively blocking on a human dominates the whole worktree's displayed
// status. PR outcome is a separate axis layered on top by
// `statusColor.ts#resolveStatusClass`, not part of this lifecycle rank.
const rank: Record<WorktreeRolledUpStatus, number> = {
  waiting_for_human: 8,
  working: 6,
  spawning: 5,
  idle: 4,
  done: 3,
  exited: 2,
  none: 1,
};

/**
 * Single-session status — the per-session equivalent of `worktreeRolledUpStatus`'s
 * inner mapping, same color scheme. Shared by `WorkspaceCanvas.tsx` (tile chrome)
 * and `AgentPaneSlot.tsx` (direct-session chrome) so both surfaces use one source
 * of truth for "what color does this session's state map to."
 */
export function sessionStatus(state: SessionState): WorktreeRolledUpStatus {
  switch (state) {
    case "not_started":
      return "spawning";
    case "working":
      return "working";
    case "idle":
      return "idle";
    case "waiting_for_human":
      return "waiting_for_human";
    case "done":
      return "done";
    case "exited":
      return "exited";
    default:
      return "none";
  }
}

/**
 * Single status for a worktree row: working > spawning (not_started) > idle > done > exited > none.
 *
 * Only agent sessions contribute. Terminal sessions don't have user-meaningful
 * lifecycle states — including them lets a transiently-idle terminal dominate
 * a fully-done worktree (idle outranks done in the rollup).
 */
export function worktreeRolledUpStatus(
  sessions: Session[],
  live: Record<string, SessionState>,
): WorktreeRolledUpStatus {
  const agents = sessions.filter((s) => s.type === "agent");
  if (agents.length === 0) return "none";

  let best: WorktreeRolledUpStatus = "none";
  let bestRank = 0;

  for (const s of agents) {
    const st = live[s.id] ?? s.state;
    let step: WorktreeRolledUpStatus;
    if (st === "not_started") step = "spawning";
    else if (st === "working") step = "working";
    else if (st === "idle") step = "idle";
    else if (st === "waiting_for_human") step = "waiting_for_human";
    else if (st === "done") step = "done";
    else if (st === "exited") step = "exited";
    else step = "none";

    const r = rank[step];
    if (r > bestRank) {
      bestRank = r;
      best = step;
    }
  }

  return best;
}
