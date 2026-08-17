import { describe, it, expect } from "vitest";
import { resolveStatusClass, worktreePrStatus } from "./statusColor";
import type { PrStatus, Session } from "@/api/types";

function pr(state: PrStatus["state"], prBranch = "feature-x"): PrStatus {
  return { state, checkedAt: "2026-08-16T00:00:00.000Z", prBranch };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    worktreeId: "wt-1",
    projectId: "p1",
    modeId: null,
    type: "agent",
    isMain: false,
    state: "idle",
    lifecycleState: "idle",
    tmuxName: "t1",
    createdAt: "2026-08-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("resolveStatusClass (D17/D18)", () => {
  it("5.T1 — working beats pr=open (active work is the freshest signal)", () => {
    expect(resolveStatusClass("working", pr("open"))).toBe("working");
  });

  it("5.T1 — waiting_for_human + pr=open resolves to pr-open (D18 inverts the old R7 rule)", () => {
    expect(resolveStatusClass("waiting_for_human", pr("open"))).toBe("pr-open");
  });

  it("5.T1 — idle + pr=open resolves to pr-open", () => {
    expect(resolveStatusClass("idle", pr("open"))).toBe("pr-open");
  });

  it("D21 — done INHERITS the PR colour (bucket stays finished, colour does not)", () => {
    expect(resolveStatusClass("done", pr("merged"))).toBe("pr-merged");
    expect(resolveStatusClass("done", pr("open"))).toBe("pr-open");
  });

  it("D21 — done with no landed PR is neutral (draft/closed/none never colour)", () => {
    expect(resolveStatusClass("done", null)).toBeNull();
    expect(resolveStatusClass("done", pr("draft"))).toBeNull();
    expect(resolveStatusClass("done", pr("closed"))).toBeNull();
    expect(resolveStatusClass("done", pr("none"))).toBeNull();
  });

  it("5.T1 — waiting_for_human with no PR still resolves to waiting_for_human", () => {
    expect(resolveStatusClass("waiting_for_human", null)).toBe("waiting_for_human");
  });

  it("pr=merged wins over idle/waiting_for_human but never over working", () => {
    expect(resolveStatusClass("idle", pr("merged"))).toBe("pr-merged");
    expect(resolveStatusClass("waiting_for_human", pr("merged"))).toBe("pr-merged");
    expect(resolveStatusClass("working", pr("merged"))).toBe("working");
  });

  it("D21 — exited inherits the PR colour too; keeps its literal class only when there's no PR (dimming cue)", () => {
    expect(resolveStatusClass("exited", pr("merged"))).toBe("pr-merged");
    expect(resolveStatusClass("exited", pr("open"))).toBe("pr-open");
    expect(resolveStatusClass("exited", pr("draft"))).toBe("exited");
    expect(resolveStatusClass("exited", null)).toBe("exited");
  });

  it("pr=draft and pr=closed never drive the border", () => {
    expect(resolveStatusClass("idle", pr("draft"))).toBe("idle");
    expect(resolveStatusClass("idle", pr("closed"))).toBe("idle");
  });

  it("falls back to lifecycle status when pr is none/null", () => {
    expect(resolveStatusClass("working", pr("none"))).toBe("working");
    expect(resolveStatusClass("idle", null)).toBe("idle");
  });

  it("returns null when lifecycle is none and there is no PR", () => {
    expect(resolveStatusClass("none", null)).toBeNull();
    expect(resolveStatusClass("none", pr("draft"))).toBeNull();
  });

  it("B2 — spawning wins over any PR, staying neutral + dashed (a not-yet-started session isn't 'landed')", () => {
    expect(resolveStatusClass("spawning", pr("merged"))).toBe("spawning");
    expect(resolveStatusClass("spawning", pr("open"))).toBe("spawning");
    expect(resolveStatusClass("spawning", null)).toBe("spawning");
  });
});

describe("worktreePrStatus (D20 — branch-keyed)", () => {
  it("5.T2 — returns null when prBranch does not match the current branch", () => {
    const sessions = [session({ id: "s1", isMain: true, pr: pr("open", "old-branch") })];
    expect(worktreePrStatus(sessions, "new-branch")).toBeNull();
  });

  it("5.T2 — returns the status when prBranch matches the current branch", () => {
    const sessions = [session({ id: "s1", isMain: true, pr: pr("open", "feature-x") })];
    expect(worktreePrStatus(sessions, "feature-x")).toEqual(pr("open", "feature-x"));
  });

  it("returns the isMain session's pr, not a non-main sibling's", () => {
    const sessions = [
      session({ id: "s1", isMain: false, pr: pr("draft", "feature-x") }),
      session({ id: "s2", isMain: true, pr: pr("open", "feature-x") }),
    ];
    expect(worktreePrStatus(sessions, "feature-x")).toEqual(pr("open", "feature-x"));
  });

  it("returns null when there is no main session", () => {
    const sessions = [session({ id: "s1", isMain: false, pr: pr("open", "feature-x") })];
    expect(worktreePrStatus(sessions, "feature-x")).toBeNull();
  });

  it("returns null when the main session has no pr", () => {
    const sessions = [session({ id: "s1", isMain: true })];
    expect(worktreePrStatus(sessions, "feature-x")).toBeNull();
  });
});
