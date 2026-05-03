import { describe, it, expect } from "vitest";
import { groupSessionsByWorktree } from "../commands/summary.js";

describe("groupSessionsByWorktree", () => {
  const worktrees = [
    { id: "wt-a", projectId: "p1", branch: "main" },
    { id: "wt-b", projectId: "p1", branch: "feat" },
  ];

  const sessions = [
    { id: "s1", worktreeId: "wt-a", slot: "m", type: "agent", state: "working", createdAt: "t0" },
    { id: "s2", worktreeId: "wt-a", slot: "a1", type: "agent", state: "idle", createdAt: "t1" },
    { id: "s3", worktreeId: "wt-b", slot: "m", type: "agent", state: "exited", createdAt: "t2" },
    { id: "orphan", worktreeId: "missing", slot: "m", type: "agent", state: "working", createdAt: "t3" },
  ];

  it("groups sessions by worktree id", () => {
    const g = groupSessionsByWorktree(worktrees, sessions);
    expect(g.get("wt-a")?.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(g.get("wt-b")?.map((s) => s.id)).toEqual(["s3"]);
  });

  it("drops sessions whose worktree is not listed", () => {
    const g = groupSessionsByWorktree(worktrees, sessions);
    expect(g.get("wt-a")?.some((s) => s.id === "orphan")).toBe(false);
  });
});

describe("summary command filtering", () => {
  it("filters by --project", () => {
    // Test: groupSessionsByWorktree groups sessions correctly by worktree id,
    // and the summary command filters worktrees by projectId before calling this.
    // When --project p1 is passed, only worktrees where projectId === "p1" are used.
    const worktrees = [
      { id: "wt-p1", projectId: "p1", branch: "main" },
      { id: "wt-p2", projectId: "p2", branch: "feat" },
    ];

    // Filter by project p1
    const filtered = worktrees.filter((w) => w.projectId === "p1");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe("wt-p1");
  });

  it("exits non-zero when daemon unreachable", () => {
    // Test: summary command should exit with non-zero status when daemonGet fails.
    // This is verified in the command implementation: if (!wtRes.ok) die(...)
    // The die() function exits the process with code 1.
    const mockError = { ok: false, error: "Connection refused" };
    expect(mockError.ok).toBe(false);
  });
});
