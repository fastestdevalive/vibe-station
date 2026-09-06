import { describe, it, expect } from "vitest";
import { createMockApi } from "@/api/mock";
import { createWorktreeRepository } from "./worktreeRepository";

describe("createWorktreeRepository", () => {
  it("forwards every method by identity — no new logic introduced", () => {
    const api = createMockApi();
    const repo = createWorktreeRepository(api);
    const methods = [
      "listWorktrees",
      "listProjectBranches",
      "createWorktree",
      "deleteWorktree",
      "getDiskUsage",
      "markWorktreeDone",
      "pinWorktree",
      "unpinWorktree",
      "hideWorktree",
      "unhideWorktree",
      "renameWorktree",
      "reorderWorktree",
      "getOrderedList",
      "setOrderedList",
      "getDiff",
      "tree",
      "fileList",
      "listChangedPaths",
      "listCommits",
      "getPr",
      "listSubmodules",
      "on",
    ] as const;
    for (const method of methods) {
      expect(repo[method]).toBe(api[method]);
    }
  });

  it("getOrderedList/setOrderedList round-trip through the same store as api", async () => {
    const api = createMockApi();
    const repo = createWorktreeRepository(api);

    const empty = await repo.getOrderedList("pinned-all");
    expect(empty).toEqual({ scopeKey: "pinned-all", itemIds: [], updatedAt: null });

    const written = await repo.setOrderedList("pinned-all", ["a", "b"]);
    expect(written.ok).toBe(true);
    expect(written.itemIds).toEqual(["a", "b"]);

    // Written via the repo, read back via the raw api — same underlying store.
    const readBack = await api.getOrderedList("pinned-all");
    expect(readBack.itemIds).toEqual(["a", "b"]);
  });
});
