import { describe, it, expect } from "vitest";
import type { Session, SessionState } from "@/api/types";
import {
  worktreeRolledUpStatus,
  worktreeRolledUpStatusDetail,
  workingDriversDetail,
  buildDescendantIndex,
  descendantAgents,
  workingDescendants,
} from "./worktreeStatus";

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

  // --- 2.T1: working beats waiting_for_human in rollup ---
  // If any agent is actively working, the worktree shows as working, not waiting.

  it("rolls up to working over waiting_for_human", () => {
    const sessions = [sess("a", "waiting_for_human"), sess("b", "working")];
    expect(worktreeRolledUpStatus(sessions, {})).toBe("working");
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

describe("worktreeRolledUpStatus — superseded sessions", () => {
  const superseded = (id: string, state: Session["state"], by: string): Session => ({
    ...sess(id, state),
    isMain: false,
    supersededBy: by,
  });

  it("ignores a superseded working row when its replacement exists", () => {
    const sessions = [superseded("old", "working", "new"), sess("new", "idle")];
    expect(worktreeRolledUpStatus(sessions, {})).toBe("idle");
  });

  it("lets a done replacement win over a superseded exited row", () => {
    const sessions = [superseded("old", "exited", "new"), sess("new", "done")];
    expect(worktreeRolledUpStatus(sessions, {})).toBe("done");
  });

  it("still counts a row whose supersededBy dangles", () => {
    const sessions = [superseded("old", "working", "gone")];
    expect(worktreeRolledUpStatus(sessions, {})).toBe("working");
  });

  it("ignores the live-map value of a superseded row", () => {
    const sessions = [superseded("old", "idle", "new"), sess("new", "done")];
    const live = { old: "working" } as Record<string, SessionState>;
    expect(worktreeRolledUpStatus(sessions, live)).toBe("done");
  });
});

// --- rollup detail + descendant walk (issue: "working" dot, visible agents idle) ---

function node(id: string, over: Partial<Session> = {}): Session {
  return { ...sess(id, "waiting_for_human"), isMain: false, name: id, ...over };
}

describe("worktreeRolledUpStatusDetail", () => {
  it("returns the status AND every agent at that rank, in input order", () => {
    const sessions = [node("a", { state: "working" }), node("b"), node("c", { state: "working" })];
    const d = worktreeRolledUpStatusDetail(sessions, {});
    expect(d.status).toBe("working");
    expect(d.drivers.map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("uses live states, skips terminals and superseded rows (same filter as the dot)", () => {
    const sessions = [
      node("old", { state: "working", supersededBy: "new" }),
      node("new"),
      node("term", { type: "terminal", state: "working" }),
      node("x"),
    ];
    const d = worktreeRolledUpStatusDetail(sessions, { x: "working" });
    expect(d.status).toBe("working");
    expect(d.drivers.map((s) => s.id)).toEqual(["x"]);
  });

  it("agrees with worktreeRolledUpStatus", () => {
    const sessions = [node("a", { state: "idle" }), node("b", { state: "done" })];
    expect(worktreeRolledUpStatusDetail(sessions, {}).status).toBe(worktreeRolledUpStatus(sessions, {}));
  });
});

describe("workingDriversDetail", () => {
  const sessions = ["a", "b", "c", "d"].map((id) => node(id, { state: "working" }));
  it("lists up to two names then +N", () => {
    expect(workingDriversDetail(worktreeRolledUpStatusDetail(sessions, {}))).toBe("a, b +2");
  });
  it("is undefined for a non-working rollup", () => {
    const idle = [node("a", { state: "idle" })];
    expect(workingDriversDetail(worktreeRolledUpStatusDetail(idle, {}))).toBeUndefined();
  });
});

describe("descendantAgents / workingDescendants", () => {
  const ids = (list: Session[]) => list.map((s) => s.id);

  it("walks grandchildren and below, excluding the root", () => {
    const all = [node("root"), node("c", { parentSessionId: "root" }), node("g", { parentSessionId: "c" })];
    const idx = buildDescendantIndex(all);
    expect(ids(descendantAgents(all[0]!, idx))).toEqual(["c", "g"]);
    expect(ids(descendantAgents(all[1]!, idx))).toEqual(["g"]);
  });

  it("follows a reset chain: children of the archived predecessor belong to the successor", () => {
    const all = [
      node("c-old", { supersededBy: "c-new", archivedAt: "2024-01-02T00:00:00.000Z" }),
      node("c-new"),
      node("g", { parentSessionId: "c-old", state: "working" }),
    ];
    const idx = buildDescendantIndex(all);
    expect(ids(workingDescendants(all[1]!, idx, {}))).toEqual(["g"]);
  });

  it("drops superseded descendants (their successor carries the same parent) but keeps a dangling one", () => {
    const all = [
      node("root"),
      node("g-old", { parentSessionId: "root", supersededBy: "g-new" }),
      node("g-new", { parentSessionId: "root" }),
      node("dangling", { parentSessionId: "root", supersededBy: "gone" }),
    ];
    expect(ids(descendantAgents(all[0]!, buildDescendantIndex(all)))).toEqual(["g-new", "dangling"]);
  });

  it("stays in the root's worktree (and does not walk through other worktrees)", () => {
    const all = [
      node("root"),
      node("other", { parentSessionId: "root", worktreeId: "w2", state: "working" }),
      node("under-other", { parentSessionId: "other", state: "working" }),
    ];
    expect(descendantAgents(all[0]!, buildDescendantIndex(all))).toEqual([]);
  });

  it("direct (worktree-less) sessions stay within their project", () => {
    const all = [
      node("root", { worktreeId: null }),
      node("same", { worktreeId: null, parentSessionId: "root" }),
      node("elsewhere", { worktreeId: null, projectId: "p2", parentSessionId: "root" }),
    ];
    expect(ids(descendantAgents(all[0]!, buildDescendantIndex(all)))).toEqual(["same"]);
  });

  it("skips terminals and terminates on a parent cycle", () => {
    const all = [
      node("a", { parentSessionId: "b" }),
      node("b", { parentSessionId: "a" }),
      node("t", { parentSessionId: "a", type: "terminal" }),
    ];
    expect(ids(descendantAgents(all[0]!, buildDescendantIndex(all)))).toEqual(["b"]);
  });

  it("has no depth limit: a working agent deep in a chain still counts (like the dot)", () => {
    const chain = [node("n0")];
    for (let i = 1; i <= 30; i++) chain.push(node(`n${i}`, { parentSessionId: `n${i - 1}` }));
    chain[30] = { ...chain[30]!, state: "working" };
    const idx = buildDescendantIndex(chain);
    expect(descendantAgents(chain[0]!, idx)).toHaveLength(30);
    expect(ids(workingDescendants(chain[0]!, idx, {}))).toEqual(["n30"]);
  });

  it("archived descendants count, like the rollup counts archived agents", () => {
    const all = [
      node("root"),
      node("arch", { parentSessionId: "root", archivedAt: "2024-01-02T00:00:00.000Z", state: "working" }),
    ];
    const idx = buildDescendantIndex(all);
    expect(ids(workingDescendants(all[0]!, idx, {}))).toEqual(["arch"]);
    expect(worktreeRolledUpStatus(all, {})).toBe("working");
  });

  it("reads live state and orders most-recently-active first, ties by id", () => {
    const all = [
      node("root"),
      node("old", { parentSessionId: "root", lastActivityAt: "2026-01-01T00:00:00.000Z" }),
      node("new", { parentSessionId: "root", lastActivityAt: "2026-01-02T00:00:00.000Z" }),
      node("b", { parentSessionId: "root" }),
      node("a", { parentSessionId: "root" }),
      node("idle", { parentSessionId: "root", state: "working" }),
    ];
    const live = { old: "working", new: "working", a: "working", b: "working", idle: "idle" } as const;
    expect(ids(workingDescendants(all[0]!, buildDescendantIndex(all), live))).toEqual(["new", "old", "a", "b"]);
  });
});
