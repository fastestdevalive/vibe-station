/**
 * Session and worktree identity reservation.
 * Mirrors AO's reserveNextSessionIdentity (ao:packages/core/src/session-manager.ts:790-828).
 */
import { existsSync } from "node:fs";
import type { ProjectRecord, SessionSlot, WorktreeRecord } from "../types.js";
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
 * Reserve the next free agent slot number (a{n}) for a worktree.
 */
export function reserveNextAgentSlot(worktree: WorktreeRecord): `a${number}` {
  const usedNums = new Set(
    worktree.sessions
      .filter((s) => typeof s.slot === "string" && (s.slot as string).startsWith("a"))
      .map((s) => parseInt((s.slot as string).slice(1), 10)),
  );
  for (let n = 1; n < 100_000; n++) {
    if (!usedNums.has(n)) return `a${n}`;
  }
  throw new Error(`Could not reserve agent slot for worktree ${worktree.id}`);
}

/**
 * Reserve the next free terminal slot number (t{n}) for a worktree.
 */
export function reserveNextTerminalSlot(worktree: WorktreeRecord): `t${number}` {
  const usedNums = new Set(
    worktree.sessions
      .filter((s) => typeof s.slot === "string" && (s.slot as string).startsWith("t"))
      .map((s) => parseInt((s.slot as string).slice(1), 10)),
  );
  for (let n = 1; n < 100_000; n++) {
    if (!usedNums.has(n)) return `t${n}`;
  }
  throw new Error(`Could not reserve terminal slot for worktree ${worktree.id}`);
}

/**
 * Build the canonical tmux session name.
 * Format: vr-{prefix}-{worktreeNum}-{slot}
 * e.g. vr-vibe-1-m
 */
export function buildTmuxName(prefix: string, worktreeNum: number, slot: SessionSlot): string {
  return `vr-${prefix}-${worktreeNum}-${slot}`;
}
