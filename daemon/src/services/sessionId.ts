// @ts-nocheck
/**
 * Session and worktree identity reservation.
 * Mirrors AO's reserveNextSessionIdentity (ao:packages/core/src/session-manager.ts:790-828).
 */
import { existsSync } from "node:fs";
import type { ProjectRecord, SessionSlot, WorktreeRecord } from "../types.js";
import { worktreePath } from "./paths.js";

/**
 * Reserve the next free worktree number for a project.
 * Returns the smallest positive integer not already used by any worktree in the project,
 * AND whose worktree directory does not already exist on disk. The disk check guards
 * against orphans left by `vst worktree rm` (without --purge), which intentionally
 * removes from the manifest but keeps files and git registration.
 * MUST be called under the project mutex.
 */
export function reserveNextWorktreeNum(project: ProjectRecord): number {
  const usedNums = new Set(
    project.worktrees.map((wt) => {
      // wt.id is "<prefix>-<num>"
      const parts = wt.id.split("-");
      const last = parts[parts.length - 1];
      return parseInt(last ?? "0", 10);
    }),
  );

  for (let n = 1; n < 100_000; n++) {
    if (usedNums.has(n)) continue;
    const candidatePath = worktreePath(project.id, `${project.prefix}-${n}`);
    if (existsSync(candidatePath)) continue;
    return n;
  }
  throw new Error(`Could not reserve worktree number for project ${project.id}`);
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
