/**
 * Session and worktree identity.
 *
 * `slot` is deliberately NOT a concept here anymore (see the sqlite-agent-naming
 * data-layer plan, Decision 1): a session `id` is generated independently of
 * any position/type-count, so a respawned session (e.g. a reset) can never
 * collide with the row it replaced — the root cause of the old tmux-collision
 * risk (`id = \`${worktreeId}-${slot}\`` reused a slot string across a
 * delete+recreate cycle).
 */
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { ProjectRecord, WorktreeRecord } from "../types.js";
import { worktreePath } from "./paths.js";

/** Extract the trailing "-<num>" from a worktree id (e.g. "vs-3" -> 3). May be NaN. */
function numOf(wt: WorktreeRecord): number {
  const parts = wt.id.split("-");
  const last = parts[parts.length - 1];
  return parseInt(last ?? "", 10);
}

/**
 * Reserve the next worktree number for a project — monotonic, never reused.
 *
 * Uses the persisted high-water counter `project.nextWorktreeNum`. For legacy
 * manifests written before that field existed, it's lazily seeded from
 * `max(existing worktree nums) + 1` (the `Number.isFinite` filter is required:
 * a worktree id whose trailing segment isn't numeric parses to NaN, and
 * `Math.max(0, NaN)` is NaN, which would poison the counter permanently).
 *
 * The `existsSync` check is a paranoia guard against stray on-disk directories
 * left by non-purge deletes (`vst worktree rm` without `--purge`) — mostly moot
 * once the counter is persisted, but cheap to keep.
 *
 * This function is pure (it doesn't mutate or persist anything) — callers MUST
 * run it inside a `mutateProject` callback and write the returned value + 1 back
 * to `nextWorktreeNum` as part of that same atomic update, so the reservation
 * and the counter bump land together.
 */
export function reserveNextWorktreeNum(project: ProjectRecord): number {
  const nums = project.worktrees.map(numOf).filter(Number.isFinite);
  const seed = Math.max(0, ...nums) + 1;
  let n = project.nextWorktreeNum ?? seed;
  // paranoia guard: never land on a stray on-disk dir (old non-purge orphans)
  while (existsSync(worktreePath(project.id, `${project.prefix}-${n}`))) n++;
  return n;
}

/**
 * Generate an independently-unique session id (Decision 1). `scopeId` is the
 * worktree id for a worktree-scoped session, or the project id for a direct
 * session — kept as a prefix purely so ids stay greppable/debuggable, NOT for
 * uniqueness (the random suffix alone guarantees that). Every call produces a
 * fresh id, so a session created to replace another (e.g. `POST
 * /sessions/:id/reset`) never collides with the row it replaces.
 */
export function generateSessionId(scopeId: string, type: "agent" | "terminal"): string {
  const suffix = randomBytes(4).toString("hex"); // 8 hex chars — plenty for per-scope uniqueness
  return `${scopeId}-${type[0]}-${suffix}`;
}

/** Canonical tmux session name for a NEW session — derived from its id, not a slot. */
export function tmuxNameForSession(id: string): string {
  return `vst-${id}`;
}
