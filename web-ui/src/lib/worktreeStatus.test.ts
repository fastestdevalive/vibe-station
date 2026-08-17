import { describe, it, expect } from "vitest";
import type { Session, SessionState } from "@/api/types";
import { worktreeRolledUpStatus } from "./worktreeStatus";

function sess(
  id: string,
  state: Session["state"],
): Session {
  return {
    id,
    worktreeId: "w",
    projectId: "p",
    modeId: null,
    type: "agent",
    isMain: true,
    state,
    lifecycleState: state,
    tmuxName: `t-${id}`,
    createdAt: new Date().toISOString(),
  };
}

describe("worktreeRolledUpStatus", () => {
  it("returns none when there are no sessions", () => {
    expect(worktreeRolledUpStatus([], {})).toBe("none");
  });

  it("prefers working over spawning", () => {
    const sessions = [sess("a", "not_started"), sess("b", "working")];
    const live = {} as Record<string, SessionState>;
    expect(worktreeRolledUpStatus(sessions, live)).toBe("working");
  });

  it("prefers spawning over idle", () => {
    const sessions = [sess("a", "idle"), sess("b", "not_started")];
    expect(worktreeRolledUpStatus(sessions, {})).toBe("spawning");
  });

  it("prefers idle over done", () => {
    const sessions = [sess("a", "done"), sess("b", "idle")];
    expect(worktreeRolledUpStatus(sessions, {})).toBe("idle");
  });

  it("prefers done over exited", () => {
    const sessions = [sess("a", "exited"), sess("b", "done")];
    expect(worktreeRolledUpStatus(sessions, {})).toBe("done");
  });

  it("uses live sessionStates when provided", () => {
    const sessions = [sess("a", "working")];
    expect(worktreeRolledUpStatus(sessions, { a: "idle" })).toBe("idle");
  });

  // --- 2.T1: waiting_for_human rollup precedence (R8) ---

  it("rolls up to waiting_for_human over working", () => {
    const sessions = [sess("a", "waiting_for_human"), sess("b", "working")];
    expect(worktreeRolledUpStatus(sessions, {})).toBe("waiting_for_human");
  });

  // --- 4.T5: `needs_review` removed from LifecycleState/SessionState (Phase 4) ---
  // A legacy `needs_review` value can still arrive (e.g. a `session:state` WS
  // event predating the daemon's back-compat read in sqliteRowMappers.ts, or
  // any other stale/unexpected string) — `worktreeRolledUpStatus`'s default
  // branch must treat it as unranked (`none`), not crash or silently sort it
  // above other real states.

  it("falls back to none for an unrecognized legacy state (e.g. needs_review)", () => {
    const sessions = [sess("a", "needs_review" as unknown as SessionState)];
    expect(worktreeRolledUpStatus(sessions, {})).toBe("none");
  });

  it("waiting_for_human still outranks an unrecognized legacy state", () => {
    const sessions = [sess("a", "needs_review" as unknown as SessionState), sess("b", "waiting_for_human")];
    expect(worktreeRolledUpStatus(sessions, {})).toBe("waiting_for_human");
  });
});
