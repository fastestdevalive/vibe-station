import { describe, it, expect, beforeEach } from "vitest";
import { useServerStore } from "./useServerStore";
import type { Project, Session } from "@/api/types";

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

// ─── childByParent — Phase 2 tests ───────────────────────────────────────────

function sess(id: string, spawnedFrom?: string): Session {
  return {
    id,
    worktreeId: "wt-1",
    projectId: "proj-a",
    modeId: null,
    type: "agent",
    isMain: false,
    state: "idle",
    lifecycleState: "idle",
    tmuxName: id,
    createdAt: "2024-01-01T00:00:00.000Z",
    spawnedFrom: spawnedFrom ?? null,
  };
}

describe("useServerStore.childByParent — 2.T5: replaceAll rebuilds map", () => {
  beforeEach(() => {
    useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false, childByParent: new Map() });
  });

  it("populates childByParent from sessions with spawnedFrom", () => {
    useServerStore.getState().replaceAll({
      projects: [],
      worktrees: [],
      sessions: [
        sess("parent-1"),
        sess("child-1a", "parent-1"),
        sess("child-1b", "parent-1"),
        sess("child-2a", "parent-2"),
      ],
    });
    const { childByParent } = useServerStore.getState();
    expect(childByParent.get("parent-1")).toEqual(["child-1a", "child-1b"]);
    expect(childByParent.get("parent-2")).toEqual(["child-2a"]);
  });

  it("produces an empty map when no sessions have spawnedFrom", () => {
    useServerStore.getState().replaceAll({
      projects: [],
      worktrees: [],
      sessions: [sess("s1"), sess("s2")],
    });
    expect(useServerStore.getState().childByParent.size).toBe(0);
  });
});

describe("useServerStore.addChildSession", () => {
  beforeEach(() => {
    useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false, childByParent: new Map() });
  });

  it("appends in FIFO order for the same parentId", () => {
    useServerStore.getState().addChildSession("parent-1", "child-a");
    useServerStore.getState().addChildSession("parent-1", "child-b");
    expect(useServerStore.getState().childByParent.get("parent-1")).toEqual(["child-a", "child-b"]);
  });

  it("creates separate entries for different parentIds", () => {
    useServerStore.getState().addChildSession("parent-1", "child-x");
    useServerStore.getState().addChildSession("parent-2", "child-y");
    const { childByParent } = useServerStore.getState();
    expect(childByParent.get("parent-1")).toEqual(["child-x"]);
    expect(childByParent.get("parent-2")).toEqual(["child-y"]);
  });
});
