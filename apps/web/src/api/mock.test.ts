import { describe, it, expect, vi } from "vitest";
import { createMockApi } from "./mock";
import type { Project } from "./types";

describe("mock api contract", () => {
  it("listProjects returns Project[] with required fields", async () => {
    const api = createMockApi();
    const ps = await api.listProjects();
    expect(Array.isArray(ps)).toBe(true);
    for (const p of ps) {
      expect(p).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        path: expect.any(String),
        createdAt: expect.any(String),
      } satisfies Partial<Project>);
    }
  });

  it("listWorktrees filters by project", async () => {
    const api = createMockApi();
    const wts = await api.listWorktrees("proj-a");
    expect(wts.every((w) => w.projectId === "proj-a")).toBe(true);
  });

  it("listSessions returns at least one main session per worktree", async () => {
    const api = createMockApi();
    for (const wt of await api.listWorktrees("proj-a")) {
      const ss = await api.listSessions(wt.id);
      expect(ss.some((s) => s.slot === "m")).toBe(true);
    }
  });

  it("creating a session emits session:created on mock WS", async () => {
    const api = createMockApi();
    const handler = vi.fn();
    const unsub = api.subscribe(["sess-main"], handler);
    await api.createSession({
      worktreeId: "wt-1",
      modeId: "mode-1",
      type: "agent",
    });
    expect(handler).toHaveBeenCalled();
    const ev = handler.mock.calls.find(
      (c) => c[0]?.type === "session:created",
    )?.[0];
    expect(ev?.type).toBe("session:created");
    unsub();
  });
});
