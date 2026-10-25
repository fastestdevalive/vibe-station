import { beforeEach, describe, expect, it } from "vitest";
import type { Worktree } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import type { BulkJob } from "./bulkRunner";
import { useBulkWorktrees } from "./useBulkWorktrees";

function worktree(id: string): Worktree {
  return {
    id,
    projectId: "proj-a",
    branch: id,
    baseBranch: "main",
    baseSha: "sha",
    createdAt: "2026-01-01T00:00:00.000Z",
    pinnedAt: null,
    hiddenAt: null,
    lspEnabled: false,
  };
}

function job(id: number): BulkJob {
  return {
    id,
    action: "delete",
    items: [{ id: "a", label: "A", status: "queued" }],
    finished: false,
    cancelRequested: false,
  };
}

function seedWorktrees(...ids: string[]) {
  useServerStore.setState({
    projects: [],
    worktrees: ids.map(worktree),
    sessions: [],
    loaded: true,
  });
}

beforeEach(() => {
  useBulkWorktrees.setState({ mode: null, selected: new Set(), job: null });
  seedWorktrees();
});

describe("useBulkWorktrees", () => {
  it("enter sets the mode and starts with an empty selection", () => {
    const store = useBulkWorktrees.getState();
    store.toggle("wt-1");
    store.enter("archive");

    const next = useBulkWorktrees.getState();
    expect(next.mode).toBe("archive");
    expect(next.selected.size).toBe(0);
  });

  it("toggle adds and removes ids with a new Set each time", () => {
    const first = useBulkWorktrees.getState().selected;
    useBulkWorktrees.getState().toggle("wt-1");
    const afterAdd = useBulkWorktrees.getState().selected;
    expect(afterAdd).not.toBe(first);
    expect([...afterAdd]).toEqual(["wt-1"]);

    useBulkWorktrees.getState().toggle("wt-1");
    expect([...useBulkWorktrees.getState().selected]).toEqual([]);
  });

  it("setMany selects and deselects groups of ids", () => {
    useBulkWorktrees.getState().toggle("wt-1");
    useBulkWorktrees.getState().setMany(["wt-2", "wt-3"], true);
    expect([...useBulkWorktrees.getState().selected].sort()).toEqual(["wt-1", "wt-2", "wt-3"]);

    useBulkWorktrees.getState().setMany(["wt-1", "wt-3"], false);
    expect([...useBulkWorktrees.getState().selected]).toEqual(["wt-2"]);
  });

  it("exit clears the mode and the selection but keeps the job", () => {
    useBulkWorktrees.getState().enter("delete");
    useBulkWorktrees.getState().toggle("wt-1");
    useBulkWorktrees.getState().setJob(job(1));

    useBulkWorktrees.getState().exit();

    const next = useBulkWorktrees.getState();
    expect(next.mode).toBeNull();
    expect(next.selected.size).toBe(0);
    expect(next.job?.id).toBe(1);
  });

  it("selection survives unrelated state changes", () => {
    useBulkWorktrees.getState().toggle("wt-1");
    useBulkWorktrees.getState().setJob(job(2));

    expect([...useBulkWorktrees.getState().selected]).toEqual(["wt-1"]);
  });

  it("prunes selected ids that vanish from server truth", () => {
    seedWorktrees("wt-1", "wt-2");
    useBulkWorktrees.getState().setMany(["wt-1", "wt-2"], true);

    // Same ids, different objects: no prune (a plain refetch must not clear it).
    seedWorktrees("wt-1", "wt-2");
    expect([...useBulkWorktrees.getState().selected].sort()).toEqual(["wt-1", "wt-2"]);

    seedWorktrees("wt-1");
    expect([...useBulkWorktrees.getState().selected]).toEqual(["wt-1"]);
  });
});
