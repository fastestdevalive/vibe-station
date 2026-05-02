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
        prefix: expect.any(String),
        defaultBranch: expect.any(String),
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
    const off = api.on("session:created", handler);
    const unsub = api.subscribe(["sess-main"]);
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
    off();
    unsub();
  });

  it("openSession emits session:opened and sendKeystroke echoes output", async () => {
    const api = createMockApi();
    const opened = vi.fn();
    const output = vi.fn();
    const offOpened = api.on("session:opened", opened);
    const offOutput = api.on("session:output", output);
    const unsub = api.subscribe(["sess-main"]);
    await api.openSession("sess-main", 80, 24);
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ type: "session:opened", sessionId: "sess-main" }));
    await api.sendKeystroke("sess-main", "hello");
    await new Promise((r) => setTimeout(r, 80));
    expect(output).toHaveBeenCalledWith(expect.objectContaining({ type: "session:output", chunk: "hello" }));
    offOpened();
    offOutput();
    unsub();
  });

  it("typed listeners only receive matching events while star receives all", async () => {
    const api = createMockApi();
    const output = vi.fn();
    const state = vi.fn();
    const all = vi.fn();
    const offOutput = api.on("session:output", output);
    const offState = api.on("session:state", state);
    const offAll = api.on("*", all);
    api.subscribe(["sess-main"]);
    await api.sendKeystroke("sess-main", "x");
    await api.resumeSession("sess-main");
    await new Promise((r) => setTimeout(r, 80));
    expect(output).toHaveBeenCalled();
    expect(state).toHaveBeenCalled();
    expect(all.mock.calls.length).toBeGreaterThanOrEqual(output.mock.calls.length + state.mock.calls.length);
    offOutput();
    offState();
    offAll();
  });
});
