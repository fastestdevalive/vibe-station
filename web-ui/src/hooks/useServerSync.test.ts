import { renderHook, waitFor, act } from "@testing-library/react";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import type { ApiInstance } from "@/api";
import type { Session } from "@/api/types";
import { useServerSync } from "./useServerSync";
import { useServerStore } from "./useServerStore";
import { useWorkspaceStore, DEFAULT_WORKTREE_LAYOUT } from "./useStore";

/**
 * 1.T4 — the daemon already broadcasts `name`/`archivedAt` (and now
 * `sortOrder`) on `session:updated`; the client used to drop them (Research,
 * Superseded row). Verify the patch-building `if` chain in useServerSync.ts
 * applies each field when present, and leaves it alone when absent.
 */
describe("useServerSync — session:updated reconciliation", () => {
  beforeEach(() => {
    useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
  });

  it("applies name and archivedAt from a session:updated event", async () => {
    const api = createMockApi();
    renderHook(() => useServerSync(api));

    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    act(() => {
      api.__test.emit({
        type: "session:updated",
        sessionId: "sess-main",
        name: "renamed-session",
        archivedAt: "2026-01-01T00:00:00.000Z",
      });
    });

    await waitFor(() => {
      const s = useServerStore.getState().sessions.find((x) => x.id === "sess-main");
      expect(s?.name).toBe("renamed-session");
      expect(s?.archivedAt).toBe("2026-01-01T00:00:00.000Z");
    });
  });

  it("clears name back to null when the event carries name: null", async () => {
    const api = createMockApi();
    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    act(() => {
      api.__test.emit({ type: "session:updated", sessionId: "sess-main", name: null });
    });

    await waitFor(() => {
      const s = useServerStore.getState().sessions.find((x) => x.id === "sess-main");
      expect(s?.name).toBeNull();
    });
  });

  it("applies sortOrder from a session:updated event", async () => {
    const api = createMockApi();
    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    act(() => {
      api.__test.emit({ type: "session:updated", sessionId: "sess-main", sortOrder: 42 });
    });

    await waitFor(() => {
      const s = useServerStore.getState().sessions.find((x) => x.id === "sess-main");
      expect(s?.sortOrder).toBe(42);
    });
  });

  it("M4 (A2.2) — applies isMain from a session:updated event (main-session promotion, Fix 1)", async () => {
    const api = createMockApi();
    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    const before = useServerStore.getState().sessions.find((x) => x.id === "sess-agent2");
    expect(before?.isMain).toBeFalsy();

    act(() => {
      api.__test.emit({ type: "session:updated", sessionId: "sess-agent2", isMain: true });
    });

    await waitFor(() => {
      const s = useServerStore.getState().sessions.find((x) => x.id === "sess-agent2");
      expect(s?.isMain).toBe(true);
    });
  });

  it("leaves unrelated fields untouched when only pinnedAt is present", async () => {
    const api = createMockApi();
    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    const before = useServerStore.getState().sessions.find((x) => x.id === "sess-main");

    act(() => {
      api.__test.emit({ type: "session:updated", sessionId: "sess-main", pinnedAt: "2026-01-01T00:00:00.000Z" });
    });

    await waitFor(() => {
      const s = useServerStore.getState().sessions.find((x) => x.id === "sess-main");
      expect(s?.pinnedAt).toBe("2026-01-01T00:00:00.000Z");
    });
    const after = useServerStore.getState().sessions.find((x) => x.id === "sess-main");
    expect(after?.name).toBe(before?.name);
    expect(after?.archivedAt).toBe(before?.archivedAt);
  });
});

// --- Phase 4c: auto-insert a tile for a session:created carrying parentSessionId
// (agent-interaction-workspaces/04-workspaces) ---
describe("useServerSync — session:created auto-insert (Phase 4c)", () => {
  const DOC_ID = "doc-1";
  const SOURCE_ID = "sess-source";

  function seedOneMatchingDoc() {
    useWorkspaceStore.setState({
      workspaceDocs: {
        [DOC_ID]: {
          id: DOC_ID,
          name: "Review Sprint",
          contextKey: "wt-1",
          mode: "free",
          tiles: [{ id: "tile-source", kind: "agent", sessionId: SOURCE_ID }],
          tree: null,
          freeRects: { "tile-source": { x: 0, y: 0, w: 40, h: 40 } },
        },
      },
    });
  }

  /** The everyday canvas: a per-worktree TRANSIENT canvas, not a saved doc. */
  function seedScratch(worktreeId: string) {
    useWorkspaceStore.setState({
      layoutByWorktree: {
        [worktreeId]: {
          ...DEFAULT_WORKTREE_LAYOUT,
          scratchCanvas: {
            mode: "free",
            tiles: [{ id: "tile-source", kind: "agent", sessionId: SOURCE_ID }],
            tree: null,
            freeRects: { "tile-source": { x: 0, y: 0, w: 40, h: 40 } },
          },
        },
      },
    });
  }

  beforeEach(() => {
    useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
    useWorkspaceStore.setState({ workspaceDocs: {}, layoutByWorktree: {} });
  });

  /**
   * The source session these fixtures tile (`sess-source`) is not registered in
   * the mock's own session store, so Phase 2's refetch pruning would treat its
   * tile as a ghost and prune it on mount. Register it in the fetched list so
   * the tile legitimately survives — mirroring production, where a tiled source
   * session IS part of the REST session list.
   */
  async function mockSourcePresent(api: ApiInstance) {
    const defaults = await api.listSessions();
    const source: Session = {
      id: SOURCE_ID,
      worktreeId: "wt-1",
      projectId: "proj-a",
      modeId: "mode-1",
      type: "agent",
      isMain: false,
      state: "working",
      lifecycleState: "working",
      tmuxName: SOURCE_ID,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    vi.spyOn(api, "listSessions").mockResolvedValue([...defaults, source]);
  }

  it("4c.T1 — a session:created with parentSessionId matching exactly one workspace's tile auto-inserts a new tile there", async () => {
    seedOneMatchingDoc();
    const api = createMockApi();
    await mockSourcePresent(api);
    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    act(() => {
      api.__test.emit({
        type: "session:created",
        sessionId: "sess-new",
        worktreeId: "wt-1",
        sessionType: "agent",
        parentSessionId: SOURCE_ID,
      });
    });

    await waitFor(() => {
      const doc = useWorkspaceStore.getState().workspaceDocs[DOC_ID]!;
      expect(doc.tiles.some((t) => t.sessionId === "sess-new")).toBe(true);
      expect(doc.tiles).toHaveLength(2);
    });
  });

  it("4c.T2 — a session:created with parentSessionId matching no tile anywhere results in no tile insert, no error (S5)", async () => {
    seedOneMatchingDoc();
    const api = createMockApi();
    await mockSourcePresent(api);
    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    act(() => {
      api.__test.emit({
        type: "session:created",
        sessionId: "sess-new",
        worktreeId: "wt-1",
        sessionType: "agent",
        parentSessionId: "sess-nobody-tiles-this",
      });
    });

    // Give any (incorrectly-scheduled) insert a chance, then confirm nothing changed.
    await new Promise((r) => setTimeout(r, 50));
    const doc = useWorkspaceStore.getState().workspaceDocs[DOC_ID]!;
    expect(doc.tiles).toHaveLength(1);
  });

  it("4c.T3 — a session:created with parentSessionId absent behaves identically to pre-Phase-4 (no scan attempted, CUJ 6)", async () => {
    seedOneMatchingDoc();
    const api = createMockApi();
    await mockSourcePresent(api);
    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    act(() => {
      api.__test.emit({
        type: "session:created",
        sessionId: "sess-new",
        worktreeId: "wt-1",
        sessionType: "agent",
        // parentSessionId omitted entirely — old-daemon / no-source create.
      });
    });

    await new Promise((r) => setTimeout(r, 50));
    const doc = useWorkspaceStore.getState().workspaceDocs[DOC_ID]!;
    expect(doc.tiles).toHaveLength(1);
  });

  it("inserts into EVERY workspace tiling the source — no skip-on-multi-match (Risk #9/#10 resolved)", async () => {
    seedOneMatchingDoc();
    useWorkspaceStore.setState((s) => ({
      workspaceDocs: {
        ...s.workspaceDocs,
        "doc-2": {
          id: "doc-2",
          name: "Also has it",
          contextKey: "wt-1",
          mode: "free",
          tiles: [{ id: "tile-source-2", kind: "agent", sessionId: SOURCE_ID }],
          tree: null,
          freeRects: {},
        },
      },
    }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = createMockApi();
    await mockSourcePresent(api);
    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    act(() => {
      api.__test.emit({
        type: "session:created",
        sessionId: "sess-new",
        worktreeId: "wt-1",
        sessionType: "agent",
        parentSessionId: SOURCE_ID,
      });
    });

    await waitFor(() => {
      expect(useWorkspaceStore.getState().workspaceDocs[DOC_ID]!.tiles).toHaveLength(2);
      expect(useWorkspaceStore.getState().workspaceDocs["doc-2"]!.tiles).toHaveLength(2);
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("auto-inserts a SAME-worktree child into the source worktree's scratch canvas", async () => {
    seedScratch("wt-1");
    const api = createMockApi();
    await mockSourcePresent(api);
    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    act(() => {
      api.__test.emit({
        type: "session:created",
        sessionId: "sess-new",
        worktreeId: "wt-1",
        sessionType: "agent",
        parentSessionId: SOURCE_ID,
      });
    });

    await waitFor(() => {
      const canvas = useWorkspaceStore.getState().layoutByWorktree["wt-1"]!.scratchCanvas!;
      expect(canvas.tiles).toHaveLength(2);
      const added = canvas.tiles.find((t) => t.sessionId === "sess-new")!;
      expect(added.kind).toBe("agent");
      // Same worktree as the canvas → left undefined, matching the existing
      // same-context tile shape.
      expect(added.worktreeId).toBeUndefined();
    });
  });

  it("auto-inserts a CROSS-worktree child into the source worktree's scratch canvas, stamped with its own worktreeId", async () => {
    seedScratch("wt-1");
    const api = createMockApi();
    await mockSourcePresent(api);
    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    act(() => {
      api.__test.emit({
        type: "session:created",
        sessionId: "sess-new",
        // `vst worktree create` — the child lives in a DIFFERENT worktree, but
        // still lands next to its parent's tile.
        worktreeId: "wt-2",
        sessionType: "agent",
        parentSessionId: SOURCE_ID,
      });
    });

    await waitFor(() => {
      const canvas = useWorkspaceStore.getState().layoutByWorktree["wt-1"]!.scratchCanvas!;
      expect(canvas.tiles).toHaveLength(2);
      expect(canvas.tiles.find((t) => t.sessionId === "sess-new")!.worktreeId).toBe("wt-2");
    });
  });

  it("inserts into the scratch canvas AND every matching saved doc at once", async () => {
    seedScratch("wt-1");
    seedOneMatchingDoc();
    const api = createMockApi();
    await mockSourcePresent(api);
    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    act(() => {
      api.__test.emit({
        type: "session:created",
        sessionId: "sess-new",
        worktreeId: "wt-1",
        sessionType: "agent",
        parentSessionId: SOURCE_ID,
      });
    });

    await waitFor(() => {
      expect(
        useWorkspaceStore.getState().layoutByWorktree["wt-1"]!.scratchCanvas!.tiles,
      ).toHaveLength(2);
      expect(useWorkspaceStore.getState().workspaceDocs[DOC_ID]!.tiles).toHaveLength(2);
    });
  });
});

// --- pinned-order-sync: mount-time migration/hydration + WS reducer ---
describe("useServerSync — pinned order sync", () => {
  beforeEach(() => {
    useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
    useWorkspaceStore.setState({ sortOrders: {} });
  });

  it("2.T2 pushes an existing local order to the daemon when the server has none yet", async () => {
    useWorkspaceStore.setState({ sortOrders: { "pinned-all": ["a", "b"] } });
    const api = createMockApi();
    const setOrderedListSpy = vi.spyOn(api, "setOrderedList");
    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    await waitFor(() => {
      expect(setOrderedListSpy).toHaveBeenCalledWith("pinned-all", ["a", "b"]);
    });
  });

  it("2.T3 hydrates local sortOrders from an existing daemon-side order, overriding stale local state", async () => {
    useWorkspaceStore.setState({ sortOrders: { "pinned-all": ["stale"] } });
    const api = createMockApi();
    await api.setOrderedList("pinned-all", ["c", "d"]);
    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    await waitFor(() => {
      expect(useWorkspaceStore.getState().sortOrders["pinned-all"]).toEqual(["c", "d"]);
    });
  });

  it("2.T4 applies an orderedList:updated WS event for pinned-all, ignores other scopeKeys", async () => {
    const api = createMockApi();
    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    act(() => {
      api.__test.emit({
        type: "orderedList:updated",
        scopeKey: "pinned-all",
        itemIds: ["x", "y"],
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
    });
    await waitFor(() => {
      expect(useWorkspaceStore.getState().sortOrders["pinned-all"]).toEqual(["x", "y"]);
    });

    act(() => {
      api.__test.emit({
        type: "orderedList:updated",
        scopeKey: "projects",
        itemIds: ["should-not-apply"],
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(useWorkspaceStore.getState().sortOrders["projects"]).toBeUndefined();
  });

  it("2.T5 skips the hydrate branch while a pinned-order write is in flight", async () => {
    useWorkspaceStore.setState({ sortOrders: { "pinned-all": ["local"] } });
    const api = createMockApi();
    await api.setOrderedList("pinned-all", ["server"]);

    const { markOrderedListWrite } = await import("./useServerSync");
    let resolveWrite!: () => void;
    const pendingWrite = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    markOrderedListWrite(pendingWrite);

    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    // The hydrate branch would normally overwrite local with the server's
    // ["server"] value — it must NOT while the write guard is set.
    await new Promise((r) => setTimeout(r, 50));
    expect(useWorkspaceStore.getState().sortOrders["pinned-all"]).toEqual(["local"]);

    resolveWrite();
  });
});

// --- worktree:deleted sweeps `tools:<worktreeId>` tiles, which carry no
// sessionId and so are unreachable by the session-keyed cleanup ---
describe("useServerSync — worktree:deleted tools-tile cleanup", () => {
  beforeEach(() => {
    useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
    useWorkspaceStore.setState({ workspaceDocs: {}, layoutByWorktree: {} });
  });

  it("drops the deleted worktree's tools tile from a scratch canvas", async () => {
    useWorkspaceStore.setState({
      layoutByWorktree: {
        "wt-1": {
          ...DEFAULT_WORKTREE_LAYOUT,
          scratchCanvas: {
            mode: "free",
            tiles: [
              { id: "tile-tools", kind: "tools" },
              { id: "tile-agent", kind: "agent", sessionId: "sess-x" },
            ],
            tree: null,
            freeRects: {},
          },
        },
      },
    });
    const api = createMockApi();
    // Register `sess-x` in the fetched list so Phase 2's refetch pruning doesn't
    // treat the agent tile as a ghost on mount (it must survive for the
    // worktree:deleted sweep to leave it alone).
    const defaults = await api.listSessions();
    const sessX: Session = {
      id: "sess-x",
      worktreeId: "wt-1",
      projectId: "proj-a",
      modeId: "mode-1",
      type: "agent",
      isMain: false,
      state: "working",
      lifecycleState: "working",
      tmuxName: "sess-x",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    vi.spyOn(api, "listSessions").mockResolvedValue([...defaults, sessX]);
    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    act(() => {
      api.__test.emit({ type: "worktree:deleted", worktreeId: "wt-1" });
    });

    await waitFor(() => {
      const canvas = useWorkspaceStore.getState().layoutByWorktree["wt-1"]!.scratchCanvas!;
      expect(canvas.tiles.map((t) => t.id)).toEqual(["tile-agent"]);
    });
  });
});

// --- Item 5a: `session:error{reason:"gone"}` → "exited" must fire globally,
// not only when a TerminalPane happens to be mounted for that session. ---
describe("useServerSync — session:error gone translation", () => {
  beforeEach(() => {
    useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
    useWorkspaceStore.setState({ sessionStates: {} });
  });

  it('marks the session exited on reason "gone" with no pane mounted', async () => {
    const api = createMockApi();
    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    act(() => {
      api.__test.emit({
        type: "session:error",
        sessionId: "sess-main",
        message: "session not found",
        reason: "gone",
      });
    });

    await waitFor(() => {
      expect(useWorkspaceStore.getState().sessionStates["sess-main"]).toBe("exited");
      expect(useServerStore.getState().sessions.find((s) => s.id === "sess-main")?.state).toBe("exited");
    });
  });

  it("ignores a transient error and an unclassified error", async () => {
    const api = createMockApi();
    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));
    act(() => {
      useWorkspaceStore.getState().patchSessionState("sess-main", "working");
    });

    act(() => {
      api.__test.emit({
        type: "session:error",
        sessionId: "sess-main",
        message: "stream hiccup",
        reason: "transient",
      });
      api.__test.emit({ type: "session:error", sessionId: "sess-main", message: "who knows" });
    });

    expect(useWorkspaceStore.getState().sessionStates["sess-main"]).toBe("working");
  });

  it("does not flip a session still in the not_started spawn window", async () => {
    const api = createMockApi();
    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));
    act(() => {
      useWorkspaceStore.getState().patchSessionState("sess-main", "not_started");
    });

    act(() => {
      api.__test.emit({
        type: "session:error",
        sessionId: "sess-main",
        message: "not running",
        reason: "gone",
      });
    });

    expect(useWorkspaceStore.getState().sessionStates["sess-main"]).toBe("not_started");
  });
});

// --- Phase 2 (reconnect-stale-state): prune ghost canvas/tab tiles on the
// reconnect refetch. refresh() now compares every tile-referenced sessionId
// against the freshly-fetched (unscoped) list and prunes tiles for ids not in
// it, merging in any session:created announced while the fetch was in flight.
//
// ⚠️ TEST-SETUP TRAP: `createSessionRepository`/`createWorktreeRepository`
// capture `api.listSessions` at useMemo (mount) time, and refresh() auto-runs
// once on mount. So EVERY spy/mock on listSessions must be installed BEFORE
// renderHook/render. Tests that control the FIRST (mount-triggered) refresh
// via a deferred promise must account for it explicitly. ---
describe("useServerSync — Phase 2 prune ghost tiles on refetch", () => {
  function baseSession(partial: Partial<Session>): Session {
    return {
      id: "sess-x",
      worktreeId: "wt-1",
      projectId: "proj-a",
      modeId: "mode-1",
      type: "agent",
      isMain: false,
      state: "working",
      lifecycleState: "working",
      tmuxName: "sess-x",
      createdAt: "2026-01-01T00:00:00.000Z",
      ...partial,
    };
  }

  /** Seed a scratch-canvas tile referencing `sessionId` in worktree `wtId`. */
  function seedScratchTile(wtId: string, sessionId: string) {
    useWorkspaceStore.setState({
      layoutByWorktree: {
        [wtId]: {
          ...DEFAULT_WORKTREE_LAYOUT,
          scratchCanvas: {
            mode: "free",
            tiles: [{ id: `tile-${sessionId}`, kind: "agent", sessionId }],
            tree: null,
            freeRects: {},
          },
        },
      },
    });
  }

  beforeEach(() => {
    useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
    useWorkspaceStore.setState({ workspaceDocs: {}, layoutByWorktree: {}, sessionStates: {} });
  });

  it("2.T1 — prunes a tile whose sessionId is absent from the fresh list (post-reload/empty-store case)", async () => {
    const api = createMockApi();
    const defaults = await api.listSessions();
    seedScratchTile("wt-1", "sess-ghost");
    vi.spyOn(api, "listSessions").mockResolvedValue(defaults);

    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    const canvas = useWorkspaceStore.getState().layoutByWorktree["wt-1"]!.scratchCanvas!;
    expect(canvas.tiles.some((t) => t.sessionId === "sess-ghost")).toBe(false);
  });

  it("2.T2 — leaves a tile untouched when its sessionId is still in the fresh list", async () => {
    const api = createMockApi();
    const defaults = await api.listSessions();
    const withGhost = [...defaults, baseSession({ id: "sess-ghost" })];
    seedScratchTile("wt-1", "sess-ghost");
    vi.spyOn(api, "listSessions").mockResolvedValue(withGhost);

    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    const canvas = useWorkspaceStore.getState().layoutByWorktree["wt-1"]!.scratchCanvas!;
    expect(canvas.tiles.some((t) => t.sessionId === "sess-ghost")).toBe(true);
  });

  it("2.T3 — a superseded session present in the fresh list is relinked, not pruned", async () => {
    const api = createMockApi();
    const defaults = await api.listSessions();
    const sOld = baseSession({ id: "S", supersededBy: "S2" });
    const sNew = baseSession({ id: "S2" });
    const list = [...defaults, sOld, sNew];
    seedScratchTile("wt-1", "S");
    vi.spyOn(api, "listSessions").mockResolvedValue(list);
    const removeSpy = vi.spyOn(useWorkspaceStore.getState(), "removeTilesForSession");

    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    expect(removeSpy).not.toHaveBeenCalledWith("S", expect.anything());
  });

  it("2.T4 — a session:created announced mid-fetch keeps its tile (merge-before-prune race)", async () => {
    const api = createMockApi();
    const defaults = await api.listSessions();
    // Source tile so the parent-tiling auto-insert fires for the announced child.
    seedScratchTile("wt-1", "sess-main");
    let resolveList!: (v: Session[]) => void;
    const deferred = new Promise<Session[]>((resolve) => {
      resolveList = resolve;
    });
    vi.spyOn(api, "listSessions").mockReturnValue(deferred);

    renderHook(() => useServerSync(api));

    act(() => {
      api.__test.emit({
        type: "session:created",
        sessionId: "new1",
        worktreeId: "wt-1",
        sessionType: "agent",
        parentSessionId: "sess-main",
        snapshot: baseSession({ id: "new1", state: "not_started", lifecycleState: "not_started" }),
      });
    });

    resolveList(defaults);
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    const canvas = useWorkspaceStore.getState().layoutByWorktree["wt-1"]!.scratchCanvas!;
    expect(canvas.tiles.some((t) => t.sessionId === "new1")).toBe(true);
  });

  it("2.T5 — a session in another worktree, still present in the full list, keeps its sessionStates entry", async () => {
    const api = createMockApi();
    const defaults = await api.listSessions();
    seedScratchTile("wt-1", "sess-ghost");
    useWorkspaceStore.setState({ sessionStates: { "sess-wt2-main": "done" } });
    vi.spyOn(api, "listSessions").mockResolvedValue(defaults);

    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    expect(useWorkspaceStore.getState().sessionStates["sess-wt2-main"]).toBe("done");
    const canvas = useWorkspaceStore.getState().layoutByWorktree["wt-1"]!.scratchCanvas!;
    expect(canvas.tiles.some((t) => t.sessionId === "sess-ghost")).toBe(false);
  });

  it("2.T6 — the announced session's not_started sessionStates entry survives the prune", async () => {
    const api = createMockApi();
    const defaults = await api.listSessions();
    seedScratchTile("wt-1", "sess-main");
    let resolveList!: (v: Session[]) => void;
    const deferred = new Promise<Session[]>((resolve) => {
      resolveList = resolve;
    });
    vi.spyOn(api, "listSessions").mockReturnValue(deferred);

    renderHook(() => useServerSync(api));

    act(() => {
      api.__test.emit({
        type: "session:created",
        sessionId: "new1",
        worktreeId: "wt-1",
        sessionType: "agent",
        parentSessionId: "sess-main",
        snapshot: baseSession({ id: "new1", state: "not_started", lifecycleState: "not_started" }),
      });
    });

    resolveList(defaults);
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    expect(useWorkspaceStore.getState().sessionStates["new1"]).toBe("not_started");
  });

  it("2.T7 — a failed refresh clears the announced-guard, so a later refetch prunes a since-announced session", async () => {
    const api = createMockApi();
    const defaults = await api.listSessions();
    seedScratchTile("wt-1", "X");
    // Mount refresh rejects; the swallow handler prevents an unhandled
    // rejection from failing the test (refresh()'s `void refresh()` is
    // pre-existing — it never attaches a catch).
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const spy = vi.spyOn(api, "listSessions").mockRejectedValueOnce(new Error("boom"));
    try {
      renderHook(() => useServerSync(api));
      // Let the failed mount refresh's `finally` run (clears the guard map).
      await new Promise((r) => setTimeout(r, 20));

      // X is announced OUTSIDE any in-flight refresh — must NOT enter the guard.
      act(() => {
        api.__test.emit({
          type: "session:created",
          sessionId: "X",
          worktreeId: "wt-1",
          sessionType: "agent",
          parentSessionId: "sess-main",
          snapshot: baseSession({ id: "X", state: "not_started", lifecycleState: "not_started" }),
        });
      });

      // Second refresh (ws:open) resolves with the full list minus X → X pruned.
      spy.mockResolvedValue(defaults);
      act(() => {
        api.__test.emit({ type: "ws:open" });
      });
      await waitFor(() => {
        const canvas = useWorkspaceStore.getState().layoutByWorktree["wt-1"]?.scratchCanvas;
        expect(canvas?.tiles.some((t) => t.sessionId === "X")).toBe(false);
      });
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("2.T8 — activeSessionId falls back to the ACTIVE worktree's main agent, never a cross-worktree one", async () => {
    const api = createMockApi();
    const defaults = await api.listSessions();
    seedScratchTile("wt-1", "sess-ghost");
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeSessionId: "sess-ghost",
    });
    // defaults contain sess-main (wt-1 isMain) and sess-wt2-main (wt-2 isMain).
    vi.spyOn(api, "listSessions").mockResolvedValue(defaults);

    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    expect(useWorkspaceStore.getState().activeSessionId).toBe("sess-main");
  });
});

