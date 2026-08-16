import "@/styles/workspace-canvas.css";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Bot, Check, FolderOpen, GitBranch, Minimize2, MoreVertical, PanelRight, Plus, Save, SquareTerminal, X } from "lucide-react";
import type { Project, Session, Worktree } from "@/api/types";
import {
  buildBalancedTree,
  findLeafId,
  insertPane,
  removePane,
  resizeSplit,
  swapPanes,
  type LayoutNode,
  type Side,
  type SplitNode,
} from "@/lib/tiling";
import {
  useWorkspaceStore,
  insertTileIntoCanvas,
  removeTileFromCanvas,
  type CanvasGeometry,
  type FreeRect,
  type TileKind,
  type TileSpec,
} from "@/hooks/useStore";
import { PaneOutlet, usePaneOutletElement, WORKSPACE_CANVAS_TOOLBAR_KEY } from "@/components/layout/paneOutlets";
import { StatusDot } from "@/components/layout/StatusDot";
import { sessionStatus } from "@/lib/worktreeStatus";
import { sessionLabel } from "@/lib/sessionLabel";
import { randomId } from "@/lib/uuid";
import { api } from "@/api";
import { NewTabDialog } from "@/components/dialogs/NewTabDialog";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";

interface WorkspaceCanvasProps {
  /**
   * Owning worktree for the classic per-worktree flow (scratch canvas +
   * `layoutByWorktree[worktreeId].activeWorkspaceId`). In detached-workspace-
   * view mode (`detachedWorkspaceId` set — agent-interaction-workspaces/
   * 04-workspaces Phase 3c) this is used only as a provenance fallback for
   * anything that needs *some* worktreeId (e.g. a tile missing its own
   * `tile.worktreeId`) — pass the doc's own `contextKey` in that case.
   */
  worktreeId: string;
  /** This worktree's agent-type sessions. */
  agentSessions: Session[];
  /** This worktree's terminal-type sessions. */
  terminalSessions: Session[];
  /** Mirrors Layout.tsx's `hasToolPanel` check — whether a tools region exists at all. */
  hasTools: boolean;
  /** Mirrors Layout.tsx's `showToolPanel` — omit the tools tile's outlet when hidden. */
  toolPanelVisible: boolean;
  /** Mirrors Layout.tsx's `showTerminalDock` — omit terminal tiles' outlets when hidden. */
  terminalDockVisible: boolean;
  /** EVERY session app-wide — a SAVED workspace can tile panes from other worktrees. */
  allSessions: Session[];
  /** Every worktree app-wide (picker grouping + cross-context tile labels). */
  worktrees: Worktree[];
  /** Every project app-wide (picker grouping). */
  projects: Project[];
  /**
   * Detached-workspace-view mode: when set, the canvas binds directly to
   * `workspaceDocs[detachedWorkspaceId]` — the ONLY place a saved doc is ever
   * bound to this component. The classic per-worktree placement (this prop
   * unset) never binds to a saved doc at all, always the worktree's own
   * `scratchCanvas` — see the module doc comment. The caller (Workspace.tsx)
   * has already confirmed the doc exists before rendering with this prop set.
   */
  detachedWorkspaceId?: string;
  /**
   * Whether this canvas's own dedicated toolbar row (mode toggle / doc name
   * / save / add tile), rendered directly above the canvas body, should show
   * right now. Driven by `layoutByWorktree[worktreeId].canvasToolbarVisible`
   * — the flag the disclosure chevron in TopBar's canvas chip toggles
   * (`useLayout().canvasToolbarVisible`). The detached `/workspaces/:id`
   * view passes a hardcoded `true`: it has no disclosure control, and its
   * toolbar lives portaled top-right in TopBar rather than in this row.
   */
  canvasToolbarVisible: boolean;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function paneKeyForTile(tile: TileSpec, worktreeId: string): string {
  if (tile.kind === "tools") return `tools:${tile.worktreeId ?? worktreeId}`;
  return `${tile.kind}:${tile.sessionId}`;
}

/** Drop zones of a tile under a dragged tile — VS Code / dockview's 4-edge + center model. */
type DropZone = Side | "center";

/** Edge band depth as a fraction of the target tile (each edge 25%, center 50%). */
const EDGE_FRACTION = 0.25;

interface DropTarget {
  targetTileId: string;
  zone: DropZone;
  /** Highlight rect, in px relative to the canvas body element. */
  rect: { left: number; top: number; width: number; height: number };
}

/**
 * Tiled/free-form canvas for workspace-mode.
 *
 * Backing store: for the classic per-worktree placement this is ALWAYS the
 * worktree's transient `scratchCanvas` — a worktree is either in canvas mode
 * or not, full stop, it never "remembers" a saved workspace. Saving promotes
 * the scratch canvas into a real, named, detached `WorkspaceDoc` and
 * navigates away to its own `/workspaces/:id` route (`saveAsWorkspace`
 * below) — that route is the ONLY place a saved doc is ever viewed/edited,
 * via `detachedWorkspaceId`/`isDetachedView`. Both placements expose the
 * same `CanvasGeometry` shape, so everything below — rendering, drag,
 * resize, tiling — runs against `canvas`/`patchCanvas()` regardless of which
 * is live. Only a SAVED (detached) workspace may host cross-worktree tiles.
 *
 * Per tile it renders a chrome wrapper hosting a <PaneOutlet> that
 * PaneHostLayer (mounted once, unconditionally, by the caller) portals the
 * live pane into — panes are never mounted here (AGENTS.md invariant).
 */
export function WorkspaceCanvas({
  worktreeId,
  agentSessions,
  terminalSessions,
  hasTools,
  toolPanelVisible,
  terminalDockVisible,
  allSessions,
  worktrees,
  projects,
  detachedWorkspaceId,
  canvasToolbarVisible,
}: WorkspaceCanvasProps) {
  const layoutByWorktree = useWorkspaceStore((s) => s.layoutByWorktree);
  const workspaceDocs = useWorkspaceStore((s) => s.workspaceDocs);
  const showAgentStatusBorders = useWorkspaceStore((s) => s.showAgentStatusBorders);
  const navigate = useNavigate();

  const isDetachedView = !!detachedWorkspaceId;
  // Classic per-worktree placement NEVER reads a saved doc — see the module
  // doc comment above. `savedDoc`/`isSaved` are only ever true for the
  // detached `/workspaces/:id` view.
  const savedDoc = isDetachedView ? workspaceDocs[detachedWorkspaceId as string] : undefined;
  const savedDocId = savedDoc?.id ?? null;
  const scratch = isDetachedView ? null : (layoutByWorktree[worktreeId]?.scratchCanvas ?? null);
  /** The live canvas: the saved doc for the detached view, else the transient scratch. */
  const canvas: CanvasGeometry | null = savedDoc ?? scratch;
  const isSaved = !!savedDoc;

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const canvasBodyRef = useRef<HTMLDivElement | null>(null);
  const tileRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const splitRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const [pickerOpen, setPickerOpen] = useState(false);
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  // Agent tile "⋯" popup — same actions as the agent tab bar's right-click
  // menu (Reset / Reset with handoff) plus Terminate (mirrors the tab bar's
  // "×" close). Only one tile's menu can be open at a time, mirroring
  // TabsStrip's `resetMenu`.
  const [tileMenu, setTileMenu] = useState<{ tileId: string; x: number; y: number } | null>(null);
  const [resetTarget, setResetTarget] = useState<Session | null>(null);
  const [resetHandoff, setResetHandoff] = useState(false);
  const [terminateTarget, setTerminateTarget] = useState<{ tileId: string; session: Session } | null>(null);
  const [savePromptOpen, setSavePromptOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [draggingTileId, setDraggingTileId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  // mouseup reads the hover through a ref — the window listener closes over the
  // render that started the drag, so React state alone would be stale there.
  const dropTargetRef = useRef<DropTarget | null>(null);
  /** Tile currently expanded to fill the viewport — toggled by clicking (not
   *  dragging) its title bar. Null = no tile is fullscreen. */
  const [fullscreenTileId, setFullscreenTileId] = useState<string | null>(null);
  function toggleFullscreen(tileId: string) {
    setFullscreenTileId((cur) => (cur === tileId ? null : tileId));
  }
  // Escape backs out of fullscreen — standard convention, cheap to support.
  useEffect(() => {
    if (!fullscreenTileId) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setFullscreenTileId(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullscreenTileId]);

  /** Close-on-outside must attach after the opening click finishes (same tap
   *  would otherwise immediately close the picker it just opened) — same
   *  deferred pattern as the sidebar's kebab menus (LeftSidebar.tsx). */
  useEffect(() => {
    if (!pickerOpen) return undefined;
    let removeListeners: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      function onDocClick(ev: MouseEvent) {
        const t = ev.target as HTMLElement;
        if (t.closest("[data-workspace-canvas-picker-panel]") || t.closest("[data-workspace-canvas-picker-trigger]")) return;
        setPickerOpen(false);
      }
      function onKey(ev: KeyboardEvent) {
        if (ev.key === "Escape") setPickerOpen(false);
      }
      document.addEventListener("click", onDocClick);
      document.addEventListener("keydown", onKey);
      removeListeners = () => {
        document.removeEventListener("click", onDocClick);
        document.removeEventListener("keydown", onKey);
      };
    }, 0);
    return () => {
      window.clearTimeout(timer);
      removeListeners?.();
    };
  }, [pickerOpen]);

  /** Same deferred close-on-outside pattern as the picker above and
   *  TabsStrip's `resetMenu` (portaled panel → tag it, check `closest`). */
  useEffect(() => {
    if (!tileMenu) return undefined;
    let removeListeners: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      function onDocClick(ev: MouseEvent) {
        const t = ev.target as HTMLElement;
        if (t.closest("[data-workspace-canvas-tile-menu-panel]")) return;
        setTileMenu(null);
      }
      function onKey(ev: KeyboardEvent) {
        if (ev.key === "Escape") setTileMenu(null);
      }
      document.addEventListener("click", onDocClick);
      document.addEventListener("keydown", onKey);
      removeListeners = () => {
        document.removeEventListener("click", onDocClick);
        document.removeEventListener("keydown", onKey);
      };
    }, 0);
    return () => {
      window.clearTimeout(timer);
      removeListeners?.();
    };
  }, [tileMenu]);

  /** Read the CURRENT canvas straight from the store (drag handlers, post-mount). */
  function readCanvas(): CanvasGeometry | null {
    const store = useWorkspaceStore.getState();
    if (savedDocId) return store.workspaceDocs[savedDocId] ?? null;
    return store.layoutByWorktree[worktreeId]?.scratchCanvas ?? null;
  }

  /** Write to whichever backing store is live. */
  function patchCanvas(patch: Partial<CanvasGeometry>) {
    const store = useWorkspaceStore.getState();
    if (savedDocId) store.updateWorkspaceDoc(savedDocId, patch);
    else store.updateScratchCanvas(worktreeId, patch);
  }

  // Seed the transient canvas the first time workspace mode is entered for this
  // worktree with nothing saved selected — from whatever panes are already open.
  // This creates NO WorkspaceDoc (that's what "Save as workspace" is for), so
  // nothing appears in the sidebar's Workspaces list until the user asks for it.
  const seededForRef = useRef<string | null>(null);
  useEffect(() => {
    // Detached view has no scratch canvas to seed — a missing doc here means
    // "not found," which the caller (Workspace.tsx) already redirects away
    // from before this ever renders; nothing to do on this component's side.
    if (isDetachedView) return;
    if (canvas) {
      seededForRef.current = null;
      return;
    }
    if (seededForRef.current === worktreeId) return;
    seededForRef.current = worktreeId;

    const tiles: TileSpec[] = [];
    const freeRects: Record<string, FreeRect> = {};
    let cascade = 0;
    const push = (kind: TileKind, sessionId?: string) => {
      const id = randomId();
      tiles.push({ id, kind, sessionId });
      freeRects[id] = {
        x: 4 + (cascade % 5) * 5,
        y: 4 + (cascade % 5) * 5,
        w: 44,
        h: 44,
      };
      cascade += 1;
    };
    for (const s of agentSessions) push("agent", s.id);
    for (const s of terminalSessions) push("terminal", s.id);
    if (hasTools) push("tools");

    useWorkspaceStore
      .getState()
      .updateScratchCanvas(worktreeId, { mode: "free", tiles, tree: null, freeRects });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreeId, canvas]);

  // MUST run before the early return below (rules-of-hooks) — every hook in
  // this component has to execute on every render regardless of `canvas`.
  //
  // Only the DETACHED /workspaces/:id view portals its toolbar up into
  // TopBar (top-right, where that page has room). The classic per-worktree
  // canvas keeps its toolbar as its OWN dedicated row above the body — see
  // the render below — so `toolbarPortalEl` stays null there even when some
  // other route has an outlet registered.
  const toolbarOutletEl = usePaneOutletElement(WORKSPACE_CANVAS_TOOLBAR_KEY);
  const toolbarPortalEl = isDetachedView ? toolbarOutletEl : null;

  // Reconcile a dangling `fullscreenTileId` against whatever tile set is
  // CURRENTLY live — every non-fullscreen tile hides via `display:none`
  // (renderTileChrome below), so a fullscreen id pointing at a since-removed
  // tile would hide the entire canvas permanently. Covers `removeTile`
  // below AND any removal that happens outside this component entirely
  // (e.g. the TopBar Tools-tile toggle's store action, which has no way to
  // reach this component-local state directly).
  useEffect(() => {
    if (!canvas) return;
    if (fullscreenTileId && !canvas.tiles.some((t) => t.id === fullscreenTileId)) {
      setFullscreenTileId(null);
    }
  }, [canvas, fullscreenTileId]);

  if (!canvas) {
    return <div className="workspace-canvas workspace-canvas--loading" />;
  }
  // Local alias so TS keeps the non-null narrowing inside the closures below.
  const cv: CanvasGeometry = canvas;

  const sessionById = new Map<string, Session>();
  for (const s of allSessions) sessionById.set(s.id, s);
  for (const s of agentSessions) sessionById.set(s.id, s);
  for (const s of terminalSessions) sessionById.set(s.id, s);
  const worktreeById = new Map(worktrees.map((w) => [w.id, w]));
  const projectById = new Map(projects.map((p) => [p.id, p]));

  const placedSessionIds = new Set(
    cv.tiles.filter((t) => t.sessionId).map((t) => t.sessionId as string),
  );
  const placedToolWorktrees = new Set(
    cv.tiles.filter((t) => t.kind === "tools").map((t) => t.worktreeId ?? worktreeId),
  );
  const availableAgents = agentSessions.filter((s) => !placedSessionIds.has(s.id));
  const availableTerminals = terminalSessions.filter((s) => !placedSessionIds.has(s.id));
  const canAddTools = hasTools && !placedToolWorktrees.has(worktreeId);

  /**
   * Cross-context picker content — ONLY offered for a saved workspace. A
   * transient canvas stays single-worktree by design (the caller's
   * PaneHostLayer scope for it is exactly this worktree's panes).
   */
  const otherContextGroups = !isSaved
    ? []
    : projects
        .map((project) => ({
          project,
          worktrees: worktrees
            .filter((w) => w.projectId === project.id && w.id !== worktreeId)
            .map((w) => ({
              worktree: w,
              sessions: allSessions.filter(
                (s) =>
                  s.worktreeId === w.id &&
                  (s.type === "agent" || s.type === "terminal") &&
                  !placedSessionIds.has(s.id),
              ),
              canAddTools: !placedToolWorktrees.has(w.id),
            }))
            .filter((entry) => entry.sessions.length > 0 || entry.canAddTools),
        }))
        .filter((group) => group.worktrees.length > 0);

  // Own-worktree canvases always offer "New agent" (below), so the picker is
  // never truly empty there — only the detached workspace view (no New Agent
  // entry, see the picker JSX) can hit the empty state.
  const pickerEmpty =
    isDetachedView &&
    availableAgents.length === 0 &&
    availableTerminals.length === 0 &&
    !canAddTools &&
    otherContextGroups.length === 0;

  function handleModeChange(next: "tiled" | "free") {
    if (cv.mode === next) return;
    if (next === "tiled") {
      const order = [...cv.tiles].sort((a, b) => {
        const ra = cv.freeRects[a.id];
        const rb = cv.freeRects[b.id];
        const ay = ra?.y ?? 0;
        const by = rb?.y ?? 0;
        if (ay !== by) return ay - by;
        return (ra?.x ?? 0) - (rb?.x ?? 0);
      });
      const tree = buildBalancedTree(order.map((t) => t.id));
      patchCanvas({ mode: "tiled", tree });
    } else {
      const rects: Record<string, FreeRect> = {};
      const containerRect = bodyRef.current?.getBoundingClientRect();
      if (containerRect && containerRect.width > 0 && containerRect.height > 0) {
        for (const tile of cv.tiles) {
          const el = tileRefs.current[tile.id];
          if (!el) continue;
          const r = el.getBoundingClientRect();
          rects[tile.id] = {
            x: clamp(((r.left - containerRect.left) / containerRect.width) * 100, 0, 100),
            y: clamp(((r.top - containerRect.top) / containerRect.height) * 100, 0, 100),
            w: clamp((r.width / containerRect.width) * 100, 5, 100),
            h: clamp((r.height / containerRect.height) * 100, 5, 100),
          };
        }
      }
      // Fallback for any tile whose live rect couldn't be read: even cascade.
      cv.tiles.forEach((tile, i) => {
        if (rects[tile.id]) return;
        rects[tile.id] = { x: 4 + (i % 5) * 5, y: 4 + (i % 5) * 5, w: 44, h: 44 };
      });
      patchCanvas({ mode: "free", freeRects: rects });
    }
  }

  function addTile(kind: TileKind, sessionId?: string, tileWorktreeId?: string) {
    // Shared with the Phase 4c auto-insert (Decision 8) — see
    // `insertTileIntoCanvas`'s own doc comment in useStore.ts.
    const next = insertTileIntoCanvas(cv, kind, sessionId, tileWorktreeId, worktreeId);
    patchCanvas(next);
    setPickerOpen(false);
  }

  function removeTile(tileId: string) {
    // Shared with the TopBar Tools-tile toggle (useStore.ts's
    // `toggleWorktreeToolsTile`) — one tree/free-rect removal
    // implementation. `fullscreenTileId` cleanup is handled by the
    // reconciliation effect above, not inline here, so it also covers
    // removals this component didn't itself trigger.
    patchCanvas(removeTileFromCanvas(cv, tileId));
  }

  /**
   * Promote the transient canvas into a real, named, DETACHED WorkspaceDoc:
   * snapshot its geometry, drop the scratch (it's now superseded — this
   * worktree goes back to a fresh, empty canvas next time it's opened), and
   * navigate to the doc's own `/workspaces/:id` route. The worktree never
   * "remembers" the saved doc (no `setActiveWorkspace` call) — from here on
   * the ONLY place this doc is viewed/edited is its own route, where the
   * Add-tile picker also offers other worktrees' panes.
   */
  function saveAsWorkspace() {
    const name = saveName.trim() || "Workspace";
    const cur = readCanvas();
    const store = useWorkspaceStore.getState();
    const id = store.createWorkspace(worktreeId, name, cur?.mode ?? "free");
    if (cur) {
      store.updateWorkspaceDoc(id, { tiles: cur.tiles, tree: cur.tree, freeRects: cur.freeRects });
    }
    store.clearScratchCanvas(worktreeId);
    setSavePromptOpen(false);
    setSaveName("");
    navigate(`/workspaces/${id}`);
  }

  // Free-form drag: window-level mousemove/mouseup, fixed drag-start baseline
  // (Layout.tsx's startSidebarResize idiom) — never incremental against the
  // live rect, or the tile chases the cursor.
  function startDrag(e: React.MouseEvent, tileId: string) {
    e.preventDefault();
    const container = bodyRef.current;
    const rect = cv.freeRects[tileId];
    if (!container || !rect) return;
    const containerRect = container.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startRect = { ...rect };
    // Same threshold idiom as startTileDrag below — without it, the tiniest
    // mouse jitter during a click nudges the tile by a fraction of a percent,
    // AND a plain click (title-bar-click-to-fullscreen) would never reach
    // `onUp` with zero movement to distinguish it from a real drag.
    let armed = false;

    function onMove(ev: MouseEvent) {
      if (!armed) {
        if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 5) return;
        armed = true;
      }
      const dxPct = ((ev.clientX - startX) / containerRect.width) * 100;
      const dyPct = ((ev.clientY - startY) / containerRect.height) * 100;
      const nextX = clamp(startRect.x + dxPct, 0, Math.max(0, 100 - startRect.w));
      const nextY = clamp(startRect.y + dyPct, 0, Math.max(0, 100 - startRect.h));
      const cur = readCanvas();
      if (!cur) return;
      patchCanvas({
        freeRects: { ...cur.freeRects, [tileId]: { ...startRect, x: nextX, y: nextY } },
      });
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (!armed) toggleFullscreen(tileId);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function startResize(e: React.MouseEvent, tileId: string) {
    e.preventDefault();
    e.stopPropagation();
    const container = bodyRef.current;
    const rect = cv.freeRects[tileId];
    if (!container || !rect) return;
    const containerRect = container.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startRect = { ...rect };

    function onMove(ev: MouseEvent) {
      const dwPct = ((ev.clientX - startX) / containerRect.width) * 100;
      const dhPct = ((ev.clientY - startY) / containerRect.height) * 100;
      const nextW = clamp(startRect.w + dwPct, 12, Math.max(12, 100 - startRect.x));
      const nextH = clamp(startRect.h + dhPct, 10, Math.max(10, 100 - startRect.y));
      const cur = readCanvas();
      if (!cur) return;
      patchCanvas({
        freeRects: { ...cur.freeRects, [tileId]: { ...startRect, w: nextW, h: nextH } },
      });
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // Tiled divider drag: baseSizes captured ONCE at drag-start (the two
  // adjacent children's sizes right now), deltaFraction computed cumulative-
  // from-drag-start against a fixed container-of-this-split size — never
  // incremental, per lib/tiling.ts's resizeSplit contract.
  function startDividerDrag(e: React.MouseEvent, node: SplitNode, dividerIndex: number) {
    e.preventDefault();
    const splitEl = splitRefs.current[node.id] ?? bodyRef.current;
    if (!splitEl) return;
    const splitRect = splitEl.getBoundingClientRect();
    const totalPx = node.axis === "row" ? splitRect.width : splitRect.height;
    const startX = e.clientX;
    const startY = e.clientY;
    const baseSizes: [number, number] = [
      node.sizes[dividerIndex] ?? 0.5,
      node.sizes[dividerIndex + 1] ?? 0.5,
    ];
    const splitId = node.id;

    function onMove(ev: MouseEvent) {
      const deltaPx = node.axis === "row" ? ev.clientX - startX : ev.clientY - startY;
      const deltaFraction = totalPx > 0 ? deltaPx / totalPx : 0;
      const cur = readCanvas();
      if (!cur || !cur.tree) return;
      const nextTree = resizeSplit(cur.tree, splitId, dividerIndex, deltaFraction, baseSizes);
      patchCanvas({ tree: nextTree });
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  /**
   * Which tile (and which of its 5 zones) is under the cursor. Edge zones are
   * the outer 25% measured from the NEAREST edge (so they read as triangles
   * meeting at the corners, exactly like VS Code's editor-group drop targets);
   * anything further in than that on all four sides is the center zone.
   */
  function hitTestDrop(clientX: number, clientY: number, draggedTileId: string): DropTarget | null {
    const bodyRect = canvasBodyRef.current?.getBoundingClientRect();
    if (!bodyRect) return null;
    for (const [tileId, el] of Object.entries(tileRefs.current)) {
      if (!el || tileId === draggedTileId) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) continue;

      const fx = (clientX - r.left) / r.width;
      const fy = (clientY - r.top) / r.height;
      const distances: Array<[Side, number]> = [
        ["left", fx],
        ["right", 1 - fx],
        ["top", fy],
        ["bottom", 1 - fy],
      ];
      let nearest = distances[0]!;
      for (const d of distances) if (d[1] < nearest[1]) nearest = d;
      const zone: DropZone = nearest[1] >= EDGE_FRACTION ? "center" : nearest[0];

      const left = r.left - bodyRect.left;
      const top = r.top - bodyRect.top;
      let rect = { left, top, width: r.width, height: r.height };
      if (zone === "left") rect = { left, top, width: r.width / 2, height: r.height };
      else if (zone === "right")
        rect = { left: left + r.width / 2, top, width: r.width / 2, height: r.height };
      else if (zone === "top") rect = { left, top, width: r.width, height: r.height / 2 };
      else if (zone === "bottom")
        rect = { left, top: top + r.height / 2, width: r.width, height: r.height / 2 };

      return { targetTileId: tileId, zone, rect };
    }
    return null;
  }

  function setDrop(next: DropTarget | null) {
    dropTargetRef.current = next;
    setDropTarget(next);
  }

  function applyDrop(draggedTileId: string, target: DropTarget) {
    const cur = readCanvas();
    if (!cur || cur.mode !== "tiled" || !cur.tree) return;
    if (target.targetTileId === draggedTileId) return;

    // Center = swap the two tiles' positions (NOT replace: replacing would have
    // to evict a live pane off the canvas, and a pane leaving the canvas is the
    // close button's job, never an accidental drop's).
    if (target.zone === "center") {
      patchCanvas({ tree: swapPanes(cur.tree, draggedTileId, target.targetTileId) });
      return;
    }

    // Edge = re-home the dragged leaf next to the target. insertPane only ever
    // inserts a NEW leaf, so the dragged tile's existing leaf must come out
    // first; re-resolve the target leaf afterwards because removePane collapses
    // single-child splits and may have restructured around it.
    const draggedLeafId = findLeafId(cur.tree, draggedTileId);
    if (!draggedLeafId) return;
    const afterRemove = removePane(cur.tree, draggedLeafId);
    const targetLeafId = findLeafId(afterRemove, target.targetTileId);
    if (!targetLeafId) return;
    // `tiles` is untouched — it's the flat list of WHAT is placed; only the tree
    // says WHERE.
    patchCanvas({ tree: insertPane(afterRemove, targetLeafId, target.zone, draggedTileId) });
  }

  /**
   * Tiled-mode header drag → drop onto another tile's edge (split) or center
   * (swap). Same window-level mousemove/mouseup idiom as every other drag here.
   */
  function startTileDrag(e: React.MouseEvent, tileId: string) {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    let armed = false;

    function onMove(ev: MouseEvent) {
      if (!armed) {
        // Small threshold so a click on the header (e.g. to focus) isn't a drag.
        if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 5) return;
        armed = true;
        setDraggingTileId(tileId);
      }
      setDrop(hitTestDrop(ev.clientX, ev.clientY, tileId));
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const target = dropTargetRef.current;
      setDrop(null);
      setDraggingTileId(null);
      if (armed && target) applyDrop(tileId, target);
      else if (!armed) toggleFullscreen(tileId);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function renderTileChrome(tile: TileSpec, style?: CSSProperties): ReactNode {
    const session = tile.sessionId ? sessionById.get(tile.sessionId) : undefined;
    // Fully-qualified tile label so a saved (possibly cross-worktree/cross-
    // project) workspace never has ambiguous same-named tiles:
    //   agent/terminal, worktree-scoped: "Project > Worktree > Agent"
    //   agent/terminal, no worktree (direct session, hypothetical today —
    //     the cross-context picker never offers one, kept for correctness):
    //     "Project > Agent"
    //   tools tile: "Project > Tools" (no worktree segment, per design)
    const tileWorktree = tile.worktreeId ? worktreeById.get(tile.worktreeId) : worktreeById.get(worktreeId);
    const tileProject = session
      ? projectById.get(session.projectId)
      : tileWorktree
        ? projectById.get(tileWorktree.projectId)
        : undefined;
    const projectName = tileProject?.name;
    const label =
      tile.kind === "tools"
        ? [projectName, "Tools"].filter(Boolean).join(" > ")
        : session
          ? [projectName, session.worktreeId ? (tileWorktree?.name || tileWorktree?.branch) : null, sessionLabel(session)]
              .filter(Boolean)
              .join(" > ")
          : tile.kind;
    const status =
      tile.kind !== "tools" && session && showAgentStatusBorders
        ? sessionStatus(session.state)
        : null;
    const paneKey = paneKeyForTile(tile, worktreeId);
    const outletVisible =
      tile.kind === "tools" ? toolPanelVisible : tile.kind === "terminal" ? terminalDockVisible : true;

    // Fullscreen (click, not drag, on the title bar — see startDrag/
    // startTileDrag's `!armed` branches). The fullscreen tile escapes
    // whatever position/size `style` would otherwise give it (free-mode %
    // rect, or tiled-mode flex sizing) via `position: fixed` — same escape-
    // the-container technique as the classic agent/tools/terminal pane
    // fullscreen (`.pane-viewport-fullscreen`, Layout.tsx/AGENTS.md), which
    // works regardless of DOM nesting depth (tiled mode can nest a tile
    // several split levels deep). Every OTHER tile hides via `display: none`
    // (not unmounted — panes stay mounted per the never-unmount invariant,
    // see paneOutlets.tsx) so only the fullscreen one is visible/interactive.
    const isFullscreen = fullscreenTileId === tile.id;
    const isHiddenForFullscreen = fullscreenTileId !== null && !isFullscreen;
    const tileStyle: CSSProperties = isFullscreen
      ? { position: "fixed", inset: 0 }
      : isHiddenForFullscreen
        ? { ...style, display: "none" }
        : (style ?? {});

    return (
      <div
        key={tile.id}
        ref={(el) => {
          tileRefs.current[tile.id] = el;
        }}
        className={`workspace-canvas__tile${
          draggingTileId === tile.id ? " workspace-canvas__tile--dragging" : ""
        }${status ? ` workspace-canvas__tile--${status}` : ""}${
          isFullscreen ? " workspace-canvas__tile--fullscreen" : ""
        }`}
        style={tileStyle}
      >
        <div
          className="workspace-canvas__tile-header"
          title={
            isFullscreen
              ? "Click to exit fullscreen"
              : cv.mode === "free"
                ? "Click to fullscreen · drag to move"
                : "Click to fullscreen · drag to rearrange"
          }
          onMouseDown={
            cv.mode === "free"
              ? (e) => startDrag(e, tile.id)
              : (e) => startTileDrag(e, tile.id)
          }
        >
          {status ? <StatusDot status={status} /> : null}
          <span className="workspace-canvas__tile-label" title={label}>{label}</span>
          {tile.kind === "agent" && session ? (
            <button
              type="button"
              className="workspace-canvas__tile-menu-trigger"
              aria-label={`${label} actions`}
              title="Agent actions"
              aria-expanded={tileMenu?.tileId === tile.id}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setTileMenu((prev) =>
                  prev?.tileId === tile.id ? null : { tileId: tile.id, x: e.clientX, y: e.clientY },
                );
              }}
            >
              <MoreVertical size={13} />
            </button>
          ) : null}
          {/* Fullscreen: swap "remove tile" for "exit fullscreen" — clicking
              the header already exits fullscreen too (same toggle), this is
              just a second, more discoverable affordance for it. Removing a
              tile while fullscreen would need its own confirmation-adjacent
              thought (which one? still fullscreen after?) that isn't worth
              designing for when a plain header-click already gets you out. */}
          <button
            type="button"
            className="workspace-canvas__tile-close"
            aria-label={isFullscreen ? "Exit fullscreen" : `Remove ${label} tile`}
            title={isFullscreen ? "Exit fullscreen" : "Remove from canvas"}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (isFullscreen) toggleFullscreen(tile.id);
              else removeTile(tile.id);
            }}
          >
            {isFullscreen ? <Minimize2 size={13} /> : <X size={13} />}
          </button>
        </div>
        <div className="workspace-canvas__tile-body">
          {outletVisible ? (
            <PaneOutlet paneKey={paneKey} />
          ) : (
            <div className="workspace-canvas__tile-hidden">Hidden — toggle it on in the top bar</div>
          )}
        </div>
        {cv.mode === "free" && !isFullscreen ? (
          <div
            className="workspace-canvas__tile-resize"
            onMouseDown={(e) => startResize(e, tile.id)}
          />
        ) : null}
      </div>
    );
  }

  function renderNode(node: LayoutNode): ReactNode {
    if (node.type === "leaf") {
      const tile = cv.tiles.find((t) => t.id === node.tileId);
      if (!tile) return null;
      return renderTileChrome(tile);
    }
    return (
      <div
        key={node.id}
        ref={(el) => {
          splitRefs.current[node.id] = el;
        }}
        className={`workspace-canvas__split workspace-canvas__split--${node.axis}`}
      >
        {node.children.flatMap((child, i) => {
          const items: ReactNode[] = [
            <div
              key={child.id}
              className="workspace-canvas__split-item"
              style={{ flex: `${node.sizes[i] ?? 1} 1 0%` }}
            >
              {renderNode(child)}
            </div>,
          ];
          if (i < node.children.length - 1) {
            items.push(
              <div
                key={`${child.id}-divider`}
                className={`workspace-canvas__divider workspace-canvas__divider--${node.axis}`}
                onMouseDown={(e) => startDividerDrag(e, node, i)}
              />,
            );
          }
          return items;
        })}
      </div>
    );
  }

  // toolbarPortalEl computed above (before the early return, rules-of-hooks).
  // In the detached view it falls back to rendering inline (this component's
  // own row) on the rare frame where TopBar hasn't registered the outlet
  // yet, so the toolbar is never just missing.
  const toolbarNode = (
      <div
        className={`workspace-canvas__toolbar${toolbarPortalEl ? " workspace-canvas__toolbar--portaled" : ""}`}
        role="toolbar"
        aria-label="Workspace canvas"
      >
        <div className="workspace-canvas__toolbar-left">
          <div className="workspace-canvas__mode-toggle" role="group" aria-label="Canvas mode">
            <button
              type="button"
              className={`workspace-canvas__mode-btn ${cv.mode === "free" ? "workspace-canvas__mode-btn--on" : ""}`}
              aria-pressed={cv.mode === "free"}
              onClick={() => handleModeChange("free")}
            >
              Free-form
            </button>
            <button
              type="button"
              className={`workspace-canvas__mode-btn ${cv.mode === "tiled" ? "workspace-canvas__mode-btn--on" : ""}`}
              aria-pressed={cv.mode === "tiled"}
              onClick={() => handleModeChange("tiled")}
            >
              Tiling
            </button>
          </div>
          {/* `isSaved` is only ever true for the detached /workspaces/:id
              route — the classic per-worktree placement always shows its own
              scratch canvas, never a saved doc, so there's no "back to
              unsaved" concept to offer here anymore (see module doc). */}
          {isSaved ? (
            <span className="workspace-canvas__doc-name" title="Saved workspace">
              {savedDoc.name}
            </span>
          ) : (
            <span className="workspace-canvas__doc-name workspace-canvas__doc-name--unsaved">
              Unsaved canvas
            </span>
          )}
        </div>
        <div className="workspace-canvas__toolbar-right">
          {!isSaved ? (
            <div className="workspace-canvas__save">
              {savePromptOpen ? (
                <form
                  className="workspace-canvas__save-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    saveAsWorkspace();
                  }}
                >
                  <input
                    className="workspace-canvas__save-input"
                    aria-label="Workspace name"
                    placeholder="Workspace name"
                    value={saveName}
                    autoFocus
                    maxLength={60}
                    onChange={(e) => setSaveName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setSavePromptOpen(false);
                        setSaveName("");
                      }
                    }}
                  />
                  <button
                    type="submit"
                    className="workspace-canvas__add-btn"
                    aria-label="Confirm save workspace"
                    title="Save"
                  >
                    <Check size={14} />
                  </button>
                  <button
                    type="button"
                    className="workspace-canvas__add-btn"
                    aria-label="Cancel save workspace"
                    title="Cancel"
                    onClick={() => {
                      setSavePromptOpen(false);
                      setSaveName("");
                    }}
                  >
                    <X size={14} />
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  className="workspace-canvas__add-btn"
                  title="Save this arrangement as a named workspace"
                  onClick={() => setSavePromptOpen(true)}
                >
                  <Save size={14} /> Save as workspace
                </button>
              )}
            </div>
          ) : null}
          <div className="workspace-canvas__add">
            <button
              type="button"
              data-workspace-canvas-picker-trigger
              className="workspace-canvas__add-btn"
              onClick={() => setPickerOpen((v) => !v)}
              aria-expanded={pickerOpen}
            >
              <Plus size={14} /> Add tile
            </button>
            {pickerOpen ? (
              <div className="workspace-canvas__picker" role="menu" data-workspace-canvas-picker-panel>
                {pickerEmpty ? (
                  <div className="workspace-canvas__picker-empty">Everything's already on the canvas</div>
                ) : null}
                {!isDetachedView ? (
                  <button
                    type="button"
                    className="workspace-canvas__picker-item"
                    onClick={() => {
                      setNewAgentOpen(true);
                      setPickerOpen(false);
                    }}
                  >
                    <span className="workspace-canvas__picker-item-main">
                      <Plus size={13} className="workspace-canvas__picker-icon" />
                      New agent
                    </span>
                  </button>
                ) : null}
                {availableAgents.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="workspace-canvas__picker-item"
                    onClick={() => addTile("agent", s.id)}
                  >
                    <span className="workspace-canvas__picker-item-main">
                      <Bot size={13} className="workspace-canvas__picker-icon" />
                      {sessionLabel(s)}
                    </span>
                    <span className="workspace-canvas__picker-kind">agent</span>
                  </button>
                ))}
                {availableTerminals.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="workspace-canvas__picker-item"
                    onClick={() => addTile("terminal", s.id)}
                  >
                    <span className="workspace-canvas__picker-item-main">
                      <SquareTerminal size={13} className="workspace-canvas__picker-icon" />
                      {sessionLabel(s)}
                    </span>
                    <span className="workspace-canvas__picker-kind">terminal</span>
                  </button>
                ))}
                {canAddTools ? (
                  <button
                    type="button"
                    className="workspace-canvas__picker-item"
                    onClick={() => addTile("tools")}
                  >
                    <span className="workspace-canvas__picker-item-main">
                      <PanelRight size={13} className="workspace-canvas__picker-icon" />
                      Tools
                    </span>
                    <span className="workspace-canvas__picker-kind">tools</span>
                  </button>
                ) : null}
                {/* Cross-context panes — saved workspaces only (see otherContextGroups). */}
                {otherContextGroups.map((group) => (
                  <div key={group.project.id} className="workspace-canvas__picker-group">
                    <div className="workspace-canvas__picker-heading">
                      <FolderOpen size={13} className="workspace-canvas__picker-icon" />
                      {group.project.name}
                    </div>
                    {group.worktrees.map(({ worktree, sessions, canAddTools: wtTools }) => (
                      <div key={worktree.id}>
                        <div className="workspace-canvas__picker-subheading">
                          <GitBranch size={12} className="workspace-canvas__picker-icon" />
                          {worktree.name || worktree.branch}
                        </div>
                        <div className="workspace-canvas__picker-subitems">
                          <span className="workspace-canvas__picker-indent-line" aria-hidden />
                          {sessions.map((s) => (
                            <button
                              key={s.id}
                              type="button"
                              className="workspace-canvas__picker-item"
                              onClick={() => addTile(s.type as TileKind, s.id, worktree.id)}
                            >
                              <span className="workspace-canvas__picker-item-main">
                                {s.type === "agent" ? (
                                  <Bot size={13} className="workspace-canvas__picker-icon" />
                                ) : (
                                  <SquareTerminal size={13} className="workspace-canvas__picker-icon" />
                                )}
                                {sessionLabel(s)}
                              </span>
                              <span className="workspace-canvas__picker-kind">{s.type}</span>
                            </button>
                          ))}
                          {wtTools ? (
                            <button
                              type="button"
                              className="workspace-canvas__picker-item"
                              onClick={() => addTile("tools", undefined, worktree.id)}
                            >
                              <span className="workspace-canvas__picker-item-main">
                                <PanelRight size={13} className="workspace-canvas__picker-icon" />
                                Tools
                              </span>
                              <span className="workspace-canvas__picker-kind">tools</span>
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
                {/* Unsaved (transient) canvases only ever offer THIS worktree's
                    own sessions/tools above — otherContextGroups stays empty
                    until "Save as workspace" promotes it (see !isSaved guard
                    there). Make that limitation legible instead of the
                    cross-worktree section just silently never appearing. */}
                {!isSaved ? (
                  <div className="workspace-canvas__picker-note" role="note">
                    To add panes from other worktrees, save this canvas as a workspace.
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
  );

  const tileMenuTile = tileMenu ? (cv.tiles.find((t) => t.id === tileMenu.tileId) ?? null) : null;
  const tileMenuSession = tileMenuTile?.sessionId ? (sessionById.get(tileMenuTile.sessionId) ?? null) : null;

  return (
    <div className="workspace-canvas">
      {canvasToolbarVisible
        ? toolbarPortalEl
          ? createPortal(toolbarNode, toolbarPortalEl)
          : toolbarNode
        : null}
      {!isDetachedView ? (
        <NewTabDialog
          open={newAgentOpen}
          api={api}
          worktreeId={worktreeId}
          onClose={() => setNewAgentOpen(false)}
          onCreated={(sessionId) => addTile("agent", sessionId)}
        />
      ) : null}
      {tileMenu && tileMenuSession
        ? createPortal(
            <div
              className="menu-pop"
              data-workspace-canvas-tile-menu-panel
              role="menu"
              aria-label="Agent actions"
              style={{
                position: "fixed",
                top: tileMenu.y + 6,
                left: Math.max(
                  8,
                  Math.min(tileMenu.x, typeof window !== "undefined" ? window.innerWidth - 178 : 8),
                ),
                minWidth: 150,
                zIndex: 4000,
              }}
            >
              <button
                type="button"
                role="menuitem"
                className="menu-pop__item"
                onClick={(e) => {
                  e.stopPropagation();
                  setResetTarget(tileMenuSession);
                  setResetHandoff(false);
                  setTileMenu(null);
                }}
              >
                Reset
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu-pop__item"
                onClick={(e) => {
                  e.stopPropagation();
                  setResetTarget(tileMenuSession);
                  setResetHandoff(true);
                  setTileMenu(null);
                }}
              >
                Reset with handoff
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu-pop__item menu-pop__item--danger"
                onClick={(e) => {
                  e.stopPropagation();
                  if (tileMenuTile) setTerminateTarget({ tileId: tileMenuTile.id, session: tileMenuSession });
                  setTileMenu(null);
                }}
              >
                Terminate
              </button>
            </div>,
            document.body,
          )
        : null}
      <ConfirmDialog
        open={!!resetTarget}
        title={resetHandoff ? "Reset with handoff" : "Reset session"}
        message="Resetting ends the current chat and starts a fresh session in its place. This can't be undone."
        confirmLabel="Reset"
        onCancel={() => setResetTarget(null)}
        onConfirm={() => {
          const target = resetTarget;
          const handoff = resetHandoff;
          setResetTarget(null);
          if (target) {
            void api.resetSession(target.id, { handoff }).catch(() => {
              /* surface errors later */
            });
          }
        }}
      />
      {/* Mirrors the agent tab bar's "×" close — same confirm copy, same
          `deleteSession` call. Also drops the tile from THIS canvas (the tab
          bar has no canvas to reconcile) so a terminated session doesn't
          linger as a dead tile. */}
      <ConfirmDialog
        open={!!terminateTarget}
        title="Close agent"
        message="Close this agent session?"
        confirmLabel="Close"
        onCancel={() => setTerminateTarget(null)}
        onConfirm={() => {
          const target = terminateTarget;
          setTerminateTarget(null);
          if (target) {
            void api.deleteSession(target.session.id).then(() => removeTile(target.tileId));
          }
        }}
      />
      <div className="workspace-canvas__body" ref={canvasBodyRef}>
        {cv.tiles.length === 0 ? (
          <div className="workspace-canvas__empty">
            No tiles — add one to get started
          </div>
        ) : cv.mode === "free" ? (
          <div className="workspace-canvas__free" ref={bodyRef}>
            {cv.tiles.map((tile) => {
              const rect = cv.freeRects[tile.id] ?? { x: 4, y: 4, w: 40, h: 40 };
              return renderTileChrome(tile, {
                position: "absolute",
                left: `${rect.x}%`,
                top: `${rect.y}%`,
                width: `${rect.w}%`,
                height: `${rect.h}%`,
              });
            })}
          </div>
        ) : (
          <div className="workspace-canvas__tiled" ref={bodyRef}>
            {cv.tree ? renderNode(cv.tree) : null}
          </div>
        )}
        {dropTarget ? (
          <div
            className={`workspace-canvas__drop-zone workspace-canvas__drop-zone--${dropTarget.zone}`}
            style={{
              left: dropTarget.rect.left,
              top: dropTarget.rect.top,
              width: dropTarget.rect.width,
              height: dropTarget.rect.height,
            }}
            aria-hidden
          />
        ) : null}
      </div>
    </div>
  );
}
