import { renderHook, waitFor, act } from "@testing-library/react";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { useServerSync } from "./useServerSync";
import { useServerStore } from "./useServerStore";
import { useWorkspaceStore } from "./useStore";

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

// --- Phase 4c: auto-insert a tile for a session:created carrying spawnedFrom
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

  beforeEach(() => {
    useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
    useWorkspaceStore.setState({ workspaceDocs: {} });
  });

  it("4c.T1 — a session:created with spawnedFrom matching exactly one workspace's tile auto-inserts a new tile there", async () => {
    seedOneMatchingDoc();
    const api = createMockApi();
    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    act(() => {
      api.__test.emit({
        type: "session:created",
        sessionId: "sess-new",
        worktreeId: "wt-1",
        sessionType: "agent",
        spawnedFrom: SOURCE_ID,
      });
    });

    await waitFor(() => {
      const doc = useWorkspaceStore.getState().workspaceDocs[DOC_ID]!;
      expect(doc.tiles.some((t) => t.sessionId === "sess-new")).toBe(true);
      expect(doc.tiles).toHaveLength(2);
    });
  });

  it("4c.T2 — a session:created with spawnedFrom matching no tile anywhere results in no tile insert, no error (S5)", async () => {
    seedOneMatchingDoc();
    const api = createMockApi();
    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    act(() => {
      api.__test.emit({
        type: "session:created",
        sessionId: "sess-new",
        worktreeId: "wt-1",
        sessionType: "agent",
        spawnedFrom: "sess-nobody-tiles-this",
      });
    });

    // Give any (incorrectly-scheduled) insert a chance, then confirm nothing changed.
    await new Promise((r) => setTimeout(r, 50));
    const doc = useWorkspaceStore.getState().workspaceDocs[DOC_ID]!;
    expect(doc.tiles).toHaveLength(1);
  });

  it("4c.T3 — a session:created with spawnedFrom absent behaves identically to pre-Phase-4 (no scan attempted, CUJ 6)", async () => {
    seedOneMatchingDoc();
    const api = createMockApi();
    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    act(() => {
      api.__test.emit({
        type: "session:created",
        sessionId: "sess-new",
        worktreeId: "wt-1",
        sessionType: "agent",
        // spawnedFrom omitted entirely — old-daemon / no-source create.
      });
    });

    await new Promise((r) => setTimeout(r, 50));
    const doc = useWorkspaceStore.getState().workspaceDocs[DOC_ID]!;
    expect(doc.tiles).toHaveLength(1);
  });

  it("logs and skips (no insert into either) when the source is tiled in MORE THAN ONE workspace (Risk #9/#10, not yet confirmed)", async () => {
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
    renderHook(() => useServerSync(api));
    await waitFor(() => expect(useServerStore.getState().loaded).toBe(true));

    act(() => {
      api.__test.emit({
        type: "session:created",
        sessionId: "sess-new",
        worktreeId: "wt-1",
        sessionType: "agent",
        spawnedFrom: SOURCE_ID,
      });
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(useWorkspaceStore.getState().workspaceDocs[DOC_ID]!.tiles).toHaveLength(1);
    expect(useWorkspaceStore.getState().workspaceDocs["doc-2"]!.tiles).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
