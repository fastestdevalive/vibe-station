import { describe, it, expect, vi } from "vitest";
import { createMockApi } from "./mock";
import { MOCK_ACCOUNT_IDS } from "./mockAccounts";
import type { NormalizedEvent, Project, Session } from "./types";

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

  it("2.T5 pin prepends to pinned-all and emits the list event before the entity event; unpin removes", async () => {
    const api = createMockApi();
    const order: string[] = [];
    const off = api.on("*" as never, (ev) => {
      if (ev.type === "orderedList:updated" || ev.type === "worktree:updated") order.push(ev.type);
    });

    await api.pinWorktree("wt-1");
    expect(order).toEqual(["orderedList:updated", "worktree:updated"]);
    expect((await api.getOrderedList("pinned-all")).itemIds).toEqual(["wt-1"]);

    await api.pinWorktree("wt-2");
    expect((await api.getOrderedList("pinned-all")).itemIds).toEqual(["wt-2", "wt-1"]);

    // Already pinned: no change, no event.
    order.length = 0;
    await api.pinWorktree("wt-2");
    expect(order).toEqual([]);

    await api.unpinWorktree("wt-2");
    expect((await api.getOrderedList("pinned-all")).itemIds).toEqual(["wt-1"]);
    await api.pinWorktree("wt-2");
    expect((await api.getOrderedList("pinned-all")).itemIds[0]).toBe("wt-2");
    off();
  });

  it("2.T5b pin seeds unlisted pins newest-first and pinned stamps never tie", async () => {
    const api = createMockApi();
    const a = await api.pinWorktree("wt-1");
    const b = await api.pinWorktree("wt-2");
    expect(b.worktree.pinnedAt! > a.worktree.pinnedAt!).toBe(true);
    // Drop the list as if an old client had written nothing, then pin a third.
    await api.setOrderedList("pinned-all", []);
    await api.pinWorktree("wt-3");
    expect((await api.getOrderedList("pinned-all")).itemIds).toEqual(["wt-3", "wt-2", "wt-1"]);
  });

  it("2.T5c session pin: direct agents enter the list (chain head id), worktree sessions do not", async () => {
    const api = createMockApi();
    const direct = await api.createDirectSession({
      target: "direct",
      projectId: "proj-a",
      type: "agent",
      name: "d",
    });
    await api.pinSession(direct.id, true);
    expect((await api.getOrderedList("pinned-all")).itemIds).toEqual([direct.id]);
    await api.pinSession("sess-main", true); // inside wt-1
    expect((await api.getOrderedList("pinned-all")).itemIds).toEqual([direct.id]);
    await api.pinSession(direct.id, false);
    expect((await api.getOrderedList("pinned-all")).itemIds).toEqual([]);
  });

  it("2.T5d legacy mode: 400 invalid scope key for projects, pin leaves the list untouched", async () => {
    const api = createMockApi({ legacyOrderedLists: true });
    await expect(api.getOrderedList("projects")).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("invalid scope key"),
    });
    await expect(api.setOrderedList("projects", ["a"])).rejects.toMatchObject({ status: 400 });
    await api.pinWorktree("wt-1");
    expect(await api.getOrderedList("pinned-all")).toMatchObject({ itemIds: [], updatedAt: null });
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

  it("resetSession records the carry mode on the archived session", async () => {
    const api = createMockApi();
    await api.resetSession("sess-main", { carryOver: "transcript" });
    const sessions = await api.listSessions("wt-1");
    expect(sessions.find((s) => s.id === "sess-main")?.carryOver).toBe("transcript");
  });

  it("resetSession carries the pin to the replacement, in daemon event order", async () => {
    const api = createMockApi();
    await api.pinSession("sess-main", true);
    const pinnedAt = (await api.listSessions("wt-1")).find((s) => s.id === "sess-main")?.pinnedAt;
    expect(pinnedAt).toBeTruthy();
    // The mock's pinSession doesn't touch the list; seed the daemon's pinned-all slot directly.
    await api.setOrderedList("pinned-all", ["x", "sess-main"]);

    const order: string[] = [];
    const offs = [
      api.on("orderedList:updated", (ev) => {
        if (ev.type === "orderedList:updated" && ev.scopeKey === "pinned-all") order.push("list");
      }),
      api.on("session:created", () => order.push("created")),
      api.on("session:updated", (ev) => {
        if (ev.type === "session:updated" && ev.sessionId === "sess-main") {
          order.push(ev.pinnedAt === null ? "old-cleared" : "old");
        }
      }),
    ];
    const res = await api.resetSession("sess-main");
    offs.forEach((off) => off());

    const sessions = await api.listSessions("wt-1");
    expect(sessions.find((s) => s.id === "sess-main")?.pinnedAt).toBeNull();
    expect(sessions.find((s) => s.id === res.newSessionId)?.pinnedAt).toBe(pinnedAt);
    expect(order).toEqual(["list", "created", "old-cleared"]);
    expect((await api.getOrderedList("pinned-all")).itemIds).toEqual(["x", res.newSessionId]);

    // pin on the superseded id acts on the live head
    await api.pinSession("sess-main", false);
    const after = await api.listSessions("wt-1");
    expect(after.find((s) => s.id === res.newSessionId)?.pinnedAt).toBeNull();
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

  describe("setSessionChannel", () => {
    it("switches to json with modeId, updating mode and emitting session:updated with modeId/modeIcon", async () => {
      const api = createMockApi();
      const updated = vi.fn();
      const off = api.on("session:updated", updated);

      const res = await api.setSessionChannel("sess-main", "json", "mode-1");
      expect(res.ok).toBe(true);
      expect(res.channel).toBe("json");

      const s = (await api.listSessions("wt-1")).find((x) => x.id === "sess-main");
      expect(s?.channel).toBe("json");
      expect(s?.modeId).toBe("mode-1");
      expect(s?.modeIcon).toBe("claude");

      expect(updated).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "session:updated",
          sessionId: "sess-main",
          channel: "json",
          modeId: "mode-1",
          modeIcon: "claude",
        }),
      );
      off();
    });

    it("throws ApiError code mode_not_found when modeId does not exist", async () => {
      const api = createMockApi();
      await expect(api.setSessionChannel("sess-main", "json", "unknown-mode")).rejects.toMatchObject({
        status: 400,
        code: "mode_not_found",
      });
    });

    it("throws ApiError code no_mode when session has no mode and no modeId is supplied", async () => {
      const api = createMockApi();
      api.__test.removeSession("sess-main");
      api.__test.addSession({
        id: "sess-main",
        worktreeId: "wt-1",
        projectId: "proj-a",
        modeId: null,
        type: "agent",
        isMain: true,
        state: "working",
        lifecycleState: "working",
        tmuxName: "sess-main",
        createdAt: new Date().toISOString(),
        sortOrder: 1,
      });

      await expect(api.setSessionChannel("sess-main", "json")).rejects.toMatchObject({
        status: 400,
        code: "no_mode",
      });
    });

    it("throws ApiError code mode_not_found when session mode is deleted and no modeId is supplied", async () => {
      const api = createMockApi();
      api.__test.removeSession("sess-main");
      api.__test.addSession({
        id: "sess-main",
        worktreeId: "wt-1",
        projectId: "proj-a",
        modeId: "deleted-mode",
        type: "agent",
        isMain: true,
        state: "working",
        lifecycleState: "working",
        tmuxName: "sess-main",
        createdAt: new Date().toISOString(),
        sortOrder: 1,
      });

      await expect(api.setSessionChannel("sess-main", "json")).rejects.toMatchObject({
        status: 400,
        code: "mode_not_found",
      });
    });

    it("switches to json without modeId when session mode exists", async () => {
      const api = createMockApi();
      const updated = vi.fn();
      const off = api.on("session:updated", updated);
      const s = (await api.listSessions("wt-1")).find((x) => x.id === "sess-main");
      // Precondition: the seed's sess-main already has a valid mode. (listSessions
      // returns a clone, so mutating `s` here would be a silent no-op — review #20.)
      expect(s?.modeId).toBe("mode-1");

      const res = await api.setSessionChannel("sess-main", "json");
      expect(res.ok).toBe(true);
      expect(res.channel).toBe("json");

      // Valid-mode no-change contract: the emitted session:updated has no modeId
      // key (the mode is unchanged when none is supplied).
      const ev = updated.mock.calls.find((c) => c[0]?.type === "session:updated")?.[0];
      expect(ev).toBeDefined();
      expect(ev.modeId).toBeUndefined();
      expect(ev.modeIcon).toBeUndefined();
      off();
    });
  });

  describe("chat mentions in mock API", () => {
    it("sendChat with mentions echoes them on the user event, and beginEditQueuedTurn returns them", async () => {
      const api = createMockApi();
      const mentions = [{ kind: "file" as const, id: "src/a.ts", label: "a.ts" }];
      const msgHandler = vi.fn();
      const off = api.on("session:message", msgHandler);

      const res = await api.sendChat("sess-main", "see @src/a.ts", undefined, false, mentions);
      expect(res.turnId).toBeDefined();

      const userMsg = msgHandler.mock.calls.find(
        (c) => c[0]?.type === "session:message" && c[0]?.event?.kind === "user",
      )?.[0];
      expect(userMsg).toBeDefined();
      expect(userMsg.event.mentions).toEqual(mentions);

      const editRes = await api.beginEditQueuedTurn("sess-main", res.turnId);
      expect(editRes.turnId).toBe(res.turnId);
      expect(editRes.message).toBe("see @src/a.ts");
      expect(editRes.mentions).toEqual(mentions);

      off();
    });
  });

  it("fileSearch project scope returns the project's worktree files", async () => {
    const api = createMockApi();
    const wts = await api.listWorktrees();
    const projectId = wts[0]!.projectId;
    const res = await api.fileSearch(projectId, "app", 50, undefined, "project");
    expect(res.files.length).toBeGreaterThan(0);
  });
});

describe("mock reset carry modes / cancel (2.T6)", () => {
  function jsonSession(id: string, modeId: string) {
    return {
      id,
      worktreeId: "wt-1",
      projectId: "proj-a",
      modeId,
      type: "agent",
      isMain: false,
      state: "idle",
      lifecycleState: "idle",
      tmuxName: id,
      channel: "json",
      createdAt: new Date(0).toISOString(),
    } as Session;
  }

  async function replay(api: ReturnType<typeof createMockApi>, sessionId: string) {
    const events: NormalizedEvent[] = [];
    const off = api.on("chat:replay", (ev) => {
      if (ev.type === "chat:replay" && ev.sessionId === sessionId) events.push(...ev.events);
    });
    await api.openChat(sessionId);
    off();
    return events;
  }

  it("carryOver none copies nothing and appends no session_break", async () => {
    const api = createMockApi();
    api.__test.addSession(jsonSession("sess-none", "mode-1"));
    api.__test.pushChatEvent("sess-none", {
      id: "u1",
      sessionId: "sess-none",
      ts: "",
      provider: "claude",
      kind: "user",
      text: "hi",
      turnId: "t1",
    });
    const res = await api.resetSession("sess-none", { carryOver: "none" });
    expect(res.carryOver).toBe("none");
    expect(res.breakKind).toBeUndefined();
    const events = await replay(api, res.newSessionId);
    expect(events).toHaveLength(0);
  });

  it("summary carries rows plus a break marker with mode names and summary text", async () => {
    const api = createMockApi();
    api.__test.addSession(jsonSession("sess-sum", "mode-1"));
    api.__test.pushChatEvent("sess-sum", {
      id: "u1",
      sessionId: "sess-sum",
      ts: "",
      provider: "claude",
      kind: "user",
      text: "hi",
      turnId: "t1",
    });
    const res = await api.resetSession("sess-sum", { carryOver: "summary" });
    expect(res.carryOver).toBe("summary");
    expect(res.breakKind).toBe("reset");
    const events = await replay(api, res.newSessionId);
    const brk = events.find((e) => e.kind === "session_break");
    expect(brk).toBeTruthy();
    expect(brk!.carryOver).toBe("summary");
    expect(brk!.fromMode).toBe("Bugfix");
    expect(brk!.toMode).toBe("Bugfix");
    expect(brk!.text).toBeTruthy();
    expect(events.some((e) => e.kind === "user" && e.text === "hi")).toBe(true);
  });

  it("same-CLI different mode is a switch (breakKind + from/to mode names)", async () => {
    const api = createMockApi();
    api.__test.seedModes([
      { id: "mode-1", name: "Bugfix", cli: "claude", context: "" },
      { id: "mode-3", name: "Reviewer", cli: "claude", context: "" },
    ]);
    api.__test.addSession(jsonSession("sess-sw", "mode-1"));
    api.__test.pushChatEvent("sess-sw", {
      id: "u1",
      sessionId: "sess-sw",
      ts: "",
      provider: "claude",
      kind: "user",
      text: "hi",
      turnId: "t1",
    });
    const res = await api.resetSession("sess-sw", { carryOver: "summary", modeId: "mode-3" });
    expect(res.breakKind).toBe("switch");
    const events = await replay(api, res.newSessionId);
    const brk = events.find((e) => e.kind === "session_break")!;
    expect(brk.breakKind).toBe("switch");
    expect(brk.fromMode).toBe("Bugfix");
    expect(brk.toMode).toBe("Reviewer");
  });

  it("transcript carries an instruction text and no summary on the archived row", async () => {
    const api = createMockApi();
    api.__test.addSession(jsonSession("sess-tr", "mode-1"));
    api.__test.pushChatEvent("sess-tr", {
      id: "u1",
      sessionId: "sess-tr",
      ts: "",
      provider: "claude",
      kind: "user",
      text: "hi",
      turnId: "t1",
    });
    const res = await api.resetSession("sess-tr", { carryOver: "transcript" });
    const events = await replay(api, res.newSessionId);
    const brk = events.find((e) => e.kind === "session_break")!;
    expect(brk.carryOver).toBe("transcript");
    expect(brk.text).toContain("previous-chat.md");
  });

  it("cancel during the summary wait rejects with reset_cancelled and leaves the session live", async () => {
    const api = createMockApi();
    api.__test.addSession(jsonSession("sess-cancel", "mode-1"));
    const pending = api.resetSession("sess-cancel", { carryOver: "summary" });
    await new Promise((r) => setTimeout(r, 100));
    expect(await api.cancelReset("sess-cancel")).toEqual({ ok: true, cancelled: true });
    await expect(pending).rejects.toMatchObject({ code: "reset_cancelled" });
    const sessions = await api.listSessions("wt-1");
    expect(sessions.find((s) => s.id === "sess-cancel")?.archivedAt).toBeFalsy();
  });

  it("cancelReset returns false when nothing is in flight", async () => {
    const api = createMockApi();
    expect(await api.cancelReset("sess-main")).toEqual({ ok: true, cancelled: false });
  });
});

describe("mock api scheduled sends", () => {
  const future = () => new Date(Date.now() + 3_600_000).toISOString();

  it("getScheduledMessages is empty, schedule pushes a tmux row, cancel removes it", async () => {
    const api = createMockApi({ simulateOutput: false });
    expect(await api.getScheduledMessages("sess-main")).toEqual({
      scheduledSends: [],
      scheduledFailed: [],
      scheduledSent: [],
    });
    const events: unknown[] = [];
    const off = api.on("session:scheduled", (e) => events.push(e));
    const { id } = await api.scheduleMessage("sess-main", "/review", future());
    const snap = await api.getScheduledMessages("sess-main");
    expect(snap.scheduledSends).toEqual([
      expect.objectContaining({ id, message: "/review", channel: "tmux", phase: "scheduled" }),
    ]);
    expect(events).toHaveLength(1);
    await api.cancelScheduledMessage("sess-main", id);
    expect((await api.getScheduledMessages("sess-main")).scheduledSends).toEqual([]);
    off();
  });

  it("rejects a past time and an unsupported CLI with a typed code", async () => {
    const api = createMockApi({ simulateOutput: false });
    await expect(api.scheduleMessage("sess-main", "x", new Date(Date.now() - 1000).toISOString())).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const modes = await api.listModes();
    const other = modes.find((m) => m.cli !== "claude");
    if (other) {
      api.__test.addSession({ ...(await api.listSessions("wt-1"))[0]!, id: "sess-other", modeId: other.id });
      await expect(api.scheduleMessage("sess-other", "x", future())).rejects.toMatchObject({
        code: "TERMINAL_DELIVERY_UNSUPPORTED",
      });
    }
  });

  it("scheduling support follows the CLI list's supportsTerminalDelivery flag, not a CLI name (review 25c)", async () => {
    const api = createMockApi({ simulateOutput: false });
    const modes = await api.listModes();
    const other = modes.find((m) => m.cli !== "claude")!;
    api.__test.addSession({ ...(await api.listSessions("wt-1"))[0]!, id: "sess-flag", modeId: other.id });
    const clis = await api.getSupportedClis();
    vi.spyOn(api, "getSupportedClis").mockResolvedValue(
      clis.map((c) => (c.id === other.cli ? { ...c, supportsTerminalDelivery: true } : c)),
    );
    await expect(api.scheduleMessage("sess-flag", "x", future())).resolves.toMatchObject({ id: expect.any(String) });
  });

  it("send-now on a tmux row finishes as a pasted row; retry and dismiss work on failed rows", async () => {
    const api = createMockApi({ simulateOutput: false });
    const { id } = await api.scheduleMessage("sess-main", "go", future());
    await api.sendScheduledNow("sess-main", id);
    const snap = await api.getScheduledMessages("sess-main");
    expect(snap.scheduledSends).toEqual([]);
    expect(snap.scheduledSent).toEqual([expect.objectContaining({ id, message: "go", channel: "tmux" })]);

    api.mockSetScheduleSnapshot("sess-main", {
      scheduledSends: [],
      scheduledFailed: [
        { id: "f1", message: "a", fireAt: future(), failureReason: "x", failureKind: "timed_out", channel: "tmux" },
        { id: "f2", message: "b", fireAt: future(), failureReason: "y" },
      ],
      scheduledSent: [],
    });
    await api.retryScheduledMessage("sess-main", "f1");
    await api.dismissScheduledMessage("sess-main", "f2");
    const after = await api.getScheduledMessages("sess-main");
    expect(after.scheduledFailed).toEqual([]);
    expect(after.scheduledSends).toEqual([expect.objectContaining({ id: "f1", channel: "tmux", phase: "scheduled" })]);
  });
});

/**
 * Accounts fixtures (plan B1.T5) — the mock owns an in-memory account list and
 * pushes the same `account:*` events the daemon broadcasts.
 */
describe("mock accounts", () => {
  it("createApiKeyAccount emits account:updated and lists the new row", async () => {
    const api = createMockApi();
    const updated = vi.fn();
    const off = api.on("account:updated", updated);

    const acct = await api.createApiKeyAccount({
      cli: "cursor",
      method: "api_key",
      apiKey: "sk-mock-key",
      label: "Second key",
    });

    expect(acct.cli).toBe("cursor");
    expect(acct.method).toBe("api_key");
    expect(acct.displayName).toBe("Second key");
    expect(acct.auth).toBe("signed_in");
    expect(updated).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "account:updated",
        account: expect.objectContaining({ id: acct.id, cli: "cursor", label: "Second key" }),
      }),
    );
    const rows = await api.getAccounts();
    expect(rows.some((a) => a.cli === "cursor" && a.id === acct.id)).toBe(true);
    off();
  });

  it("removeAccount emits account:removed and stops listing the account", async () => {
    const api = createMockApi();
    const removed = vi.fn();
    const off = api.on("account:removed", removed);

    const res = await api.removeAccount("claude", MOCK_ACCOUNT_IDS.claudeWork);

    expect(res.ok).toBe(true);
    expect(res.stoppedSessionIds).toEqual(["sess-work-1"]);
    expect(removed).toHaveBeenCalledWith(
      expect.objectContaining({ type: "account:removed", cli: "claude", accountId: MOCK_ACCOUNT_IDS.claudeWork }),
    );
    const rows = await api.getAccounts();
    expect(rows.some((a) => a.id === MOCK_ACCOUNT_IDS.claudeWork)).toBe(false);
    off();
  });

  it("renameAccount to an existing name rejects label_taken (case-insensitive)", async () => {
    const api = createMockApi();
    await expect(
      api.renameAccount("claude", MOCK_ACCOUNT_IDS.claudeSide, "Work"),
    ).rejects.toMatchObject({ code: "label_taken" });
    await expect(
      api.renameAccount("claude", MOCK_ACCOUNT_IDS.claudeSide, "work"),
    ).rejects.toMatchObject({ code: "label_taken" });
  });

  it("mock_validate_path_five_codes", async () => {
    const api = createMockApi();
    const check = (dir: string) => api.validateAccountPath({ cli: "claude", mode: "choose", dir });
    await expect(check("relative/path")).rejects.toMatchObject({ code: "path_invalid" });
    await expect(check("~/a/../b")).rejects.toMatchObject({ code: "path_invalid" });
    await expect(check("~/.claude")).rejects.toMatchObject({ code: "folder_is_system" });
    await expect(check("~/.claude-side")).rejects.toMatchObject({
      code: "folder_duplicate",
      accountId: MOCK_ACCOUNT_IDS.claudeSide,
    });
    await expect(check("~/.vibe-station/accounts/claude/other")).rejects.toMatchObject({
      code: "folder_in_accounts_root",
    });
    await expect(check("~/code/nope")).rejects.toMatchObject({ code: "folder_not_found" });
    await expect(check("~/code/fine")).resolves.toMatchObject({ dir: "~/code/fine", looksValid: true });
  });

  it("mock_add_folder_signed_in_vs_pending", async () => {
    const api = createMockApi();
    const signedIn = await api.addFolderAccount({ cli: "claude", mode: "choose", dir: "~/code/work-folder" });
    expect(signedIn.signedIn).toBe(true);
    expect(signedIn.account.pending).toBe(false);
    expect(signedIn.account.createdByUs).toBe(false);

    const pending = await api.addFolderAccount({ cli: "claude", mode: "choose", dir: "~/code/side-two" });
    expect(pending.signedIn).toBe(false);
    expect(pending.account.pending).toBe(true);
    expect(pending.account.signIn?.command).toBe("CLAUDE_CONFIG_DIR=~/code/side-two claude auth login");
    expect((await api.getAccounts()).some((a) => a.id === pending.account.id && a.pending)).toBe(true);
  });

  it("mock_refresh_completes_pending_on_second_call", async () => {
    const api = createMockApi();
    const { account } = await api.addFolderAccount({ cli: "claude", mode: "choose", dir: "~/code/side-three" });
    const updated = vi.fn();
    const off = api.on("account:updated", updated);
    const first = await api.refreshAccount("claude", account.id);
    expect(first.pending).toBe(true);
    const second = await api.refreshAccount("claude", account.id);
    expect(second.pending).toBe(false);
    expect(second.signIn ?? null).toBeNull();
    expect(updated).toHaveBeenCalledWith(expect.objectContaining({ type: "account:updated" }));
    off();
  });

  it("mock_refresh_completes_unverifiable_pending_at_once", async () => {
    const api = createMockApi();
    const { account } = await api.addFolderAccount({ cli: "pi", mode: "choose", dir: "~/code/pi-one" });
    expect(account.signIn?.hint).toBe("Run the command, then use /login inside.");
    const done = await api.refreshAccount("pi", account.id);
    expect(done.pending).toBe(false);
  });

  it("mock_remove_reports_folder_deleted", async () => {
    const api = createMockApi();
    expect((await api.removeAccount("claude", MOCK_ACCOUNT_IDS.claudeWork)).folderDeleted).toBe(true);
    expect((await api.removeAccount("claude", MOCK_ACCOUNT_IDS.claudeSide)).folderDeleted).toBe(false);
  });

  it("mock_fs_complete_dot_last_and_case_insensitive", async () => {
    const api = createMockApi();
    const names = async (path: string) => (await api.fsComplete(path)).entries.map((e) => e.name);
    expect(await names("/home/user/code/")).toEqual(["Fast-notes", "fastestdevalive", "other", ".cache"]);
    expect(await names("/home/user/code/.")).toEqual([".cache"]);
    expect(await names("/home/user/code/FAST")).toEqual(["Fast-notes", "fastestdevalive"]);
    expect(await names("~")).toEqual(["code", "projects", "work"]);
  });

  it("createWorktree puts an explicit accountId on the worktree's main session", async () => {
    const api = createMockApi();
    const wt = await api.createWorktree({
      projectId: "proj-a",
      modeId: "mode-1",
      accountId: MOCK_ACCOUNT_IDS.claudeWork,
    });
    expect(wt.mainSessionId).toBeTruthy();
    const main = (await api.listSessions(wt.id)).find((s) => s.isMain);
    expect(main?.id).toBe(wt.mainSessionId);
    expect(main?.accountId).toBe(MOCK_ACCOUNT_IDS.claudeWork);
  });

  it("createWorktree leaves the main session's account unset when no accountId is sent", async () => {
    const api = createMockApi();
    const wt = await api.createWorktree({ projectId: "proj-a", modeId: "mode-1" });
    const main = (await api.listSessions(wt.id)).find((s) => s.isMain);
    expect(main?.accountId).toBeUndefined();
  });

  it("createWorktree treats an explicit \"system\" pick as no accountId", async () => {
    const api = createMockApi();
    const wt = await api.createWorktree({ projectId: "proj-a", modeId: "mode-1", accountId: "system" });
    const main = (await api.listSessions(wt.id)).find((s) => s.isMain);
    expect(main?.accountId).toBeUndefined();
  });
});
