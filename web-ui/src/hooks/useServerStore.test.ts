import { describe, it, expect, beforeEach } from "vitest";
import { useServerStore } from "./useServerStore";
import type { Project } from "@/api/types";

function proj(id: string, hidden = false): Project {
  return {
    id,
    name: id,
    path: `/tmp/${id}`,
    prefix: id.slice(0, 2),
    isGit: true,
      defaultBranch: "main",
    createdAt: "2024-01-01T00:00:00.000Z",
    hidden,
    lspEnabled: false,
  };
}

describe("useServerStore.applyProjectUpdated", () => {
  beforeEach(() => {
    useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
  });

  it("replaces the matching project (flips hidden)", () => {
    useServerStore.getState().replaceAll({
      projects: [proj("a"), proj("b")],
      worktrees: [],
      sessions: [],
    });
    useServerStore.getState().applyProjectUpdated(proj("a", true));
    const { projects } = useServerStore.getState();
    expect(projects.find((p) => p.id === "a")?.hidden).toBe(true);
    expect(projects.find((p) => p.id === "b")?.hidden).toBe(false);
  });

  it("ignores an unknown project id (no surprise insert)", () => {
    useServerStore.getState().replaceAll({
      projects: [proj("a")],
      worktrees: [],
      sessions: [],
    });
    useServerStore.getState().applyProjectUpdated(proj("ghost", true));
    expect(useServerStore.getState().projects.map((p) => p.id)).toEqual(["a"]);
  });
});

describe("useServerStore diffStats slice (rev monotonic)", () => {
  beforeEach(() => {
    useServerStore.setState({
      projects: [],
      worktrees: [],
      sessions: [],
      diffStats: {},
      loaded: false,
    });
  });

  it("applyWorktreeDiffStat keeps higher rev", () => {
    const store = useServerStore.getState();
    store.applyWorktreeDiffStat("wt-1", {
      insertions: 5,
      deletions: 2,
      state: "ok",
      rev: 10,
    });
    expect(useServerStore.getState().diffStats["wt-1"]?.rev).toBe(10);

    // Stale event with lower rev is dropped
    store.applyWorktreeDiffStat("wt-1", {
      insertions: 3,
      deletions: 1,
      state: "ok",
      rev: 5,
    });
    expect(useServerStore.getState().diffStats["wt-1"]?.rev).toBe(10);
    expect(useServerStore.getState().diffStats["wt-1"]?.insertions).toBe(5);

    // Higher rev is applied
    store.applyWorktreeDiffStat("wt-1", {
      insertions: 8,
      deletions: 0,
      state: "ok",
      rev: 15,
    });
    expect(useServerStore.getState().diffStats["wt-1"]?.rev).toBe(15);
    expect(useServerStore.getState().diffStats["wt-1"]?.insertions).toBe(8);
  });

  it("seedDiffStats merges keeping higher rev (event then stale snapshot => event wins; restart rev higher wins)", () => {
    const store = useServerStore.getState();
    // Live event arrives first with rev 20
    store.applyWorktreeDiffStat("wt-1", {
      insertions: 10,
      deletions: 2,
      state: "ok",
      rev: 20,
    });

    // Stale snapshot arriving later with rev 15 is ignored for wt-1, but wt-2 is added
    store.seedDiffStats({
      "wt-1": { insertions: 1, deletions: 1, state: "ok", rev: 15 },
      "wt-2": { insertions: 4, deletions: 0, state: "ok", rev: 10 },
    });

    const diffs = useServerStore.getState().diffStats;
    expect(diffs["wt-1"]?.rev).toBe(20);
    expect(diffs["wt-1"]?.insertions).toBe(10);
    expect(diffs["wt-2"]?.rev).toBe(10);

    // Restart higher rev (unix ms timestamp) wins over prior entry
    store.seedDiffStats({
      "wt-1": { insertions: 12, deletions: 3, state: "ok", rev: 1730000000000 },
    });
    expect(useServerStore.getState().diffStats["wt-1"]?.rev).toBe(1730000000000);
    expect(useServerStore.getState().diffStats["wt-1"]?.insertions).toBe(12);
  });
});

