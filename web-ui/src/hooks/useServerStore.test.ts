import { describe, it, expect, beforeEach } from "vitest";
import { useServerStore } from "./useServerStore";
import type { Project } from "@/api/types";

function proj(id: string, hidden = false): Project {
  return {
    id,
    name: id,
    path: `/tmp/${id}`,
    prefix: id.slice(0, 2),
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
