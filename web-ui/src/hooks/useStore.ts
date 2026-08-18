import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DiffScope, Session, SessionState } from "@/api/types";
import { findLeafId, insertPane, removePane, type LayoutNode } from "@/lib/tiling";
import { randomId } from "@/lib/uuid";

/** Tools hosted by the right-side tool panel (one visible at a time). */
export type ToolTab = "files" | "devices" | "artifacts" | "vcs";

export const TOOL_TABS: ToolTab[] = ["files", "devices", "artifacts", "vcs"];

/**
 * Per-worktree workspace layout.
 *
 * The IDE has three regions: the agent pane (center, always present), the
 * right-side tool panel (Files/Devices/Artifacts — one tool visible at a time),
 * and the bottom terminal dock (terminal sessions). The agent pane is never
 * collapsed; the tool panel and terminal dock are. The Files tool is
 * master-detail (tree + preview); Devices hosts the web browser +
 * emulators/devices as sub-tabs; Artifacts is master-detail (list + preview).
 */
/** Agent pane ↔ tool panel split orientation (terminal dock stays at the bottom). */
export type ToolSplitOrientation = "horizontal" | "vertical";

export interface WorktreeLayout {
  toolPanelVisible: boolean;
  toolPanelTab: ToolTab;
  terminalDockVisible: boolean;
  /** "horizontal" = agent | tools side by side; "vertical" = agent / tools stacked. */
  toolSplitOrientation: ToolSplitOrientation;
  /** "classic" = today's fixed split; "workspace" = tiled/free-form canvas of live panes. */
  layoutMode: "classic" | "workspace";
  /** Which saved WorkspaceDoc (below) is currently loaded for this worktree, if any. */
  activeWorkspaceId: string | null;
  /**
   * The TRANSIENT canvas for this worktree — what the top bar's classic↔workspace
   * toggle drops you into when no saved workspace is selected. Same geometry
   * payload as a WorkspaceDoc, but it is NOT a WorkspaceDoc: it has no name, never
   * appears in the sidebar's Workspaces list, and is scoped to this worktree's own
   * panes only (no cross-worktree tiles). Persisted only incidentally, because
   * `layoutByWorktree` is persisted — "Save as workspace" is what promotes it into
   * a real, named, cross-context WorkspaceDoc.
   */
  scratchCanvas: CanvasGeometry | null;
  /**
   * Whether the workspace-canvas toolbar (mode toggle / doc name / save /
   * add tile — portaled into TopBar via WORKSPACE_CANVAS_TOOLBAR_KEY, see
   * paneOutlets.tsx) is currently disclosed under the crumb in the classic
   * per-worktree canvas view. Defaults true (the toolbar IS the canvas's
   * primary UI — hiding it by default would make canvas mode look broken on
   * first use). Only meaningful for that placement; the detached
   * `/workspaces/:id` view always shows its toolbar regardless of this flag.
   */
  canvasToolbarVisible: boolean;
}

export const DEFAULT_WORKTREE_LAYOUT: WorktreeLayout = {
  toolPanelVisible: true,
  toolPanelTab: "files",
  terminalDockVisible: false,
  toolSplitOrientation: "horizontal",
  layoutMode: "classic",
  activeWorkspaceId: null,
  scratchCanvas: null,
  canvasToolbarVisible: true,
};

export type TileKind = "agent" | "terminal" | "tools";

export interface TileSpec {
  id: string;
  kind: TileKind;
  /** For "agent"/"terminal" tiles: the underlying session id. Undefined for "tools". */
  sessionId?: string;
  /**
   * Owning worktree for a CROSS-CONTEXT tile (a saved workspace can host panes
   * from other worktrees/projects). Undefined means "the worktree this canvas is
   * being viewed in" — every tile on a transient canvas, and every same-worktree
   * tile, leaves it undefined. Load-bearing for "tools" tiles, whose pane key is
   * `tools:${worktreeId}`; carried on agent/terminal tiles too, for grouping/labels.
   */
  worktreeId?: string;
}

export interface FreeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The pure geometry payload of a canvas — everything WorkspaceCanvas reads and
 * writes while you drag/resize/add/remove tiles. Shared verbatim by the saved
 * `WorkspaceDoc` (below) and the transient `WorktreeLayout.scratchCanvas`, so the
 * canvas component can run against either backing store unchanged.
 */
export interface CanvasGeometry {
  mode: "tiled" | "free";
  tiles: TileSpec[];
  /** Tiling-mode layout tree (see lib/tiling.ts). Null when mode is "free" or canvas is empty. */
  tree: LayoutNode | null;
  /** Free-mode per-tile rects, keyed by TileSpec.id. Empty/unused when mode is "tiled". */
  freeRects: Record<string, FreeRect>;
}

/** A saved, named workspace layout — a tiled or free-form arrangement of tiles. */
export interface WorkspaceDoc extends CanvasGeometry {
  id: string;
  name: string;
  /**
   * worktreeId this workspace was originally created in. Provenance/display
   * only (e.g. a future "created in ‹name›" hint) — a saved workspace is
   * detached from its creating worktree (Phase 3, agent-interaction-
   * workspaces/04-workspaces): the sidebar's Workspaces section lists every
   * doc globally and this field is no longer read as an ownership/filter
   * gate anywhere. Kept (not removed) to avoid a field-removal migration —
   * every existing stored doc already has a valid value.
   */
  contextKey: string;
}

/** IDE viewport fullscreen for the agent pane, tool panel, or terminal dock (not persisted). */
export type WorkspacePaneFullscreen = "agent" | "tools" | "terminal";

/** Draggable-resize bounds for the desktop left sidebar (px). */
export const LEFT_SIDEBAR_MIN_WIDTH = 180;
export const LEFT_SIDEBAR_MAX_WIDTH = 480;

function clampLeftSidebarWidth(px: number): number {
  return Math.min(LEFT_SIDEBAR_MAX_WIDTH, Math.max(LEFT_SIDEBAR_MIN_WIDTH, Math.round(px)));
}

export interface WorkspaceState {
  /** Per-worktree layout state. Falls back to DEFAULT_WORKTREE_LAYOUT. */
  layoutByWorktree: Record<string, WorktreeLayout>;
  activeProjectId: string | null;
  activeWorktreeId: string | null;
  /**
   * Layout context for a direct session (no worktree): the project id. Direct
   * sessions reuse the per-context layout map keyed by this id, so tool-panel /
   * terminal-dock toggles work just like a worktree. Null outside direct sessions.
   */
  activeDirectContextId: string | null;
  /** Active *agent* session (drives the agent pane + file preview). */
  activeSessionId: string | null;
  /** Active *terminal* session shown in the bottom terminal dock. */
  activeTerminalSessionId: string | null;
  activeFilePath: string | null;
  /** Last opened file path per worktree (persisted). */
  lastFileByWorktree: Record<string, string>;
  /** Preview scroll position keyed by `${worktreeId}:${filePath}` (persisted). */
  fileScrollByKey: Record<string, number>;
  showDotFiles: boolean;
  /** Live session.state mirror for WS + list payloads */
  sessionStates: Record<string, SessionState>;
  /** Last selected agent tab per worktree (persisted) */
  lastSessionByWorktree: Record<string, string>;
  /** Last selected terminal tab per worktree (persisted) */
  lastTerminalByWorktree: Record<string, string>;
  diffScopeByWorktree: Record<string, DiffScope>;
  previewFontScale: number;
  /** Whether the Files tool shows its file-tree column (persisted, view pref). */
  fileTreeVisible: boolean;
  terminalFontScale: number;
  leftSidebarCollapsed: boolean;
  /** Desktop left sidebar width in px when expanded (persisted, drag-resizable). */
  leftSidebarWidthPx: number;
  /** Hide worktrees whose agent sessions are all explicitly marked done (not exited) */
  hideInactiveWorktrees: boolean;
  /** Show the colored border around agent panes/workspace tiles keyed to
   *  interaction state (waiting_for_human red) plus the orthogonal PR axis
   *  (open blue, merged green — see resolveStatusClass in statusColor.ts).
   *  Client-side view preference (persisted); does not affect the sidebar's
   *  StatusDot, which always shows. Defaults on. */
  showAgentStatusBorders: boolean;
  mobileSidebarOpen: boolean;
  /** Transient attach state between openSession and session:opened */
  sessionAttachState: Record<string, "pending" | "attached">;
  /** A region maximized over the full viewport (sidebar + top bar area). */
  workspacePaneFullscreen: WorkspacePaneFullscreen | null;
  setWorkspacePaneFullscreen: (next: WorkspacePaneFullscreen | null) => void;
  /** Toggle the right-side tool panel. */
  toggleToolPanel: () => void;
  /** Select a tool tab, making the panel visible. */
  setToolPanelTab: (tab: ToolTab) => void;
  /** Toggle the bottom terminal dock. */
  toggleTerminalDock: () => void;
  /** Flip the agent pane ↔ tool panel split between horizontal and vertical. */
  toggleToolSplitOrientation: () => void;
  /** Show/hide the workspace-canvas toolbar's disclosure under the crumb (classic per-worktree canvas placement only). */
  toggleCanvasToolbar: () => void;
  /**
   * Canvas-mode equivalent of `toggleToolPanel`: instead of toggling content
   * visibility inside an already-placed Tools tile, adds/removes the Tools
   * tile itself on the active worktree's canvas (saved doc if one is active,
   * else the transient scratch canvas). No-op if no canvas exists yet.
   */
  toggleWorktreeToolsTile: () => void;
  setActiveWorktree: (projectId: string, worktreeId: string, sessions?: Session[]) => void;
  /** Set (or clear with null) the direct-session layout context (project id). */
  setActiveDirectContext: (projectId: string | null) => void;
  setActiveSession: (sessionId: string) => void;
  setActiveTerminalSession: (sessionId: string) => void;
  setActiveFile: (path: string | null) => void;
  setFileScroll: (worktreeId: string, filePath: string, scrollTop: number) => void;
  setDiffScopeForWorktree: (worktreeId: string, scope: DiffScope) => void;
  bumpPreviewFont: (delta: number) => void;
  /** Show/hide the Files tool's file-tree column. */
  toggleFileTree: () => void;
  bumpTerminalFont: (delta: number) => void;
  toggleLeftSidebarCollapsed: () => void;
  setLeftSidebarWidthPx: (px: number) => void;
  setMobileSidebarOpen: (open: boolean) => void;
  toggleInactiveWorktreesFilter: () => void;
  toggleAgentStatusBorders: () => void;
  clearWorkspaceSelection: () => void;
  toggleDotFiles: () => void;
  patchSessionState: (sessionId: string, state: SessionState) => void;
  syncSessionsFromApi: (sessions: Session[]) => void;
  markSessionAttachPending: (sessionId: string) => void;
  markSessionAttached: (sessionId: string) => void;
  clearSessionAttach: (sessionId: string) => void;

  /**
   * Drag-reorder state: scopeKey -> ordered list of item ids.
   *
   * As of Part 03 Phase 2, regular (unpinned) per-worktree/per-project scopes
   * (`tabs:*`, `worktrees:${projectId}`, `direct:${projectId}`) are ordered by
   * the server's real numeric `sortOrder` column instead — see
   * `computeNewSortOrder` below. This map now ONLY holds the pinned sub-lists,
   * which stay on the old local-only mechanism because the server's
   * `sortOrder` column is scoped per-worktree/per-project and cannot express a
   * cross-project pinned order (see plan Decision 1 exception):
   *   - `pinned-worktrees` / `pinned-direct` — the pinned sub-lists (their own
   *     reorderable scope, independent of pin recency — see LeftSidebar).
   * Missing/unknown ids (id not yet dragged) are appended in their natural
   * order by callers — this map only needs to hold the ids the user has
   * actually dragged. The merge helper for this (formerly `applySortOrder`,
   * exported from here) now lives privately in `LeftSidebar.tsx`, the only
   * remaining consumer, since it's scoped to the pinned sub-lists only.
   */
  sortOrders: Record<string, string[]>;
  setSortOrder: (scopeKey: string, orderedIds: string[]) => void;

  /** Saved workspace layouts, keyed by WorkspaceDoc.id. */
  workspaceDocs: Record<string, WorkspaceDoc>;
  /** Display order of workspace ids for a given scope key (e.g. `workspaces:${worktreeId}`) — mirrors the existing `sortOrders` client-only-reorder pattern (see line 142/395). */
  workspaceOrder: Record<string, string[]>;
  createWorkspace: (contextKey: string, name: string, mode: "tiled" | "free") => string;
  renameWorkspace: (id: string, name: string) => void;
  deleteWorkspace: (id: string) => void;
  updateWorkspaceDoc: (id: string, patch: Partial<Omit<WorkspaceDoc, "id" | "contextKey">>) => void;
  /**
   * Insert a new tile into a saved WorkspaceDoc, splitting off its last tile
   * (same split-target+side model as `WorkspaceCanvas.tsx`'s "Add tile"
   * picker, Decision 8 — single insert implementation, not a parallel one).
   * A no-op if `docId` doesn't resolve to a doc. Used by both the manual
   * "Add tile" flow and the Phase 4c `session:created` auto-insert listener.
   */
  insertTileIntoWorkspaceDoc: (
    docId: string,
    kind: TileKind,
    sessionId?: string,
    tileWorktreeId?: string,
  ) => void;
  /**
   * Repoint every tile (scratch canvas + every saved workspace doc)
   * referencing `fromSessionId` to `toSessionId` — a reset's replacement
   * taking the archived session's exact place, same tile id/position.
   * A no-op (identity-preserving) for canvases with no matching tile.
   */
  relinkSessionTiles: (fromSessionId: string, toSessionId: string) => void;
  reorderWorkspace: (scopeKey: string, orderedIds: string[]) => void;
  setActiveWorkspace: (worktreeId: string, workspaceId: string | null) => void;
  setLayoutMode: (worktreeId: string, mode: "classic" | "workspace") => void;
  /** Create-or-patch this worktree's transient (unsaved) canvas geometry. */
  updateScratchCanvas: (worktreeId: string, patch: Partial<CanvasGeometry>) => void;
  /** Drop the transient canvas (e.g. after "Save as workspace" promoted it). */
  clearScratchCanvas: (worktreeId: string) => void;
}

/** Starting point for a freshly-entered transient canvas. */
export const EMPTY_CANVAS_GEOMETRY: CanvasGeometry = {
  mode: "free",
  tiles: [],
  tree: null,
  freeRects: {},
};

/**
 * Pure tile-insert core, shared by BOTH `WorkspaceCanvas.tsx`'s "Add tile"
 * picker (manual) and `insertTileIntoWorkspaceDoc` below (Phase 4c's
 * `session:created` auto-insert) — agent-interaction-workspaces/04-workspaces
 * Decision 8: one implementation, not two divergent ones, so a manually- and
 * an auto-inserted tile behave identically. Splits off the canvas's LAST
 * tile (side "right") in tiled mode; cascades a new free-rect in free mode.
 * Returns a NEW `CanvasGeometry`-shaped patch — never mutates `canvas`.
 *
 * `sameWorktreeId`: the tile's own `worktreeId` is only stamped when it
 * differs from this — keeps same-context tiles byte-identical to the
 * pre-cross-context tile shape (pass the viewed worktreeId for the scratch-
 * canvas case, or the doc's own `contextKey` for a saved-doc case).
 */
export function insertTileIntoCanvas(
  canvas: CanvasGeometry,
  kind: TileKind,
  sessionId?: string,
  tileWorktreeId?: string,
  sameWorktreeId?: string,
): CanvasGeometry {
  const id = randomId();
  const tile: TileSpec = { id, kind, sessionId };
  if (tileWorktreeId && tileWorktreeId !== sameWorktreeId) tile.worktreeId = tileWorktreeId;
  const nextTiles = [...canvas.tiles, tile];
  if (canvas.mode === "tiled") {
    let nextTree: LayoutNode | null;
    if (!canvas.tree || canvas.tiles.length === 0) {
      nextTree = insertPane(null, null, "right", id);
    } else {
      const lastTileId = canvas.tiles[canvas.tiles.length - 1]!.id;
      const targetLeafId = findLeafId(canvas.tree, lastTileId);
      nextTree = insertPane(canvas.tree, targetLeafId, "right", id);
    }
    return { ...canvas, tiles: nextTiles, tree: nextTree };
  }
  const cascade = canvas.tiles.length;
  const rect: FreeRect = { x: 6 + (cascade % 5) * 5, y: 6 + (cascade % 5) * 5, w: 42, h: 42 };
  return { ...canvas, tiles: nextTiles, freeRects: { ...canvas.freeRects, [id]: rect } };
}

/**
 * Pure tile-remove core — the inverse of `insertTileIntoCanvas` above, and the
 * single implementation shared by `WorkspaceCanvas.tsx`'s tile-close button
 * and the store's `toggleWorktreeToolsTile` action, so both stay in sync on
 * tree/free-rect cleanup instead of drifting into two divergent removals.
 * Returns a NEW `CanvasGeometry` — never mutates `canvas`. Callers that track
 * a fullscreen-tile id locally (WorkspaceCanvas's `fullscreenTileId` state)
 * are responsible for reconciling it themselves afterwards — this function
 * has no way to reach component-local React state.
 */
export function removeTileFromCanvas(canvas: CanvasGeometry, tileId: string): CanvasGeometry {
  const nextTiles = canvas.tiles.filter((t) => t.id !== tileId);
  const nextFreeRects = { ...canvas.freeRects };
  delete nextFreeRects[tileId];
  let nextTree = canvas.tree;
  if (canvas.mode === "tiled") {
    const leafId = findLeafId(canvas.tree, tileId);
    nextTree = leafId ? removePane(canvas.tree, leafId) : canvas.tree;
  }
  return { ...canvas, tiles: nextTiles, freeRects: nextFreeRects, tree: nextTree };
}

/**
 * Repoint every tile referencing `fromSessionId` to `toSessionId` — same tile
 * id, same position/geometry, just a different session behind it (a reset's
 * replacement taking the archived session's exact place). Returns the SAME
 * `canvas` reference when nothing matched, so callers can skip a `set()` for
 * canvases this reset didn't touch.
 */
export function relinkSessionInCanvas(
  canvas: CanvasGeometry,
  fromSessionId: string,
  toSessionId: string,
): CanvasGeometry {
  if (!canvas.tiles.some((t) => t.sessionId === fromSessionId)) return canvas;
  return {
    ...canvas,
    tiles: canvas.tiles.map((t) => (t.sessionId === fromSessionId ? { ...t, sessionId: toSessionId } : t)),
  };
}

/**
 * Every {oldId, finalId} pair still needing a relink, from a flat sessions
 * list. Walks multi-hop chains (a double reset while offline produces
 * A.supersededBy=B, B.supersededBy=C) to the FINAL live id — relinking to an
 * intermediate hop that is itself archived would just move the bug.
 */
export function resolveSupersededChains(
  sessions: Array<{ id: string; supersededBy?: string | null }>,
): Array<{ oldId: string; finalId: string }> {
  const supersededBy = new Map(
    sessions.filter((s) => s.supersededBy != null).map((s) => [s.id, s.supersededBy as string]),
  );
  const result: Array<{ oldId: string; finalId: string }> = [];
  for (const oldId of supersededBy.keys()) {
    const seen = new Set<string>();
    let finalId = oldId;
    while (supersededBy.has(finalId) && !seen.has(finalId)) {
      seen.add(finalId);
      finalId = supersededBy.get(finalId)!;
    }
    if (finalId !== oldId) result.push({ oldId, finalId });
  }
  return result;
}

/**
 * Every saved WorkspaceDoc that currently tiles `sessionId` (agent-
 * interaction-workspaces/04-workspaces Phase 4c, Research "Client-side
 * auto-insert target"). `workspaceDocs` is already a flat, global map
 * regardless of Phase 3's detachment status — this scan doesn't care whether
 * a matched doc is "the active one" or not, it just finds every match.
 */
export function findWorkspacesTilingSession(
  sessionId: string,
  workspaceDocs: Record<string, WorkspaceDoc>,
): WorkspaceDoc[] {
  return Object.values(workspaceDocs).filter((doc) => doc.tiles.some((t) => t.sessionId === sessionId));
}

/**
 * Compute the moved item's new fractional `sortOrder` value from the real
 * `sortOrder` of its new neighbors (server-backed drag-reorder — Decision 1).
 *
 *  - No neighbors at all (only item in the scope) -> 0
 *  - No previous neighbor (now first) -> next - 1
 *  - No next neighbor (now last) -> prev + 1
 *  - Between two neighbors -> their midpoint
 */
export function computeNewSortOrder(
  prevSortOrder: number | undefined,
  nextSortOrder: number | undefined,
): number {
  if (prevSortOrder == null && nextSortOrder == null) return 0; // only item in the scope
  if (prevSortOrder == null) return nextSortOrder! - 1; // now first
  if (nextSortOrder == null) return prevSortOrder + 1; // now last
  return (prevSortOrder + nextSortOrder) / 2; // between two neighbors
}

const initial = {
  layoutByWorktree: {} as Record<string, WorktreeLayout>,
  activeProjectId: null as string | null,
  activeWorktreeId: null as string | null,
  activeDirectContextId: null as string | null,
  activeSessionId: null as string | null,
  activeTerminalSessionId: null as string | null,
  activeFilePath: null as string | null,
  lastFileByWorktree: {} as Record<string, string>,
  fileScrollByKey: {} as Record<string, number>,
  showDotFiles: true,
  sessionStates: {} as Record<string, SessionState>,
  lastSessionByWorktree: {} as Record<string, string>,
  lastTerminalByWorktree: {} as Record<string, string>,
  diffScopeByWorktree: {} as Record<string, DiffScope>,
  previewFontScale: 1,
  fileTreeVisible: true,
  terminalFontScale: 1,
  leftSidebarCollapsed: false,
  leftSidebarWidthPx: 220,
  hideInactiveWorktrees: true,
  showAgentStatusBorders: true,
  mobileSidebarOpen: false,
  sessionAttachState: {} as Record<string, "pending" | "attached">,
  workspacePaneFullscreen: null as WorkspacePaneFullscreen | null,
  sortOrders: {} as Record<string, string[]>,
  workspaceDocs: {} as Record<string, WorkspaceDoc>,
  workspaceOrder: {} as Record<string, string[]>,
};

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set) => {
      /** Active layout key: worktree id, or the direct-session project id. */
      function layoutKey(s: WorkspaceState): string | null {
        return s.activeWorktreeId ?? s.activeDirectContextId;
      }

      /** Patch the active context's layout, falling back to defaults. */
      function patchLayout(
        s: WorkspaceState,
        patch: Partial<WorktreeLayout>,
      ): Partial<WorkspaceState> {
        const key = layoutKey(s);
        if (!key) return s;
        const cur = s.layoutByWorktree[key] ?? DEFAULT_WORKTREE_LAYOUT;
        return {
          layoutByWorktree: {
            ...s.layoutByWorktree,
            [key]: { ...cur, ...patch },
          },
        };
      }

      return {
        ...initial,
        toggleToolPanel: () =>
          set((s) => {
            const key = layoutKey(s);
            const cur = key
              ? (s.layoutByWorktree[key] ?? DEFAULT_WORKTREE_LAYOUT)
              : DEFAULT_WORKTREE_LAYOUT;
            const next = patchLayout(s, { toolPanelVisible: !cur.toolPanelVisible });
            // Leaving fullscreen if we just hid the panel that was maximized.
            if (cur.toolPanelVisible && s.workspacePaneFullscreen === "tools") {
              return { ...next, workspacePaneFullscreen: null };
            }
            return next;
          }),
        setToolPanelTab: (tab) =>
          set((s) => patchLayout(s, { toolPanelTab: tab, toolPanelVisible: true })),
        toggleTerminalDock: () =>
          set((s) => {
            const key = layoutKey(s);
            const cur = key
              ? (s.layoutByWorktree[key] ?? DEFAULT_WORKTREE_LAYOUT)
              : DEFAULT_WORKTREE_LAYOUT;
            const next = patchLayout(s, { terminalDockVisible: !cur.terminalDockVisible });
            if (cur.terminalDockVisible && s.workspacePaneFullscreen === "terminal") {
              return { ...next, workspacePaneFullscreen: null };
            }
            return next;
          }),
        toggleToolSplitOrientation: () =>
          set((s) => {
            const key = layoutKey(s);
            const cur = key
              ? (s.layoutByWorktree[key] ?? DEFAULT_WORKTREE_LAYOUT)
              : DEFAULT_WORKTREE_LAYOUT;
            const next = cur.toolSplitOrientation === "horizontal" ? "vertical" : "horizontal";
            return patchLayout(s, { toolSplitOrientation: next });
          }),
        toggleCanvasToolbar: () =>
          set((s) => {
            const key = layoutKey(s);
            const cur = key
              ? (s.layoutByWorktree[key] ?? DEFAULT_WORKTREE_LAYOUT)
              : DEFAULT_WORKTREE_LAYOUT;
            return patchLayout(s, { canvasToolbarVisible: !cur.canvasToolbarVisible });
          }),
        // A worktree's classic canvas is ALWAYS its own scratch canvas (a
        // worktree never binds to a saved WorkspaceDoc — see
        // WorkspaceCanvas.tsx's module doc); this only ever targets
        // `scratchCanvas`, never `workspaceDocs`.
        toggleWorktreeToolsTile: () =>
          set((s) => {
            const key = layoutKey(s);
            if (!key) return s;
            const cur = s.layoutByWorktree[key] ?? DEFAULT_WORKTREE_LAYOUT;
            const canvas = cur.scratchCanvas;
            // Nothing to toggle before the canvas has been seeded (e.g. a
            // click landing before WorkspaceCanvas's seed effect commits) —
            // no-op rather than creating a canvas containing only a tools
            // tile, which would starve the seed effect of ever running.
            if (!canvas) return s;
            // Same fallback resolution WorkspaceCanvas itself uses for
            // `placedToolWorktrees`/`paneKeyForTile` (tile.worktreeId ??
            // the worktree this canvas is being viewed in) — must match, or
            // this can add a second tools tile sharing one pane key/outlet.
            const existing = canvas.tiles.find(
              (t) => t.kind === "tools" && (t.worktreeId ?? key) === key,
            );
            const nextCanvas = existing
              ? removeTileFromCanvas(canvas, existing.id)
              : insertTileIntoCanvas(canvas, "tools", undefined, key, key);
            return {
              layoutByWorktree: {
                ...s.layoutByWorktree,
                [key]: { ...cur, scratchCanvas: nextCanvas },
              },
            };
          }),
        setActiveWorktree: (projectId, worktreeId, sessions) =>
          set((s) => {
            // Idempotency: if re-tapping the same worktree with an active session, no-op
            if (worktreeId === s.activeWorktreeId && s.activeSessionId != null) {
              return s;
            }

            // Compute default agent session: lastSessionByWorktree → main slot → first agent → null
            let defaultSessionId: string | null = null;
            const lastInWorktree = s.lastSessionByWorktree[worktreeId];
            const agents = sessions?.filter((ss) => ss.type === "agent");
            if (lastInWorktree && agents?.some((ss) => ss.id === lastInWorktree)) {
              defaultSessionId = lastInWorktree;
            } else if (agents) {
              const mainSlot = agents.find((ss) => ss.isMain);
              defaultSessionId = mainSlot?.id ?? agents[0]?.id ?? null;
            }

            // Compute default terminal session: lastTerminalByWorktree → first terminal → null
            let defaultTerminalId: string | null = null;
            const terminals = sessions?.filter((ss) => ss.type === "terminal");
            const lastTerm = s.lastTerminalByWorktree[worktreeId];
            if (lastTerm && terminals?.some((ss) => ss.id === lastTerm)) {
              defaultTerminalId = lastTerm;
            } else if (terminals) {
              defaultTerminalId = terminals[0]?.id ?? null;
            }

            return {
              activeProjectId: projectId,
              activeWorktreeId: worktreeId,
              activeSessionId: defaultSessionId,
              activeTerminalSessionId: defaultTerminalId,
              activeFilePath: s.lastFileByWorktree[worktreeId] ?? null,
            };
          }),
        // Restore the last file for this project context, mirroring what
        // setActiveWorktree does for worktrees. Entering a direct session used
        // to leave activeFilePath at whatever the previous context had.
        setActiveDirectContext: (projectId) =>
          set((s) => {
            if (projectId == null) return { activeDirectContextId: null };
            return {
              activeDirectContextId: projectId,
              activeFilePath: s.lastFileByWorktree[projectId] ?? null,
            };
          }),
        setActiveSession: (sessionId) =>
          set((s) => {
            const key = layoutKey(s);
            const nextLast =
              key != null
                ? { ...s.lastSessionByWorktree, [key]: sessionId }
                : s.lastSessionByWorktree;
            return { activeSessionId: sessionId, lastSessionByWorktree: nextLast };
          }),
        setActiveTerminalSession: (sessionId) =>
          set((s) => {
            const key = layoutKey(s);
            const nextLast =
              key != null
                ? { ...s.lastTerminalByWorktree, [key]: sessionId }
                : s.lastTerminalByWorktree;
            return { activeTerminalSessionId: sessionId, lastTerminalByWorktree: nextLast };
          }),
        // Keyed by layoutKey (worktree id, or the direct-session project id) —
        // NOT activeWorktreeId, which is always null for a direct session and
        // so silently dropped their open file from the restore map.
        // setActiveSession/setActiveTerminalSession above already do this.
        setActiveFile: (path) =>
          set((s) => {
            const key = layoutKey(s);
            const nextLastFile =
              path && key != null
                ? { ...s.lastFileByWorktree, [key]: path }
                : s.lastFileByWorktree;
            return { activeFilePath: path, lastFileByWorktree: nextLastFile };
          }),
        setFileScroll: (worktreeId, filePath, scrollTop) =>
          set((s) => ({
            fileScrollByKey: { ...s.fileScrollByKey, [`${worktreeId}:${filePath}`]: scrollTop },
          })),
        setDiffScopeForWorktree: (worktreeId, scope) =>
          set((s) => ({
            diffScopeByWorktree: { ...s.diffScopeByWorktree, [worktreeId]: scope },
          })),
        bumpPreviewFont: (delta) =>
          set((s) => ({
            previewFontScale: Math.min(1.5, Math.max(0.75, Math.round((s.previewFontScale + delta) * 100) / 100)),
          })),
        toggleFileTree: () => set((s) => ({ fileTreeVisible: !s.fileTreeVisible })),
        bumpTerminalFont: (delta) =>
          set((s) => ({
            terminalFontScale: Math.min(1.5, Math.max(0.75, Math.round((s.terminalFontScale + delta) * 100) / 100)),
          })),
        toggleLeftSidebarCollapsed: () =>
          set((s) => ({ leftSidebarCollapsed: !s.leftSidebarCollapsed })),
        setLeftSidebarWidthPx: (px) => set({ leftSidebarWidthPx: clampLeftSidebarWidth(px) }),
        setMobileSidebarOpen: (open) => set({ mobileSidebarOpen: open }),
        toggleInactiveWorktreesFilter: () =>
          set((s) => ({ hideInactiveWorktrees: !s.hideInactiveWorktrees })),
        toggleAgentStatusBorders: () =>
          set((s) => ({ showAgentStatusBorders: !s.showAgentStatusBorders })),
        setWorkspacePaneFullscreen: (next) => set({ workspacePaneFullscreen: next }),
        clearWorkspaceSelection: () =>
          set({
            activeProjectId: null,
            activeWorktreeId: null,
            activeDirectContextId: null,
            activeSessionId: null,
            activeTerminalSessionId: null,
            activeFilePath: null,
            workspacePaneFullscreen: null,
          }),
        toggleDotFiles: () => set((s) => ({ showDotFiles: !s.showDotFiles })),
        patchSessionState: (sessionId, state) =>
          set((s) => ({
            sessionStates: { ...s.sessionStates, [sessionId]: state },
          })),
        syncSessionsFromApi: (sessions) =>
          set((s) => {
            const next = { ...s.sessionStates };
            for (const sess of sessions) {
              next[sess.id] = sess.state;
            }
            return { sessionStates: next };
          }),
        markSessionAttachPending: (sessionId) =>
          set((s) => ({
            sessionAttachState: { ...s.sessionAttachState, [sessionId]: "pending" },
          })),
        markSessionAttached: (sessionId) =>
          set((s) => ({
            sessionAttachState: { ...s.sessionAttachState, [sessionId]: "attached" },
          })),
        clearSessionAttach: (sessionId) =>
          set((s) => {
            const next = { ...s.sessionAttachState };
            delete next[sessionId];
            return { sessionAttachState: next };
          }),
        setSortOrder: (scopeKey, orderedIds) =>
          set((s) => ({
            sortOrders: { ...s.sortOrders, [scopeKey]: orderedIds },
          })),
        createWorkspace: (contextKey, name, mode) => {
          const id = randomId();
          set((s) => ({
            workspaceDocs: {
              ...s.workspaceDocs,
              [id]: {
                id,
                name,
                contextKey,
                mode,
                tiles: [],
                tree: null,
                freeRects: {},
              },
            },
          }));
          return id;
        },
        renameWorkspace: (id, name) =>
          set((s) => {
            const doc = s.workspaceDocs[id];
            if (!doc) return s;
            return {
              workspaceDocs: { ...s.workspaceDocs, [id]: { ...doc, name } },
            };
          }),
        deleteWorkspace: (id) =>
          set((s) => {
            const next = { ...s.workspaceDocs };
            delete next[id];
            return { workspaceDocs: next };
          }),
        updateWorkspaceDoc: (id, patch) =>
          set((s) => {
            const doc = s.workspaceDocs[id];
            if (!doc) return s;
            return {
              workspaceDocs: { ...s.workspaceDocs, [id]: { ...doc, ...patch } },
            };
          }),
        insertTileIntoWorkspaceDoc: (docId, kind, sessionId, tileWorktreeId) =>
          set((s) => {
            const doc = s.workspaceDocs[docId];
            if (!doc) return s;
            const next = insertTileIntoCanvas(doc, kind, sessionId, tileWorktreeId, doc.contextKey);
            return {
              workspaceDocs: { ...s.workspaceDocs, [docId]: { ...doc, ...next } },
            };
          }),
        relinkSessionTiles: (fromSessionId, toSessionId) =>
          set((s) => {
            let layoutChanged = false;
            const nextLayoutByWorktree = { ...s.layoutByWorktree };
            for (const [worktreeId, layout] of Object.entries(s.layoutByWorktree)) {
              if (!layout.scratchCanvas) continue;
              const relinked = relinkSessionInCanvas(layout.scratchCanvas, fromSessionId, toSessionId);
              if (relinked !== layout.scratchCanvas) {
                nextLayoutByWorktree[worktreeId] = { ...layout, scratchCanvas: relinked };
                layoutChanged = true;
              }
            }
            let docsChanged = false;
            const nextWorkspaceDocs = { ...s.workspaceDocs };
            for (const [docId, doc] of Object.entries(s.workspaceDocs)) {
              const relinked = relinkSessionInCanvas(doc, fromSessionId, toSessionId);
              if (relinked !== doc) {
                nextWorkspaceDocs[docId] = { ...doc, ...relinked };
                docsChanged = true;
              }
            }
            if (!layoutChanged && !docsChanged) return s;
            return {
              ...(layoutChanged ? { layoutByWorktree: nextLayoutByWorktree } : {}),
              ...(docsChanged ? { workspaceDocs: nextWorkspaceDocs } : {}),
            };
          }),
        reorderWorkspace: (scopeKey, orderedIds) =>
          set((s) => ({
            workspaceOrder: { ...s.workspaceOrder, [scopeKey]: orderedIds },
          })),
        setActiveWorkspace: (worktreeId, workspaceId) =>
          set((s) => {
            const cur = s.layoutByWorktree[worktreeId] ?? DEFAULT_WORKTREE_LAYOUT;
            return {
              layoutByWorktree: {
                ...s.layoutByWorktree,
                [worktreeId]: { ...cur, activeWorkspaceId: workspaceId },
              },
            };
          }),
        setLayoutMode: (worktreeId, mode) =>
          set((s) => {
            const cur = s.layoutByWorktree[worktreeId] ?? DEFAULT_WORKTREE_LAYOUT;
            return {
              layoutByWorktree: {
                ...s.layoutByWorktree,
                [worktreeId]: { ...cur, layoutMode: mode },
              },
            };
          }),
        updateScratchCanvas: (worktreeId, patch) =>
          set((s) => {
            const cur = s.layoutByWorktree[worktreeId] ?? DEFAULT_WORKTREE_LAYOUT;
            const scratch = cur.scratchCanvas ?? EMPTY_CANVAS_GEOMETRY;
            return {
              layoutByWorktree: {
                ...s.layoutByWorktree,
                [worktreeId]: { ...cur, scratchCanvas: { ...scratch, ...patch } },
              },
            };
          }),
        clearScratchCanvas: (worktreeId) =>
          set((s) => {
            const cur = s.layoutByWorktree[worktreeId];
            if (!cur || cur.scratchCanvas == null) return s;
            return {
              layoutByWorktree: {
                ...s.layoutByWorktree,
                [worktreeId]: { ...cur, scratchCanvas: null },
              },
            };
          }),
      };
    },
    {
      name: "vibestation:workspace",
      version: 16,
      migrate: (persisted, version) => {
        const p = persisted as Record<string, unknown> | null;
        if (!p || typeof p !== "object") return persisted;
        // v1/v2 → v3: move global terminalPosition+paneCollapsed into layoutByWorktree
        if (!p.layoutByWorktree) {
          p.layoutByWorktree = {};
        }
        // <v5 → v5: the old per-worktree layout was { terminalPosition, paneCollapsed:
        // [treeHidden, previewHidden, terminalHidden] }. Map it onto the new
        // { toolPanelVisible, toolPanelTab, terminalDockVisible } region model.
        if (version < 5) {
          const old = p.layoutByWorktree as Record<string, unknown>;
          const next: Record<string, WorktreeLayout> = {};
          for (const [wt, raw] of Object.entries(old ?? {})) {
            const entry = raw as { paneCollapsed?: boolean[] } | undefined;
            const pc = entry?.paneCollapsed ?? [true, true, false];
            const treeVisible = !pc[0];
            const previewVisible = !pc[1];
            const terminalVisible = !pc[2];
            next[wt] = {
              toolPanelVisible: treeVisible || previewVisible,
              toolPanelTab: "files",
              terminalDockVisible: terminalVisible,
              toolSplitOrientation: "horizontal",
              layoutMode: "classic",
              activeWorkspaceId: null,
              scratchCanvas: null,
              canvasToolbarVisible: true,
            };
          }
          p.layoutByWorktree = next;
          p.lastTerminalByWorktree = {};
        }
        // v6 → v7: the file tree briefly lived in its own pane (fileTreeVisible +
        // a "files"-less ToolTab). It's back as a tool-panel tab — fold the
        // separate-tree state back in: if the tree was open, select the Files tab.
        if (version === 6) {
          const old = p.layoutByWorktree as Record<string, unknown>;
          const next: Record<string, WorktreeLayout> = {};
          for (const [wt, raw] of Object.entries(old ?? {})) {
            const entry = raw as {
              fileTreeVisible?: boolean;
              toolPanelVisible?: boolean;
              toolPanelTab?: string;
              terminalDockVisible?: boolean;
            } | undefined;
            const treeWasOpen = entry?.fileTreeVisible ?? true;
            next[wt] = {
              toolPanelVisible: (entry?.toolPanelVisible ?? true) || treeWasOpen,
              toolPanelTab: (treeWasOpen ? "files" : (entry?.toolPanelTab ?? "files")) as ToolTab,
              terminalDockVisible: entry?.terminalDockVisible ?? false,
              toolSplitOrientation: "horizontal",
              layoutMode: "classic",
              activeWorkspaceId: null,
              scratchCanvas: null,
              canvasToolbarVisible: true,
            };
          }
          p.layoutByWorktree = next;
        }
        // v7 → v8: the Browser and Emulator tabs merged into a single "devices"
        // tab. Map either legacy tab onto "devices"; other tabs are unchanged.
        if (version < 8) {
          const old = p.layoutByWorktree as Record<string, unknown>;
          const next: Record<string, WorktreeLayout> = {};
          for (const [wt, raw] of Object.entries(old ?? {})) {
            const entry = raw as {
              toolPanelVisible?: boolean;
              toolPanelTab?: string;
              terminalDockVisible?: boolean;
            } | undefined;
            const tab = entry?.toolPanelTab;
            next[wt] = {
              toolPanelVisible: entry?.toolPanelVisible ?? true,
              toolPanelTab: (tab === "browser" || tab === "emulator" ? "devices" : (tab ?? "files")) as ToolTab,
              terminalDockVisible: entry?.terminalDockVisible ?? false,
              toolSplitOrientation: "horizontal",
              layoutMode: "classic",
              activeWorkspaceId: null,
              scratchCanvas: null,
              canvasToolbarVisible: true,
            };
          }
          p.layoutByWorktree = next;
        }
        // v8 → v9: Preview merged into the Files tool (master-detail tree +
        // preview). Map a stored "preview" tab onto "files".
        if (version < 9) {
          const old = p.layoutByWorktree as Record<string, unknown>;
          const next: Record<string, WorktreeLayout> = {};
          for (const [wt, raw] of Object.entries(old ?? {})) {
            const entry = raw as {
              toolPanelVisible?: boolean;
              toolPanelTab?: string;
              terminalDockVisible?: boolean;
            } | undefined;
            const tab = entry?.toolPanelTab;
            next[wt] = {
              toolPanelVisible: entry?.toolPanelVisible ?? true,
              toolPanelTab: (tab === "preview" ? "files" : (tab ?? "files")) as ToolTab,
              terminalDockVisible: entry?.terminalDockVisible ?? false,
              toolSplitOrientation: "horizontal",
              layoutMode: "classic",
              activeWorkspaceId: null,
              scratchCanvas: null,
              canvasToolbarVisible: true,
            };
          }
          p.layoutByWorktree = next;
        }
        // v9 → v10: add the agent↔tools split orientation (default horizontal).
        if (version < 10) {
          const old = p.layoutByWorktree as Record<string, unknown>;
          const next: Record<string, WorktreeLayout> = {};
          for (const [wt, raw] of Object.entries(old ?? {})) {
            const entry = raw as Partial<WorktreeLayout> | undefined;
            next[wt] = {
              toolPanelVisible: entry?.toolPanelVisible ?? true,
              toolPanelTab: (entry?.toolPanelTab ?? "files") as ToolTab,
              terminalDockVisible: entry?.terminalDockVisible ?? false,
              toolSplitOrientation: entry?.toolSplitOrientation ?? "horizontal",
              layoutMode: entry?.layoutMode ?? "classic",
              activeWorkspaceId: entry?.activeWorkspaceId ?? null,
              scratchCanvas: entry?.scratchCanvas ?? null,
              canvasToolbarVisible: entry?.canvasToolbarVisible ?? true,
            };
          }
          p.layoutByWorktree = next;
        }
        // v10 → v11: "hide done" now defaults ON. Existing browsers persisted the
        // old `false` default, so done worktrees stayed visible on machines other
        // than the one where the filter was toggled. Flip legacy persisted state to
        // the new default so done worktrees hide consistently across clients.
        if (version < 11) {
          p.hideInactiveWorktrees = true;
        }
        // v11 → v13 (v12 had no layoutByWorktree shape change): add layoutMode +
        // activeWorkspaceId to every existing WorktreeLayout entry, default classic/null.
        if (version < 13) {
          const old = p.layoutByWorktree as Record<string, unknown>;
          const next: Record<string, WorktreeLayout> = {};
          for (const [wt, raw] of Object.entries(old ?? {})) {
            const entry = raw as Partial<WorktreeLayout> | undefined;
            next[wt] = {
              toolPanelVisible: entry?.toolPanelVisible ?? true,
              toolPanelTab: (entry?.toolPanelTab ?? "files") as ToolTab,
              terminalDockVisible: entry?.terminalDockVisible ?? false,
              toolSplitOrientation: entry?.toolSplitOrientation ?? "horizontal",
              layoutMode: entry?.layoutMode ?? "classic",
              activeWorkspaceId: entry?.activeWorkspaceId ?? null,
              scratchCanvas: entry?.scratchCanvas ?? null,
              canvasToolbarVisible: entry?.canvasToolbarVisible ?? true,
            };
          }
          p.layoutByWorktree = next;
          if (!p.workspaceDocs) p.workspaceDocs = {};
          if (!p.workspaceOrder) p.workspaceOrder = {};
        }
        // v13 → v14: workspace mode no longer auto-creates a named WorkspaceDoc.
        // Add the transient `scratchCanvas` slot (null = "nothing scratched yet",
        // seeded lazily from the worktree's live panes on first entry).
        if (version < 14) {
          const old = p.layoutByWorktree as Record<string, unknown>;
          const next: Record<string, WorktreeLayout> = {};
          for (const [wt, raw] of Object.entries(old ?? {})) {
            const entry = raw as Partial<WorktreeLayout> | undefined;
            next[wt] = {
              toolPanelVisible: entry?.toolPanelVisible ?? true,
              toolPanelTab: (entry?.toolPanelTab ?? "files") as ToolTab,
              terminalDockVisible: entry?.terminalDockVisible ?? false,
              toolSplitOrientation: entry?.toolSplitOrientation ?? "horizontal",
              layoutMode: entry?.layoutMode ?? "classic",
              activeWorkspaceId: entry?.activeWorkspaceId ?? null,
              scratchCanvas: entry?.scratchCanvas ?? null,
              canvasToolbarVisible: entry?.canvasToolbarVisible ?? true,
            };
          }
          p.layoutByWorktree = next;
        }
        // v14 → v15: workspace detachment (agent-interaction-workspaces/04-workspaces
        // Phase 3a, Decision 5/Risk #7). A saved WorkspaceDoc is no longer owned by
        // the worktree it was created in — viewing one moves to the route-driven
        // `/workspaces/:id` view (Decision 4), not `layoutByWorktree[wtId].
        // activeWorkspaceId`. That pointer's old meaning ("this worktree's canvas
        // is currently showing saved workspace X") is gone, so clear any entry that
        // still points at a saved doc — leaving it would make WorkspaceCanvas's
        // per-worktree flow (Phase 3c) incorrectly think it's still displaying that
        // now-detached doc. `contextKey` itself is untouched — kept as provenance
        // (Decision 5), no data loss, no doc dropped from `workspaceDocs`.
        if (version < 15) {
          const old = p.layoutByWorktree as Record<string, unknown>;
          const docs = (p.workspaceDocs ?? {}) as Record<string, unknown>;
          const next: Record<string, WorktreeLayout> = {};
          for (const [wt, raw] of Object.entries(old ?? {})) {
            const entry = raw as Partial<WorktreeLayout> | undefined;
            const pointsAtSavedDoc = !!entry?.activeWorkspaceId && !!docs[entry.activeWorkspaceId];
            next[wt] = {
              toolPanelVisible: entry?.toolPanelVisible ?? true,
              toolPanelTab: (entry?.toolPanelTab ?? "files") as ToolTab,
              terminalDockVisible: entry?.terminalDockVisible ?? false,
              toolSplitOrientation: entry?.toolSplitOrientation ?? "horizontal",
              layoutMode: entry?.layoutMode ?? "classic",
              activeWorkspaceId: pointsAtSavedDoc ? null : (entry?.activeWorkspaceId ?? null),
              scratchCanvas: entry?.scratchCanvas ?? null,
              canvasToolbarVisible: entry?.canvasToolbarVisible ?? true,
            };
          }
          p.layoutByWorktree = next;
        }
        // v15 → v16: canvas-mode toolbar disclosure (the workspace-canvas
        // toolbar's TopBar placement gained a show/hide control). Default
        // visible for every existing entry — the toolbar is the canvas's
        // primary UI, so a silent default-hidden would make canvas mode look
        // broken on first load post-upgrade.
        if (version < 16) {
          const old = p.layoutByWorktree as Record<string, unknown>;
          const next: Record<string, WorktreeLayout> = {};
          for (const [wt, raw] of Object.entries(old ?? {})) {
            const entry = raw as Partial<WorktreeLayout> | undefined;
            next[wt] = {
              toolPanelVisible: entry?.toolPanelVisible ?? true,
              toolPanelTab: (entry?.toolPanelTab ?? "files") as ToolTab,
              terminalDockVisible: entry?.terminalDockVisible ?? false,
              toolSplitOrientation: entry?.toolSplitOrientation ?? "horizontal",
              layoutMode: entry?.layoutMode ?? "classic",
              activeWorkspaceId: entry?.activeWorkspaceId ?? null,
              scratchCanvas: entry?.scratchCanvas ?? null,
              canvasToolbarVisible: entry?.canvasToolbarVisible ?? true,
            };
          }
          p.layoutByWorktree = next;
        }
        return p;
      },
      partialize: (s) => ({
        layoutByWorktree: s.layoutByWorktree,
        activeProjectId: s.activeProjectId,
        activeWorktreeId: s.activeWorktreeId,
        activeSessionId: s.activeSessionId,
        activeTerminalSessionId: s.activeTerminalSessionId,
        activeFilePath: s.activeFilePath,
        lastFileByWorktree: s.lastFileByWorktree,
        fileScrollByKey: s.fileScrollByKey,
        showDotFiles: s.showDotFiles,
        sessionStates: s.sessionStates,
        lastSessionByWorktree: s.lastSessionByWorktree,
        lastTerminalByWorktree: s.lastTerminalByWorktree,
        diffScopeByWorktree: s.diffScopeByWorktree,
        previewFontScale: s.previewFontScale,
        fileTreeVisible: s.fileTreeVisible,
        terminalFontScale: s.terminalFontScale,
        leftSidebarCollapsed: s.leftSidebarCollapsed,
        leftSidebarWidthPx: s.leftSidebarWidthPx,
        hideInactiveWorktrees: s.hideInactiveWorktrees,
        showAgentStatusBorders: s.showAgentStatusBorders,
        sortOrders: s.sortOrders,
        workspaceDocs: s.workspaceDocs,
        workspaceOrder: s.workspaceOrder,
      }),
    },
  ),
);
