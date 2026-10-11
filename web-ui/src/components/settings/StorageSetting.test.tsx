import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { createMockApi } from "@/api/mock";
import type { Session, Worktree } from "@/api/types";
import { StorageSetting } from "./StorageSetting";

function session(over: Partial<Session>): Session {
  return {
    id: "s",
    projectId: "p",
    worktreeId: "wt-1",
    type: "agent",
    state: "idle",
    isMain: false,
    ...over,
  } as Session;
}

describe("StorageSetting — superseded sessions", () => {
  it("counts a worktree as done when only a superseded 'exited' row sits beside a 'done' replacement", async () => {
    const wt = {
      id: "wt-1",
      projectId: "p",
      branch: "feat/x",
      createdAt: "2026-01-01T00:00:00.000Z",
    } as Worktree;
    const sessions = [
      session({ id: "old", state: "exited", isMain: true, supersededBy: "new" }),
      session({ id: "new", state: "done", isMain: true }),
    ];
    const api = {
      ...createMockApi(),
      listWorktrees: async () => [wt],
      listSessions: async () => sessions,
      getDiskUsage: async () => ({
        device: { totalBytes: 0, freeBytes: 0, usedBytes: 0 },
        worktrees: [],
      }),
    } as unknown as ReturnType<typeof createMockApi>;

    render(<StorageSetting api={api} />);

    // Default filter is "done": the row only renders if the worktree counts as done.
    expect(await screen.findByText(/wt-1 · feat\/x/)).toBeInTheDocument();
    // Status dot resolves off the replacement ('done'), not the superseded 'exited' row.
    expect(screen.getByLabelText("status: done")).toBeInTheDocument();
    expect(screen.queryByLabelText("status: exited")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "" })).toBeEnabled();
  });
});
