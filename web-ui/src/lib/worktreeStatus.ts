import type { Session, SessionState } from "@/api/types";

export type WorktreeRolledUpStatus =
  | "working"
  | "spawning"
  | "idle"
  | "done"
  | "exited"
  | "none";

const rank: Record<WorktreeRolledUpStatus, number> = {
  working: 6,
  spawning: 5,
  idle: 4,
  done: 3,
  exited: 2,
  none: 1,
};

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
