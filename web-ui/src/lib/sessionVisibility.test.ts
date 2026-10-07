import { describe, expect, it } from "vitest";
import type { Session } from "@/api/types";
import {
  compareTabOrder,
  isTabVisibleAgent,
  pickFirstDirectAgent,
  pickNextDirectAgent,
  pickWorktreeAgent,
  resolveSupersededChain,
} from "./sessionVisibility";

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: "s1",
    worktreeId: "wt-1",
    projectId: "p1",
    modeId: null,
    type: "agent",
    isMain: false,
    state: "working",
    lifecycleState: "working",
    tmuxName: "s1",
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

const agent = (id: string, overrides: Partial<Session> = {}) =>
  makeSession({ id, ...overrides });

describe("isTabVisibleAgent", () => {
  it("is true for a live agent", () => {
    expect(isTabVisibleAgent(agent("a"))).toBe(true);
  });
  it("is false for a superseded agent", () => {
    expect(isTabVisibleAgent(agent("a", { supersededBy: "a-new" }))).toBe(false);
  });
  it("is false for a terminal", () => {
    expect(isTabVisibleAgent(agent("t", { type: "terminal" }))).toBe(false);
  });
});

describe("compareTabOrder", () => {
  it("sorts by sortOrder ?? 0, then id", () => {
    const a = agent("b", { sortOrder: 2 });
    const b = agent("a", { sortOrder: 1 });
    const c = agent("c"); // no sortOrder → 0
    expect(compareTabOrder(c, b)).toBeLessThan(0); // 0 < 1
    expect(compareTabOrder(a, b)).toBeGreaterThan(0); // 2 > 1
  });
  it("breaks ties by id", () => {
    expect(compareTabOrder(agent("b", { sortOrder: 1 }), agent("a", { sortOrder: 1 }))).toBeGreaterThan(0);
    expect(compareTabOrder(agent("a", { sortOrder: 1 }), agent("b", { sortOrder: 1 }))).toBeLessThan(0);
  });
});

describe("resolveSupersededChain", () => {
  it("returns the id unchanged when not superseded", () => {
    expect(resolveSupersededChain("a", [agent("a")])).toBe("a");
  });
  it("follows a single supersededBy hop", () => {
    const sessions = [
      agent("a", { supersededBy: "b" }),
      agent("b"),
    ];
    expect(resolveSupersededChain("a", sessions)).toBe("b");
  });
  it("follows a multi-hop chain to the final id", () => {
    const sessions = [
      agent("a", { supersededBy: "b" }),
      agent("b", { supersededBy: "c" }),
      agent("c"),
    ];
    expect(resolveSupersededChain("a", sessions)).toBe("c");
  });
  it("returns the id when the target is missing from the list", () => {
    expect(resolveSupersededChain("zzz", [agent("a")])).toBe("zzz");
  });
  it("does not infinite-loop on a cycle", () => {
    const sessions = [
      agent("a", { supersededBy: "b" }),
      agent("b", { supersededBy: "a" }),
    ];
    // No terminal element — the cycle guard returns the input id defensively.
    expect(resolveSupersededChain("a", sessions)).toBe("a");
  });
});

describe("pickWorktreeAgent", () => {
  const main = agent("main", { isMain: true, sortOrder: 1 });
  const alt = agent("alt", { sortOrder: 2 });

  it("returns null when there are no tab-visible agents", () => {
    expect(pickWorktreeAgent([agent("s", { type: "terminal" })], {})).toBeNull();
    expect(pickWorktreeAgent([], {})).toBeNull();
    // All superseded → nothing visible → null.
    expect(pickWorktreeAgent([agent("a", { supersededBy: "b" })], {})).toBeNull();
  });

  it("prefers explicitId when it is a tab-visible agent", () => {
    expect(pickWorktreeAgent([main, alt], { explicitId: "alt" })).toBe("alt");
  });

  it("ignores an explicitId that is superseded (not tab-visible)", () => {
    const superseded = agent("old", { supersededBy: "main", sortOrder: 0 });
    expect(pickWorktreeAgent([main, alt, superseded], { explicitId: "old" })).toBe("main");
  });

  it("ignores an explicitId that is not in the list", () => {
    expect(pickWorktreeAgent([main, alt], { explicitId: "gone" })).toBe("main");
  });

  it("uses lastId when it is tab-visible and non-exited", () => {
    expect(pickWorktreeAgent([main, alt], { lastId: "alt" })).toBe("alt");
  });

  it("skips a superseded lastId", () => {
    const superseded = agent("last", { supersededBy: "main", sortOrder: 0 });
    expect(pickWorktreeAgent([main, superseded], { lastId: "last" })).toBe("main");
  });

  it("skips an exited lastId (Requirement 4a)", () => {
    const exited = agent("last", { state: "exited", lifecycleState: "exited" });
    expect(pickWorktreeAgent([main, exited], { lastId: "last" })).toBe("main");
  });

  it("falls back to main when lastId is invalid", () => {
    expect(pickWorktreeAgent([main, alt], { lastId: "bogus" })).toBe("main");
  });

  it("falls back to first non-archived by tab order when there is no main", () => {
    const a = agent("a", { sortOrder: 2 });
    const b = agent("b", { sortOrder: 1 });
    expect(pickWorktreeAgent([a, b], {})).toBe("b");
  });

  it("skips an archived main and falls back to a non-archived agent", () => {
    const archivedMain = agent("main", { isMain: true, archivedAt: "2020-01-01" });
    const live = agent("live", { sortOrder: 1 });
    expect(pickWorktreeAgent([archivedMain, live], {})).toBe("live");
  });

  it("prefers a visible main over a lower-sortOrder sibling", () => {
    // main wins the fallback even if it sorts after another visible agent.
    expect(pickWorktreeAgent([alt, main], {})).toBe("main");
  });

  it("picks a visible agent when all are archived except one", () => {
    const archived = agent("a", { sortOrder: 1, archivedAt: "2020-01-01" });
    const b = agent("b", { sortOrder: 2 });
    expect(pickWorktreeAgent([archived, b], {})).toBe("b");
  });

  it("never picks a terminal even as the only listed session", () => {
    const term = agent("t", { type: "terminal" });
    expect(pickWorktreeAgent([term], { lastId: "t" })).toBeNull();
  });
});

describe("pickFirstDirectAgent", () => {
  const a = agent("a", { worktreeId: null, sortOrder: 1 });
  const b = agent("b", { worktreeId: null, sortOrder: 2 });

  it("picks the first tab-visible open direct agent by tab order", () => {
    expect(pickFirstDirectAgent(["b", "a"], [a, b])).toBe("a");
  });
  it("returns null when none of the open ids are tab-visible", () => {
    expect(pickFirstDirectAgent(["x"], [a, b])).toBeNull();
  });
  it("skips superseded open ids", () => {
    const superseded = agent("s", { worktreeId: null, supersededBy: "b" });
    expect(pickFirstDirectAgent(["s", "a"], [a, superseded])).toBe("a");
  });
});

describe("pickNextDirectAgent", () => {
  const a = agent("a", { worktreeId: null, sortOrder: 1 });
  const b = agent("b", { worktreeId: null, sortOrder: 2 });
  const c = agent("c", { worktreeId: null, sortOrder: 3 });

  it("returns null when there are no remaining visible tabs", () => {
    expect(pickNextDirectAgent(["b"], b, [])).toBeNull();
  });

  it("prefers the tab immediately before the closed one", () => {
    // closing "c" → prefer "b" (immediately before in tab order)
    expect(pickNextDirectAgent(["a", "b", "c"], c, [a, b, c])).toBe("b");
  });

  it("falls back to the first remaining when closed was first", () => {
    expect(pickNextDirectAgent(["a", "b", "c"], a, [a, b, c])).toBe("b");
  });

  it("ignores superseded remaining tabs", () => {
    // The only other tab is superseded → no visible remaining → null.
    const superseded = agent("x", { worktreeId: null, sortOrder: 1, supersededBy: "b" });
    expect(pickNextDirectAgent(["x", "b"], b, [superseded, b])).toBeNull();
  });

  it("works when sessions is post-deletion (closed absent)", () => {
    expect(pickNextDirectAgent(["a", "b", "c"], c, [a, b])).toBe("b");
  });
});
