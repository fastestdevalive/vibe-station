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
});
