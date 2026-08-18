import { describe, it, expect, beforeEach } from "vitest";
import type { Session } from "@/api/types";
import {
  useWorkspaceStore,
  insertTileIntoCanvas,
  removeTileFromCanvas,
  findWorkspacesTilingSession,
  relinkSessionInCanvas,
  resolveSupersededChains,
  DEFAULT_WORKTREE_LAYOUT,
  type CanvasGeometry,
} from "@/hooks/useStore";

const P1 = "project-1";
const W1 = "wt-1";
const W2 = "wt-2";

const mockSessions = (worktreeId: string): Session[] => [
  {
    id: `${worktreeId}-main`,
    worktreeId,
    projectId: P1,
    modeId: null,
    type: "agent",
    state: "working",
    lifecycleState: "working",
    isMain: true,
    tmuxName: "main",
    createdAt: new Date().toISOString(),
  },
  {
    id: `${worktreeId}-alt`,
    worktreeId,
    projectId: P1,
    modeId: null,
    type: "agent",
    state: "idle",
    lifecycleState: "idle",
    isMain: false,
    tmuxName: "alt",
    createdAt: new Date().toISOString(),
  },
];

describe("useWorkspaceStore - setActiveWorktree", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.persist.clearStorage?.();
    useWorkspaceStore.setState({
      activeProjectId: null,
      activeWorktreeId: null,
      activeSessionId: null,
      lastSessionByWorktree: {},
    });
  });

  it("picks main slot when sessions are provided", () => {
    const sessions = mockSessions(W1);
    useWorkspaceStore.getState().setActiveWorktree(P1, W1, sessions);
    const state = useWorkspaceStore.getState();
    expect(state.activeProjectId).toBe(P1);
    expect(state.activeWorktreeId).toBe(W1);
    expect(state.activeSessionId).toBe(`${W1}-main`);
  });

  it("prefers lastSessionByWorktree if it's still in the session list", () => {
    const sessions = mockSessions(W1);
    useWorkspaceStore.setState({
      lastSessionByWorktree: { [W1]: `${W1}-alt` },
    });
    useWorkspaceStore.getState().setActiveWorktree(P1, W1, sessions);
    const state = useWorkspaceStore.getState();
    expect(state.activeSessionId).toBe(`${W1}-alt`);
  });

  it("falls back to main slot if lastSessionByWorktree is not in the list", () => {
    const sessions = mockSessions(W1);
    useWorkspaceStore.setState({
      lastSessionByWorktree: { [W1]: "nonexistent" },
    });
    useWorkspaceStore.getState().setActiveWorktree(P1, W1, sessions);
    const state = useWorkspaceStore.getState();
    expect(state.activeSessionId).toBe(`${W1}-main`);
  });

  it("picks first session if no main slot exists", () => {
    const allSessions = mockSessions(W1);
    const sessions: Session[] = [allSessions[1]!]; // only the alt session
    useWorkspaceStore.getState().setActiveWorktree(P1, W1, sessions);
    const state = useWorkspaceStore.getState();
    expect(state.activeSessionId).toBe(`${W1}-alt`);
  });

  it("sets activeSessionId to null if no sessions provided", () => {
    useWorkspaceStore.getState().setActiveWorktree(P1, W1, []);
    const state = useWorkspaceStore.getState();
    expect(state.activeWorktreeId).toBe(W1);
    expect(state.activeSessionId).toBeNull();
  });

  it("is idempotent on re-tap with active session", () => {
    const sessions = mockSessions(W1);
    useWorkspaceStore.setState({
      activeProjectId: P1,
      activeWorktreeId: W1,
      activeSessionId: `${W1}-main`,
    });
    const beforeState = useWorkspaceStore.getState();
    useWorkspaceStore.getState().setActiveWorktree(P1, W1, sessions);
    const afterState = useWorkspaceStore.getState();
    expect(beforeState).toBe(afterState);
  });

  it("activates session when switching from null to non-null", () => {
    const sessions = mockSessions(W1);
    useWorkspaceStore.setState({
      activeWorktreeId: W1,
      activeSessionId: null,
    });
    useWorkspaceStore.getState().setActiveWorktree(P1, W1, sessions);
    const state = useWorkspaceStore.getState();
    expect(state.activeSessionId).toBe(`${W1}-main`);
  });

  it("changes worktree even if session is active in previous worktree", () => {
    const sessionsW1 = mockSessions(W1);
    const sessionsW2 = mockSessions(W2);
    useWorkspaceStore.setState({
      activeProjectId: P1,
      activeWorktreeId: W1,
      activeSessionId: `${W1}-main`,
    });
    useWorkspaceStore.getState().setActiveWorktree(P1, W2, sessionsW2);
    const state = useWorkspaceStore.getState();
    expect(state.activeWorktreeId).toBe(W2);
    expect(state.activeSessionId).toBe(`${W2}-main`);
  });

  it("clears activeFilePath when switching worktree", () => {
    const sessions = mockSessions(W1);
    useWorkspaceStore.setState({
      activeFilePath: "/some/file.ts",
    });
    useWorkspaceStore.getState().setActiveWorktree(P1, W1, sessions);
    const state = useWorkspaceStore.getState();
    expect(state.activeFilePath).toBeNull();
  });
});

/**
 * A direct session has no worktree — activeWorktreeId is always null and the
 * context key is the project id (layoutKey = activeWorktreeId ?? activeDirectContextId).
 * setActiveFile used to key on activeWorktreeId directly, so a direct session's
 * open file was never remembered and could never be restored.
 */
describe("useWorkspaceStore - file memory per context", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.persist.clearStorage?.();
    useWorkspaceStore.setState({
      activeProjectId: null,
      activeWorktreeId: null,
      activeDirectContextId: null,
      activeSessionId: null,
      activeFilePath: null,
      lastFileByWorktree: {},
    });
  });

  it("remembers a direct session's open file under the project key", () => {
    useWorkspaceStore.getState().setActiveDirectContext(P1);
    useWorkspaceStore.getState().setActiveFile("/docs/plan.md");

    expect(useWorkspaceStore.getState().lastFileByWorktree[P1]).toBe("/docs/plan.md");
  });

  it("restores a direct session's last file on re-entering the context", () => {
    useWorkspaceStore.getState().setActiveDirectContext(P1);
    useWorkspaceStore.getState().setActiveFile("/docs/plan.md");

    // Leave the direct context, then come back.
    useWorkspaceStore.getState().setActiveDirectContext(null);
    useWorkspaceStore.setState({ activeFilePath: null });
    useWorkspaceStore.getState().setActiveDirectContext(P1);

    expect(useWorkspaceStore.getState().activeFilePath).toBe("/docs/plan.md");
  });

  it("still keys worktree sessions by worktree id", () => {
    useWorkspaceStore.setState({ activeWorktreeId: W1, activeDirectContextId: null });
    useWorkspaceStore.getState().setActiveFile("/src/index.ts");

    expect(useWorkspaceStore.getState().lastFileByWorktree[W1]).toBe("/src/index.ts");
  });

  it("keeps worktree and direct file memory in separate keys", () => {
    useWorkspaceStore.setState({ activeWorktreeId: W1, activeDirectContextId: null });
    useWorkspaceStore.getState().setActiveFile("/src/index.ts");

    useWorkspaceStore.setState({ activeWorktreeId: null });
    useWorkspaceStore.getState().setActiveDirectContext(P1);
    useWorkspaceStore.getState().setActiveFile("/docs/plan.md");

    const { lastFileByWorktree } = useWorkspaceStore.getState();
    expect(lastFileByWorktree[W1]).toBe("/src/index.ts");
    expect(lastFileByWorktree[P1]).toBe("/docs/plan.md");
  });

  it("does not record a file when there is no active context", () => {
    useWorkspaceStore.getState().setActiveFile("/orphan.ts");
    expect(useWorkspaceStore.getState().lastFileByWorktree).toEqual({});
    expect(useWorkspaceStore.getState().activeFilePath).toBe("/orphan.ts");
  });
});

// --- v14 -> v15 migration: workspace detachment (agent-interaction-workspaces/
// 04-workspaces Phase 3a, Decision 5/Risk #7) ---
describe("useWorkspaceStore - v14 -> v15 migration (workspace detachment)", () => {
  const STORAGE_KEY = "vibestation:workspace";

  const doc = {
    id: "doc-1",
    name: "Review Sprint",
    contextKey: W1,
    mode: "free" as const,
    tiles: [{ id: "tile-1", kind: "agent" as const, sessionId: "sess-1" }],
    tree: null,
    freeRects: { "tile-1": { x: 0, y: 0, w: 40, h: 40 } },
  };

  function v14Layout(activeWorkspaceId: string | null) {
    return {
      toolPanelVisible: true,
      toolPanelTab: "files",
      terminalDockVisible: false,
      toolSplitOrientation: "horizontal",
      layoutMode: "workspace",
      activeWorkspaceId,
      scratchCanvas: null,
    };
  }

  beforeEach(async () => {
    localStorage.clear();
    await useWorkspaceStore.persist.clearStorage?.();
  });

  it("3a.T1 — a saved WorkspaceDoc survives the migration with no data loss", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          workspaceDocs: { [doc.id]: doc },
          layoutByWorktree: { [W1]: v14Layout(doc.id) },
        },
        version: 14,
      }),
    );

    await useWorkspaceStore.persist.rehydrate();

    const state = useWorkspaceStore.getState();
    expect(state.workspaceDocs[doc.id]).toEqual(doc);
  });

  it("3a.T2 — clears layoutByWorktree[wtId].activeWorkspaceId when it pointed at a saved doc (Risk #7)", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          workspaceDocs: { [doc.id]: doc },
          layoutByWorktree: { [W1]: v14Layout(doc.id) },
        },
        version: 14,
      }),
    );

    await useWorkspaceStore.persist.rehydrate();

    const state = useWorkspaceStore.getState();
    expect(state.layoutByWorktree[W1]?.activeWorkspaceId).toBeNull();
    // Everything else on the entry is preserved, only the pointer is cleared.
    expect(state.layoutByWorktree[W1]?.toolPanelVisible).toBe(true);
    expect(state.layoutByWorktree[W1]?.layoutMode).toBe("workspace");
  });

  it("leaves activeWorkspaceId alone when it's null or points at nothing (no-op case)", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          workspaceDocs: {},
          layoutByWorktree: { [W2]: v14Layout(null) },
        },
        version: 14,
      }),
    );

    await useWorkspaceStore.persist.rehydrate();

    const state = useWorkspaceStore.getState();
    expect(state.layoutByWorktree[W2]?.activeWorkspaceId).toBeNull();
  });
});

// --- insertTileIntoCanvas / findWorkspacesTilingSession (agent-interaction-
// workspaces/04-workspaces Phase 4c, Decision 8) ---
describe("insertTileIntoCanvas", () => {
  it("appends a free-mode tile with a cascading rect and no worktreeId when it matches sameWorktreeId", () => {
    const canvas: CanvasGeometry = { mode: "free", tiles: [], tree: null, freeRects: {} };
    const next = insertTileIntoCanvas(canvas, "agent", "sess-1", W1, W1);
    expect(next.tiles).toHaveLength(1);
    expect(next.tiles[0]).toMatchObject({ kind: "agent", sessionId: "sess-1" });
    expect(next.tiles[0]!.worktreeId).toBeUndefined();
    expect(next.freeRects[next.tiles[0]!.id]).toBeDefined();
  });

  it("stamps worktreeId on the tile when it differs from sameWorktreeId (cross-context tile)", () => {
    const canvas: CanvasGeometry = { mode: "free", tiles: [], tree: null, freeRects: {} };
    const next = insertTileIntoCanvas(canvas, "agent", "sess-1", W2, W1);
    expect(next.tiles[0]!.worktreeId).toBe(W2);
  });

  it("builds a fresh tree when inserting the first tile in tiled mode", () => {
    const canvas: CanvasGeometry = { mode: "tiled", tiles: [], tree: null, freeRects: {} };
    const next = insertTileIntoCanvas(canvas, "agent", "sess-1");
    expect(next.tree).not.toBeNull();
    expect(next.tree!.type).toBe("leaf");
  });

  it("splits off the tree's last tile when inserting a second tile in tiled mode", () => {
    const canvas: CanvasGeometry = { mode: "tiled", tiles: [], tree: null, freeRects: {} };
    const withOne = insertTileIntoCanvas(canvas, "agent", "sess-1");
    const withTwo = insertTileIntoCanvas(withOne, "agent", "sess-2");
    expect(withTwo.tiles).toHaveLength(2);
    expect(withTwo.tree!.type).toBe("split");
  });

  it("never mutates the input canvas", () => {
    const canvas: CanvasGeometry = { mode: "free", tiles: [], tree: null, freeRects: {} };
    insertTileIntoCanvas(canvas, "agent", "sess-1");
    expect(canvas.tiles).toHaveLength(0);
  });
});

describe("findWorkspacesTilingSession", () => {
  const doc = (id: string, sessionIds: string[]) => ({
    id,
    name: id,
    contextKey: W1,
    mode: "free" as const,
    tiles: sessionIds.map((sid, i) => ({ id: `tile-${i}`, kind: "agent" as const, sessionId: sid })),
    tree: null,
    freeRects: {},
  });

  it("returns every doc that tiles the given sessionId", () => {
    const docs = {
      a: doc("a", ["sess-1"]),
      b: doc("b", ["sess-2"]),
      c: doc("c", ["sess-1", "sess-3"]),
    };
    const matches = findWorkspacesTilingSession("sess-1", docs);
    expect(matches.map((d) => d.id).sort()).toEqual(["a", "c"]);
  });

  it("returns an empty array when no doc tiles the session", () => {
    const docs = { a: doc("a", ["sess-1"]) };
    expect(findWorkspacesTilingSession("sess-nobody", docs)).toEqual([]);
  });
});

describe("removeTileFromCanvas", () => {
  it("drops the tile from `tiles` and its free-mode rect", () => {
    const empty: CanvasGeometry = { mode: "free", tiles: [], tree: null, freeRects: {} };
    const withTile = insertTileIntoCanvas(empty, "agent", "sess-1");
    const tileId = withTile.tiles[0]!.id;
    const next = removeTileFromCanvas(withTile, tileId);
    expect(next.tiles).toHaveLength(0);
    expect(next.freeRects[tileId]).toBeUndefined();
  });

  it("collapses the tiled-mode tree around the removed leaf", () => {
    const empty: CanvasGeometry = { mode: "tiled", tiles: [], tree: null, freeRects: {} };
    const withOne = insertTileIntoCanvas(empty, "agent", "sess-1");
    const withTwo = insertTileIntoCanvas(withOne, "agent", "sess-2");
    const firstTileId = withTwo.tiles[0]!.id;
    const next = removeTileFromCanvas(withTwo, firstTileId);
    expect(next.tiles).toHaveLength(1);
    expect(next.tree!.type).toBe("leaf");
  });

  it("never mutates the input canvas", () => {
    const empty: CanvasGeometry = { mode: "free", tiles: [], tree: null, freeRects: {} };
    const withTile = insertTileIntoCanvas(empty, "agent", "sess-1");
    const tileId = withTile.tiles[0]!.id;
    removeTileFromCanvas(withTile, tileId);
    expect(withTile.tiles).toHaveLength(1);
  });

  it("is a no-op (returns tiles unchanged) for an unknown tile id", () => {
    const empty: CanvasGeometry = { mode: "free", tiles: [], tree: null, freeRects: {} };
    const withTile = insertTileIntoCanvas(empty, "agent", "sess-1");
    const next = removeTileFromCanvas(withTile, "nonexistent");
    expect(next.tiles).toHaveLength(1);
  });
});

// --- relinkSessionInCanvas / relinkSessionTiles / resolveSupersededChains
// (present-tickmark-replacement/02-reset-relink) ---
describe("relinkSessionInCanvas", () => {
  it("repoints a matching tile's sessionId, keeping the same tile id", () => {
    const empty: CanvasGeometry = { mode: "free", tiles: [], tree: null, freeRects: {} };
    const withTile = insertTileIntoCanvas(empty, "agent", "sess-old");
    const tileId = withTile.tiles[0]!.id;
    const next = relinkSessionInCanvas(withTile, "sess-old", "sess-new");
    expect(next.tiles).toHaveLength(1);
    expect(next.tiles[0]!.id).toBe(tileId);
    expect(next.tiles[0]!.sessionId).toBe("sess-new");
  });

  it("returns the SAME canvas reference when no tile matches", () => {
    const empty: CanvasGeometry = { mode: "free", tiles: [], tree: null, freeRects: {} };
    const withTile = insertTileIntoCanvas(empty, "agent", "sess-other");
    const next = relinkSessionInCanvas(withTile, "sess-old", "sess-new");
    expect(next).toBe(withTile);
  });
});

describe("useWorkspaceStore - relinkSessionTiles", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.persist.clearStorage?.();
    useWorkspaceStore.setState({
      activeWorktreeId: W1,
      activeDirectContextId: null,
      layoutByWorktree: {},
      workspaceDocs: {},
    });
  });

  it("repoints a scratch-canvas tile referencing the old session to the new session", () => {
    const scratch = insertTileIntoCanvas(
      { mode: "free", tiles: [], tree: null, freeRects: {} },
      "agent",
      "sess-old",
    );
    useWorkspaceStore.setState({
      layoutByWorktree: { [W1]: { ...DEFAULT_WORKTREE_LAYOUT, scratchCanvas: scratch } },
    });
    useWorkspaceStore.getState().relinkSessionTiles("sess-old", "sess-new");
    const tiles = useWorkspaceStore.getState().layoutByWorktree[W1]!.scratchCanvas!.tiles;
    expect(tiles[0]!.sessionId).toBe("sess-new");
  });

  it("repoints a tile in a saved workspace doc", () => {
    const doc = {
      id: "doc-1",
      name: "doc-1",
      contextKey: W1,
      mode: "free" as const,
      tiles: [{ id: "tile-1", kind: "agent" as const, sessionId: "sess-old" }],
      tree: null,
      freeRects: {},
    };
    useWorkspaceStore.setState({ workspaceDocs: { "doc-1": doc } });
    useWorkspaceStore.getState().relinkSessionTiles("sess-old", "sess-new");
    expect(useWorkspaceStore.getState().workspaceDocs["doc-1"]!.tiles[0]!.sessionId).toBe("sess-new");
  });

  it("repoints a tile present in TWO saved docs at once, in the same call", () => {
    const mkDoc = (id: string) => ({
      id,
      name: id,
      contextKey: W1,
      mode: "free" as const,
      tiles: [{ id: `${id}-tile`, kind: "agent" as const, sessionId: "sess-old" }],
      tree: null,
      freeRects: {},
    });
    useWorkspaceStore.setState({ workspaceDocs: { a: mkDoc("a"), b: mkDoc("b") } });
    useWorkspaceStore.getState().relinkSessionTiles("sess-old", "sess-new");
    const docs = useWorkspaceStore.getState().workspaceDocs;
    expect(docs.a!.tiles[0]!.sessionId).toBe("sess-new");
    expect(docs.b!.tiles[0]!.sessionId).toBe("sess-new");
  });

  it("is a no-op (no state churn) when nothing matches", () => {
    const doc = {
      id: "doc-1",
      name: "doc-1",
      contextKey: W1,
      mode: "free" as const,
      tiles: [{ id: "tile-1", kind: "agent" as const, sessionId: "sess-other" }],
      tree: null,
      freeRects: {},
    };
    useWorkspaceStore.setState({ workspaceDocs: { "doc-1": doc } });
    const before = useWorkspaceStore.getState().workspaceDocs;
    useWorkspaceStore.getState().relinkSessionTiles("sess-old", "sess-new");
    expect(useWorkspaceStore.getState().workspaceDocs).toBe(before);
  });
});

describe("resolveSupersededChains", () => {
  it("resolves a multi-hop chain to the FINAL live id, not the intermediate hop", () => {
    const sessions = [
      { id: "A", supersededBy: "B" },
      { id: "B", supersededBy: "C" },
      { id: "C", supersededBy: null },
    ];
    const pairs = resolveSupersededChains(sessions);
    // A must resolve all the way to C, never stopping at the intermediate B.
    expect(pairs).toContainEqual({ oldId: "A", finalId: "C" });
    expect(pairs.find((p) => p.oldId === "A")!.finalId).not.toBe("B");
  });

  it("produces no pair for a session with no supersededBy", () => {
    const sessions = [{ id: "A", supersededBy: null }];
    expect(resolveSupersededChains(sessions)).toEqual([]);
  });

  it("terminates instead of looping forever on a cyclic chain", () => {
    const sessions = [
      { id: "A", supersededBy: "B" },
      { id: "B", supersededBy: "A" },
    ];
    expect(() => resolveSupersededChains(sessions)).not.toThrow();
  });
});

// --- toggleWorktreeToolsTile / toggleCanvasToolbar (canvas-mode top-bar
// rework: the Tools button adds/removes a canvas tile instead of toggling
// content visibility; the new chevron discloses/hides the canvas toolbar) ---
describe("useWorkspaceStore - toggleWorktreeToolsTile", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.persist.clearStorage?.();
    useWorkspaceStore.setState({
      activeWorktreeId: W1,
      activeDirectContextId: null,
      layoutByWorktree: {},
      workspaceDocs: {},
    });
  });

  it("is a no-op when no canvas (scratch or saved) exists yet for the active worktree", () => {
    const before = useWorkspaceStore.getState();
    useWorkspaceStore.getState().toggleWorktreeToolsTile();
    const after = useWorkspaceStore.getState();
    expect(after).toBe(before);
    expect(after.layoutByWorktree[W1]).toBeUndefined();
  });

  it("adds a Tools tile to the scratch canvas when none exists, then removes it on a second toggle", () => {
    useWorkspaceStore.setState({
      layoutByWorktree: {
        [W1]: { ...DEFAULT_WORKTREE_LAYOUT, scratchCanvas: { mode: "free", tiles: [], tree: null, freeRects: {} } },
      },
    });
    useWorkspaceStore.getState().toggleWorktreeToolsTile();
    const afterAdd = useWorkspaceStore.getState().layoutByWorktree[W1]!.scratchCanvas!;
    expect(afterAdd.tiles).toHaveLength(1);
    expect(afterAdd.tiles[0]).toMatchObject({ kind: "tools" });

    useWorkspaceStore.getState().toggleWorktreeToolsTile();
    const afterRemove = useWorkspaceStore.getState().layoutByWorktree[W1]!.scratchCanvas!;
    expect(afterRemove.tiles).toHaveLength(0);
  });

  it("does not add a second Tools tile sharing the same pane key (regression: worktreeId-fallback mismatch)", () => {
    useWorkspaceStore.setState({
      layoutByWorktree: {
        [W1]: { ...DEFAULT_WORKTREE_LAYOUT, scratchCanvas: { mode: "free", tiles: [], tree: null, freeRects: {} } },
      },
    });
    useWorkspaceStore.getState().toggleWorktreeToolsTile();
    useWorkspaceStore.getState().toggleWorktreeToolsTile();
    useWorkspaceStore.getState().toggleWorktreeToolsTile();
    const canvas = useWorkspaceStore.getState().layoutByWorktree[W1]!.scratchCanvas!;
    const toolsTiles = canvas.tiles.filter((t) => t.kind === "tools");
    expect(toolsTiles).toHaveLength(1);
  });

  it("always targets the scratch canvas, ignoring a stale activeWorkspaceId (a worktree never binds to a saved doc)", () => {
    const docId = "doc-1";
    useWorkspaceStore.setState({
      layoutByWorktree: {
        [W1]: {
          ...DEFAULT_WORKTREE_LAYOUT,
          activeWorkspaceId: docId,
          scratchCanvas: { mode: "free", tiles: [], tree: null, freeRects: {} },
        },
      },
      workspaceDocs: {
        [docId]: { id: docId, name: "Doc", contextKey: W1, mode: "free", tiles: [], tree: null, freeRects: {} },
      },
    });
    useWorkspaceStore.getState().toggleWorktreeToolsTile();
    const state = useWorkspaceStore.getState();
    expect(state.layoutByWorktree[W1]!.scratchCanvas!.tiles).toHaveLength(1);
    // The doc is untouched — it's never a target for this action.
    expect(state.workspaceDocs[docId]!.tiles).toHaveLength(0);
  });
});

describe("useWorkspaceStore - toggleCanvasToolbar", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.persist.clearStorage?.();
    useWorkspaceStore.setState({
      activeWorktreeId: W1,
      activeDirectContextId: null,
      layoutByWorktree: {},
    });
  });

  it("flips canvasToolbarVisible from the default (true) to false and back", () => {
    expect(DEFAULT_WORKTREE_LAYOUT.canvasToolbarVisible).toBe(true);
    useWorkspaceStore.getState().toggleCanvasToolbar();
    expect(useWorkspaceStore.getState().layoutByWorktree[W1]!.canvasToolbarVisible).toBe(false);
    useWorkspaceStore.getState().toggleCanvasToolbar();
    expect(useWorkspaceStore.getState().layoutByWorktree[W1]!.canvasToolbarVisible).toBe(true);
  });
});
