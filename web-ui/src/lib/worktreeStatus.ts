import type { Session, SessionState } from "@/api/types";
import {
  excludeSuperseded,
  isSupersededSession,
  predecessorChain,
  predecessorIndex,
} from "@/lib/sessionVisibility";
import { sessionLabel } from "@/lib/sessionLabel";

export type WorktreeRolledUpStatus =
  | "waiting_for_human"
  | "working"
  | "spawning"
  | "idle"
  | "done"
  | "exited"
  | "none";

// Precedence: working outranks waiting_for_human — if any agent in the
// worktree is actively running, the worktree should show as working, not
// waiting. A single blocked agent shouldn't mask another that is still
// making progress. PR outcome is a separate axis layered on top by
// `statusColor.ts#resolveStatusClass`, not part of this lifecycle rank.
const rank: Record<WorktreeRolledUpStatus, number> = {
  working: 8,
  waiting_for_human: 6,
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
    case "drafting":
      return "none";
    default:
      return "none";
  }
}

/**
 * True when a worktree should be hidden by the sidebar's "Hide done" filter:
 * it has no agent sessions at all, or every agent session is explicitly `done`.
 *
 * `exited` deliberately does NOT count as done: it is involuntary (agent
 * crashed, tmux pane died, tmux server lost on reboot), and after a restart
 * every session lands there — folding it in hid all previously-active
 * worktrees behind a filter labelled "done".
 */
export function worktreeIsInactive(
  sessions: Session[],
  live: Record<string, SessionState>,
): boolean {
  const agents = excludeSuperseded(sessions).filter((s) => s.type === "agent");
  if (agents.length === 0) return true;
  return agents.every((s) => (live[s.id] ?? s.state) === "done");
}

/**
 * Single status for a worktree row: working > spawning (not_started) > idle > done > exited > none.
 *
 * Only agent sessions contribute. Terminal sessions don't have user-meaningful
 * lifecycle states — including them lets a transiently-idle terminal dominate
 * a fully-done worktree (idle outranks done in the rollup).
 *
 * Superseded sessions (reset replaced them, replacement present in `sessions`)
 * are hidden everywhere, so they contribute nothing; a dangling `supersededBy`
 * still counts.
 */
export function worktreeRolledUpStatus(
  sessions: Session[],
  live: Record<string, SessionState>,
): WorktreeRolledUpStatus {
  return worktreeRolledUpStatusDetail(sessions, live).status;
}

/** The rolled-up status plus the agents that produce it. */
export interface RolledUpStatusDetail {
  status: WorktreeRolledUpStatus;
  /** The agents whose own status equals `status`, in input order. */
  drivers: Session[];
}

/**
 * The one rollup loop: `worktreeRolledUpStatus` is this function's `.status`.
 * `drivers` are the agents behind the dot (e.g. for the "working: a, b"
 * tooltip) — the same agents, same filter, same live-state resolution, so the
 * tooltip can never name a session the dot did not count.
 */
export function worktreeRolledUpStatusDetail(
  sessions: Session[],
  live: Record<string, SessionState>,
): RolledUpStatusDetail {
  const agents = excludeSuperseded(sessions).filter((s) => s.type === "agent");

  let best: WorktreeRolledUpStatus = "none";
  let bestRank = 0;
  let drivers: Session[] = [];

  for (const s of agents) {
    const step = sessionStatus(live[s.id] ?? s.state);
    const r = rank[step];
    if (r > bestRank) {
      bestRank = r;
      best = step;
      drivers = [s];
    } else if (r === bestRank && r > 0) {
      drivers.push(s);
    }
  }

  return { status: best, drivers };
}

/**
 * Tooltip detail naming the agents that make a rollup `working`, up to two
 * names then "+N": `"a, b +2"`. `undefined` for any other status — only
 * `working` names its agents (a PR colour can mask `waiting_for_human`, so
 * naming waiting agents on a blue dot would mislead). Desktop-only affordance
 * (a `title`); phones get the SubagentRow "working below" badge instead.
 */
export function workingDriversDetail(detail: RolledUpStatusDetail): string | undefined {
  if (detail.status !== "working" || detail.drivers.length === 0) return undefined;
  const names = detail.drivers.map(sessionLabel);
  const shown = names.slice(0, 2).join(", ");
  return names.length > 2 ? `${shown} +${names.length - 2}` : shown;
}

/**
 * Parent→children index over the WHOLE session list, built once per list
 * (callers memoise it on the server store's `sessions`) so the per-render
 * descendant walk never re-scans the list.
 */
export interface DescendantIndex {
  byId: Map<string, Session>;
  /** `parentSessionId` → sessions carrying it (any type/state). */
  childrenByParent: Map<string, Session[]>;
  /** successor id → the session it superseded (`predecessorIndex`). */
  predecessorOf: Map<string, Session>;
}

export function buildDescendantIndex(sessions: Session[]): DescendantIndex {
  const byId = new Map<string, Session>();
  const childrenByParent = new Map<string, Session[]>();
  for (const s of sessions) {
    byId.set(s.id, s);
    if (s.parentSessionId) {
      const list = childrenByParent.get(s.parentSessionId);
      if (list) list.push(s);
      else childrenByParent.set(s.parentSessionId, [s]);
    }
  }
  return { byId, childrenByParent, predecessorOf: predecessorIndex(sessions) };
}

/**
 * Every descendant agent of `root` that the worktree rollup would also count:
 * same filter as `worktreeRolledUpStatusDetail` (agents only, superseded rows
 * dropped unless their replacement is gone, archived rows KEPT — the rollup
 * counts them too) plus same scope as the dot (same worktree; for direct
 * sessions, same project). Children of a reset session still carry the
 * archived predecessor's id, so each node is expanded through its whole
 * `predecessorChain` (the walk `ancestorIds` uses). No depth limit — the dot
 * counts every depth; `seen` guards against parent cycles.
 * Excludes `root` itself; order is breadth-first.
 */
export function descendantAgents(root: Session, index: DescendantIndex): Session[] {
  const out: Session[] = [];
  const seen = new Set<string>([root.id]);
  const inScope = (s: Session) =>
    s.worktreeId === root.worktreeId && (root.worktreeId != null || s.projectId === root.projectId);
  let frontier: Session[] = [root];
  while (frontier.length > 0) {
    const next: Session[] = [];
    for (const node of frontier) {
      // Children of a reset node point at one of its predecessors.
      for (const key of predecessorChain(node, index.predecessorOf)) {
        for (const child of index.childrenByParent.get(key.id) ?? []) {
          if (seen.has(child.id)) continue;
          seen.add(child.id);
          if (child.type !== "agent" || !inScope(child) || isSupersededSession(child, index.byId)) {
            continue;
          }
          out.push(child);
          next.push(child);
        }
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * The working agents under `root` (see `descendantAgents`), live state via
 * `live[id] ?? s.state`, most recently active first (ties by id) so "open the
 * working one" is deterministic.
 */
export function workingDescendants(
  root: Session,
  index: DescendantIndex,
  live: Record<string, SessionState>,
): Session[] {
  const activity = (s: Session) => {
    const t = s.lastActivityAt ? Date.parse(s.lastActivityAt) : NaN;
    return Number.isNaN(t) ? -Infinity : t;
  };
  return descendantAgents(root, index)
    .filter((s) => (live[s.id] ?? s.state) === "working")
    .sort((a, b) => activity(b) - activity(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
