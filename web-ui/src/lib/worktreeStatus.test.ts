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
    modeId: null,
    type: "agent",
    label: id,
    slot: "m",
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
});
