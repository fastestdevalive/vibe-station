import { describe, expect, it } from "vitest";
import type { Session, Worktree } from "@/api/types";
import { rollupPrSessionsByWorktree } from "./prWorktreeRollup";

function makeWorktree(id: string, branch: string): Worktree {
  return {
    id,
    projectId: "proj-1",
    branch,
    baseBranch: "main",
    baseSha: "sha-1",
    createdAt: new Date(0).toISOString(),
    pinnedAt: null,
    hiddenAt: null,
    mainSessionId: `${id}-main`,
    lspEnabled: false,
  };
}

function makeSession(id: string, worktreeId: string | null): Session {
  return {
    id,
    worktreeId,
    projectId: "proj-1",
    modeId: "mode-1",
    type: "agent",
    isMain: false,
    state: "idle",
    lifecycleState: "idle",
    tmuxName: id,
    createdAt: new Date(0).toISOString(),
  };
}

describe("3.T2 — rollupPrSessionsByWorktree", () => {
  it("groups sessions sharing a worktree under one entry, keeping only that worktree's own pr-bucket sessions", () => {
    const wt1 = makeWorktree("wt-1", "feature-a");
    const wtById = new Map<string, Worktree>([["wt-1", wt1]]);
    const s1 = makeSession("s1", "wt-1");
    const s2 = makeSession("s2", "wt-1");
    const s3 = makeSession("s3", "wt-1");

    const result = rollupPrSessionsByWorktree([s1, s2, s3], wtById);
    expect(result).toEqual([{ worktree: wt1, sessions: [s1, s2, s3] }]);
  });

  it("preserves first-seen order", () => {
    const wt1 = makeWorktree("wt-1", "feature-1");
    const wt2 = makeWorktree("wt-2", "feature-2");
    const wt3 = makeWorktree("wt-3", "feature-3");
    const wtById = new Map<string, Worktree>([
      ["wt-1", wt1],
      ["wt-2", wt2],
      ["wt-3", wt3],
    ]);
    const s21 = makeSession("s2-1", "wt-2");
    const s11 = makeSession("s1-1", "wt-1");
    const s22 = makeSession("s2-2", "wt-2");
    const s31 = makeSession("s3-1", "wt-3");
    const s12 = makeSession("s1-2", "wt-1");

    const result = rollupPrSessionsByWorktree([s21, s11, s22, s31, s12], wtById);
    expect(result).toEqual([
      { worktree: wt2, sessions: [s21, s22] },
      { worktree: wt1, sessions: [s11, s12] },
      { worktree: wt3, sessions: [s31] },
    ]);
  });

  it("drops sessions with no resolvable worktree", () => {
    const wt1 = makeWorktree("wt-1", "feature-1");
    const wtById = new Map<string, Worktree>([["wt-1", wt1]]);
    const s1 = makeSession("s1", "wt-1");
    const sessions = [
      makeSession("s-direct", null),
      makeSession("s-unknown", "wt-missing"),
      s1,
    ];

    const result = rollupPrSessionsByWorktree(sessions, wtById);
    expect(result).toEqual([{ worktree: wt1, sessions: [s1] }]);
  });

  it("does not include a sibling session that isn't in the input (e.g. a working session not in the pr bucket)", () => {
    // Regression for the review finding: the caller must not re-derive a
    // worktree's "all sessions" list from this result — only sessions that
    // actually justified the pr-bucket membership are here.
    const wt1 = makeWorktree("wt-1", "feature-1");
    const wtById = new Map<string, Worktree>([["wt-1", wt1]]);
    const idleSessionInPrBucket = makeSession("s-idle", "wt-1");

    const result = rollupPrSessionsByWorktree([idleSessionInPrBucket], wtById);
    expect(result).toEqual([{ worktree: wt1, sessions: [idleSessionInPrBucket] }]);
  });
});
