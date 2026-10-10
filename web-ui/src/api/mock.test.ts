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
      expect(ss.some((s) => s.isMain)).toBe(true);
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

  // 1.T5 — new rename/reorder/reset/handoff methods must exist on the mock
  // and behave consistently with client.ts's real ones (same success/shape
  // contract), since component tests run against the mock.
  it("renameWorktree updates name, clears on empty string, and emits worktree:updated", async () => {
    const api = createMockApi();
    const handler = vi.fn();
    const off = api.on("worktree:updated", handler);

    const res = await api.renameWorktree("wt-1", "New Name");
    expect(res).toEqual({ ok: true, name: "New Name" });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: "worktree:updated", worktree: expect.objectContaining({ name: "New Name" }) }),
    );

    const cleared = await api.renameWorktree("wt-1", "   ");
    expect(cleared).toEqual({ ok: true, name: null });

    const wts = await api.listWorktrees("proj-a");
    expect(wts.find((w) => w.id === "wt-1")?.name).toBeNull();
    off();
  });

  it("renameWorktree 404s for an unknown id", async () => {
    const api = createMockApi();
    await expect(api.renameWorktree("does-not-exist", "x")).rejects.toThrow();
  });

  it("reorderWorktree persists sortOrder and emits worktree:updated", async () => {
    const api = createMockApi();
    const handler = vi.fn();
    const off = api.on("worktree:updated", handler);

    const res = await api.reorderWorktree("wt-1", 7);
    expect(res).toEqual({ ok: true, sortOrder: 7 });

    const wts = await api.listWorktrees("proj-a");
    expect(wts.find((w) => w.id === "wt-1")?.sortOrder).toBe(7);
    expect(handler).toHaveBeenCalled();
    off();
  });

  it("2.T1 getOrderedList/setOrderedList round-trip and emit orderedList:updated", async () => {
    const api = createMockApi();
    const handler = vi.fn();
    const off = api.on("orderedList:updated", handler);

    expect(await api.getOrderedList("pinned-all")).toEqual({
      scopeKey: "pinned-all",
      itemIds: [],
      updatedAt: null,
    });

    const res = await api.setOrderedList("pinned-all", ["x"]);
    expect(res.ok).toBe(true);
    expect(res.itemIds).toEqual(["x"]);
    expect(typeof res.updatedAt).toBe("string");
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: "orderedList:updated", scopeKey: "pinned-all", itemIds: ["x"] }),
    );

    const after = await api.getOrderedList("pinned-all");
    expect(after.itemIds).toEqual(["x"]);
    expect(after.updatedAt).toBe(res.updatedAt);
    off();
  });

  it("renameSession updates name/nameSource, clears on empty string, and emits session:updated", async () => {
    const api = createMockApi();
    const handler = vi.fn();
    const off = api.on("session:updated", handler);

    const res = await api.renameSession("sess-main", "Renamed");
    expect(res).toEqual({ ok: true, name: "Renamed" });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session:updated", sessionId: "sess-main", name: "Renamed" }),
    );

    const cleared = await api.renameSession("sess-main", "");
    expect(cleared).toEqual({ ok: true, name: null });

    const sessions = await api.listSessions("wt-1");
    const s = sessions.find((x) => x.id === "sess-main");
    expect(s?.name).toBeNull();
    expect(s?.nameSource).toBe("user");
    off();
  });

  it("reorderSession persists sortOrder and emits session:updated", async () => {
    const api = createMockApi();
    const handler = vi.fn();
    const off = api.on("session:updated", handler);

    const res = await api.reorderSession("sess-main", -2.5);
    expect(res).toEqual({ ok: true, sortOrder: -2.5 });

    const sessions = await api.listSessions("wt-1");
    expect(sessions.find((s) => s.id === "sess-main")?.sortOrder).toBe(-2.5);
    expect(handler).toHaveBeenCalled();
    off();
  });

  it("resetSession archives the old session and creates a new one in its place", async () => {
    const api = createMockApi();
    const updated = vi.fn();
    const created = vi.fn();
    const offUpdated = api.on("session:updated", updated);
    const offCreated = api.on("session:created", created);

    const res = await api.resetSession("sess-main");
    expect(res.ok).toBe(true);
    expect(res.archivedSessionId).toBe("sess-main");
    expect(res.newSessionId).not.toBe("sess-main");

    const sessions = await api.listSessions("wt-1");
    const old = sessions.find((s) => s.id === "sess-main");
    expect(old?.archivedAt).toBeTruthy();
    const next = sessions.find((s) => s.id === res.newSessionId);
    expect(next).toBeTruthy();
    expect(next?.archivedAt).toBeNull();

    expect(updated).toHaveBeenCalledWith(expect.objectContaining({ type: "session:updated", sessionId: "sess-main" }));
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ type: "session:created", sessionId: res.newSessionId }));
    offUpdated();
    offCreated();
  });

  it("resetSession rejects an already-archived session", async () => {
    const api = createMockApi();
    const first = await api.resetSession("sess-main");
    expect(first.ok).toBe(true);
    await expect(api.resetSession("sess-main")).rejects.toThrow();
  });

  it("resetSession rejects a non-agent (terminal) session", async () => {
    const api = createMockApi();
    await expect(api.resetSession("sess-term1")).rejects.toThrow();
  });

  it("handoffSession returns a summary for an agent session", async () => {
    const api = createMockApi();
    const res = await api.handoffSession("sess-main");
    expect(res.ok).toBe(true);
    expect(typeof res.handoffSummary).toBe("string");
  });

  it("handoffSession rejects a non-agent (terminal) session", async () => {
    const api = createMockApi();
    await expect(api.handoffSession("sess-term1")).rejects.toThrow();
  });

  // M4 (A2.8) — mock's terminateSession promotion-selection logic. wt-1
  // seeds sess-main (isMain, sortOrder 1), sess-agent2 (agent, sortOrder 2),
  // sess-term1 (terminal, sortOrder 3) — the terminal must never be picked.
  it("terminateSession on a main session with an eligible sibling promotes it (isMain flips, pr carried) instead of throwing", async () => {
    const api = createMockApi();
    const updated = vi.fn();
    const off = api.on("session:updated", updated);

    const res = await api.terminateSession("sess-main");
    expect(res).toEqual({ ok: true });

    const sessions = await api.listSessions("wt-1");
    expect(sessions.find((s) => s.id === "sess-main")).toBeUndefined();
    const promoted = sessions.find((s) => s.id === "sess-agent2");
    expect(promoted?.isMain).toBe(true);
    // The terminal sibling (sortOrder 3, ineligible) must never be promoted
    // even though it's still "closer" in id/creation order than nothing.
    const terminal = sessions.find((s) => s.id === "sess-term1");
    expect(terminal?.isMain).toBeFalsy();

    expect(updated).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session:updated", sessionId: "sess-agent2", isMain: true }),
    );
    off();
  });

  it("terminateSession on a main session with only a terminal sibling still throws (no eligible agent to promote)", async () => {
    const api = createMockApi();
    // wt-2's only session is its main agent (sess-wt2-main) — no sibling at
    // all, agent or otherwise, so this must still reject.
    await expect(api.terminateSession("sess-wt2-main")).rejects.toThrow();
  });

  it("terminateSession promotion emits the carried pr value on the session:updated event", async () => {
    // No public/test hook seeds a `pr` onto the base fixture's sess-main
    // (it's a pure lifecycle-only fixture, no PR state), so this asserts the
    // carry-forward CODE PATH runs and emits a defined `pr` key on the event
    // (present, even if `undefined`-valued) rather than omitting it — proving
    // `victim.pr` is read and threaded through, not silently dropped. The
    // real (daemon-side, non-empty) carry-forward value is covered by
    // `daemon/src/__tests__/sessions.test.ts`'s "M1 — promotion carries the
    // old main's pr forward immediately" test.
    const api = createMockApi();
    const updated = vi.fn();
    const off = api.on("session:updated", updated);
    await api.terminateSession("sess-main");
    const call = updated.mock.calls.find((c) => c[0]?.sessionId === "sess-agent2");
    expect(call?.[0]).toHaveProperty("pr");
    off();
  });

  // Phase 3 — MockSeed + injectable api seams (plan-hero-demos)
  it("3.4 seeded listProjects returns ONLY the seeded ids", async () => {
    const api = createMockApi({
      projects: [
        {
          id: "proj-vs",
          name: "Vibe Station",
          path: "/home/dev/vibe-station",
          prefix: "vs",
          isGit: true,
          defaultBranch: "main",
          createdAt: new Date().toISOString(),
          hidden: false,
          lspEnabled: false,
        },
      ],
    });
    const ps = await api.listProjects();
    expect(ps.map((p) => p.id)).toEqual(["proj-vs"]);
  });

  it("3.4 oobeCompleted:true → getOobeState().completed is true", async () => {
    const api = createMockApi({ oobeCompleted: true });
    expect((await api.getOobeState()).completed).toBe(true);
  });

  it("3.4 simulateOutput:false + openSession emits no session:output in 1s (fake timers)", async () => {
    const api = createMockApi({ simulateOutput: false });
    const output = vi.fn();
    const off = api.on("session:output", output);
    api.subscribe(["sess-main"]);
    vi.useFakeTimers();
    try {
      await api.openSession("sess-main", 80, 24);
      await Promise.resolve();
      vi.advanceTimersByTime(1000);
      expect(output).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
    off();
  });

  it("3.4 __test.addSession then listSessions includes it", async () => {
    const api = createMockApi();
    api.__test.addSession({
      id: "sess-new",
      worktreeId: "wt-1",
      projectId: "proj-a",
      modeId: "mode-1",
      type: "agent",
      isMain: false,
      state: "working",
      lifecycleState: "working",
      tmuxName: "sess-new",
      createdAt: new Date().toISOString(),
      sortOrder: 9,
    });
    const ss = await api.listSessions("wt-1");
    expect(ss.some((s) => s.id === "sess-new")).toBe(true);
    // removeSession splices it back out (no event)
    api.__test.removeSession("sess-new");
    expect((await api.listSessions("wt-1")).some((s) => s.id === "sess-new")).toBe(false);
  });

  it("startDraft on a worktree draft returns worktreeId and broadcasts state + promoted record", async () => {
    const api = createMockApi();
    const state = vi.fn();
    const updated = vi.fn();
    const offState = api.on("session:state", state);
    const offUpdated = api.on("session:updated", updated);
    const d = await api.createDraftSession({
      target: "worktree",
      worktreeId: "wt-1",
      type: "agent",
      draftConfig: { entryPoint: "tab" },
    });
    const res = await api.startDraft(d.id, {
      draftPrompt: "Plan this feature with Claude today",
      draftConfig: { entryPoint: "tab", modeId: "mode-1", channel: "tmux" },
    });
    expect(res.worktreeId).toBe("wt-1");
    expect(state.mock.calls.some((c) => c[0]?.sessionId === d.id && c[0]?.state === "not_started")).toBe(true);
    const ev = updated.mock.calls.find((c) => c[0]?.sessionId === d.id)?.[0];
    expect(ev?.name).toBe("Plan this feature with Claude");
    expect(ev?.channel).toBe("tmux");
    const s = (await api.listSessions("wt-1")).find((x) => x.id === d.id);
    expect(s?.modeId).toBe("mode-1");
    offState();
    offUpdated();
  });

  it("__test.removeSession also drops the session's chat transcript", async () => {
    const api = createMockApi();
    api.__test.pushChatEvent("sess-x", {
      id: "e1",
      sessionId: "sess-x",
      ts: new Date().toISOString(),
      provider: "opencode",
      kind: "text",
      role: "assistant",
      text: "hi",
    });
    expect((await api.getTranscript("sess-x")).events).toHaveLength(1);
    api.__test.removeSession("sess-x");
    expect((await api.getTranscript("sess-x")).events).toHaveLength(0);
  });

  it("3.4 createMockApi() with no arg still lists proj-a (default behavior unchanged)", async () => {
    const api = createMockApi();
    const ps = await api.listProjects();
    expect(ps.some((p) => p.id === "proj-a")).toBe(true);
  });

  it("retry/dismiss of a failed scheduled message resolve ok", async () => {
    const api = createMockApi();
    await expect(api.retryScheduledMessage("sess-main", "f1")).resolves.toEqual({ ok: true });
    await expect(api.dismissScheduledMessage("sess-main", "f1")).resolves.toEqual({ ok: true });
  });
});
