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
 * Highest agent slot number ever assigned in a worktree — the monotonic
 * high-water mark for `a{n}` slots.
 *
 * Returns `max(worktree.agentSeq ?? 0, ...current agent slot numbers)`. Taking
 * the max of BOTH the persisted counter and the live slots (rather than trusting
 * `agentSeq` alone) matters for two cases:
 *   - Legacy worktrees whose agents predate `agentSeq`: the counter is unset, so
 *     the live slots supply the mark.
 *   - A stale/hand-edited counter lower than a live slot: the live slots win, so
 *     we never hand out a colliding, already-in-use number.
 * The `Number.isFinite` filter is REQUIRED so a non-numeric slot can't poison
 * the result to NaN.
 *
 * Callers persist this (or `+1`) back to `agentSeq` so the mark survives even
 * after every agent is deleted.
 */
export function agentHighWaterMark(worktree: WorktreeRecord): number {
  const existing = worktree.sessions
    .filter((s) => typeof s.slot === "string" && (s.slot as string).startsWith("a"))
    .map((s) => parseInt((s.slot as string).slice(1), 10))
    .filter(Number.isFinite);
  return Math.max(worktree.agentSeq ?? 0, 0, ...existing);
}

/**
 * Reserve the next agent slot (a{n}) for a worktree — monotonic, never reused.
 * Returns one past the high-water mark; a deleted agent's number is never
 * recycled.
 *
 * Pure: the caller MUST persist the returned number as `agentSeq` in the same
 * `mutateProject` update that appends the session record.
 */
export function reserveNextAgentSlot(worktree: WorktreeRecord): `a${number}` {
  const n = agentHighWaterMark(worktree) + 1;
  return `a${n}`;
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
 * Reserve the next free direct session slot number (d{n}) for a project.
 * Direct sessions run in the project directory without worktree isolation.
 */
export function reserveNextDirectSlot(project: ProjectRecord): `d${number}` {
  const usedNums = new Set(
    project.directSessions
      .filter((s) => typeof s.slot === "string" && (s.slot as string).startsWith("d"))
      .map((s) => parseInt((s.slot as string).slice(1), 10)),
  );
  for (let n = 1; n < 100_000; n++) {
    if (!usedNums.has(n)) return `d${n}`;
  }
  throw new Error(`Could not reserve direct slot for project ${project.id}`);
}

/**
 * Build the canonical tmux session name.
 * Format: vr-{prefix}-{worktreeNum}-{slot}
 * e.g. vr-vibe-1-m
 */
export function buildTmuxName(prefix: string, worktreeNum: number, slot: SessionSlot): string {
  return `vr-${prefix}-${worktreeNum}-${slot}`;
}

/**
 * Build tmux session name for direct sessions (no worktree).
 * Format: vr-{prefix}-d{n}
 * e.g. vr-vibe-d1
 */
export function buildDirectTmuxName(prefix: string, slot: `d${number}`): string {
  return `vr-${prefix}-${slot}`;
}
