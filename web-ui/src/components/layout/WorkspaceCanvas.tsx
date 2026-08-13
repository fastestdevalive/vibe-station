import "@/styles/workspace-canvas.css";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, Plus, Save, X } from "lucide-react";
import type { Project, Session, Worktree } from "@/api/types";
import {
  buildBalancedTree,
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
  type CanvasGeometry,
  type FreeRect,
  type TileKind,
  type TileSpec,
} from "@/hooks/useStore";
import { PaneOutlet } from "@/components/layout/paneOutlets";
import { StatusDot } from "@/components/layout/StatusDot";
import { sessionStatus } from "@/lib/worktreeStatus";
import { sessionLabel } from "@/lib/sessionLabel";
import { randomId } from "@/lib/uuid";

interface WorkspaceCanvasProps {
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
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function findLeafId(root: LayoutNode | null, tileId: string): string | null {
  if (!root) return null;
  if (root.type === "leaf") return root.tileId === tileId ? root.id : null;
  for (const child of root.children) {
    const found = findLeafId(child, tileId);
    if (found) return found;
  }
  return null;
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
 * Backing store is EITHER the worktree's transient `scratchCanvas` (the top
 * bar's classic↔workspace toggle — unsaved, never in the sidebar, this
 * worktree's own panes only) OR a saved `WorkspaceDoc` once one is active
 * (picked in the sidebar, or just created via "Save as workspace"). Both
 * expose the same `CanvasGeometry`, so everything below — rendering, drag,
 * resize, tiling — runs against `canvas`/`patchCanvas()` regardless of which
 * is live. Only a SAVED workspace may host cross-worktree tiles.
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
}: WorkspaceCanvasProps) {
  const layoutByWorktree = useWorkspaceStore((s) => s.layoutByWorktree);
  const workspaceDocs = useWorkspaceStore((s) => s.workspaceDocs);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const showAgentStatusBorders = useWorkspaceStore((s) => s.showAgentStatusBorders);

  const activeWorkspaceId = layoutByWorktree[worktreeId]?.activeWorkspaceId ?? null;
  const savedDoc = activeWorkspaceId ? workspaceDocs[activeWorkspaceId] : undefined;
  const savedDocId = savedDoc?.id ?? null;
  const scratch = layoutByWorktree[worktreeId]?.scratchCanvas ?? null;
  /** The live canvas: the saved doc when one is active, else the transient scratch. */
  const canvas: CanvasGeometry | null = savedDoc ?? scratch;
  const isSaved = !!savedDoc;

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const canvasBodyRef = useRef<HTMLDivElement | null>(null);
  const tileRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const splitRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const [pickerOpen, setPickerOpen] = useState(false);
  const [savePromptOpen, setSavePromptOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [draggingTileId, setDraggingTileId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  // mouseup reads the hover through a ref — the window listener closes over the
  // render that started the drag, so React state alone would be stale there.
  const dropTargetRef = useRef<DropTarget | null>(null);

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

  const pickerEmpty =
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
    const id = randomId();
    const tile: TileSpec = { id, kind, sessionId };
    // Only stamp the owning worktree when it isn't the one we're viewing —
    // keeps same-worktree tiles byte-identical to the pre-cross-context shape.
    if (tileWorktreeId && tileWorktreeId !== worktreeId) tile.worktreeId = tileWorktreeId;
    const nextTiles = [...cv.tiles, tile];
    if (cv.mode === "tiled") {
      let nextTree: LayoutNode | null;
      if (!cv.tree || cv.tiles.length === 0) {
        nextTree = insertPane(null, null, "right", id);
      } else {
        const lastTileId = cv.tiles[cv.tiles.length - 1]!.id;
        const targetLeafId = findLeafId(cv.tree, lastTileId);
        nextTree = insertPane(cv.tree, targetLeafId, "right", id);
      }
      patchCanvas({ tiles: nextTiles, tree: nextTree });
    } else {
      const cascade = cv.tiles.length;
      const rect: FreeRect = {
        x: 6 + (cascade % 5) * 5,
        y: 6 + (cascade % 5) * 5,
        w: 42,
        h: 42,
      };
      patchCanvas({ tiles: nextTiles, freeRects: { ...cv.freeRects, [id]: rect } });
    }
    setPickerOpen(false);
  }

  function removeTile(tileId: string) {
    const nextTiles = cv.tiles.filter((t) => t.id !== tileId);
    const nextFreeRects = { ...cv.freeRects };
    delete nextFreeRects[tileId];
    let nextTree = cv.tree;
    if (cv.mode === "tiled") {
      const leafId = findLeafId(cv.tree, tileId);
      nextTree = leafId ? removePane(cv.tree, leafId) : cv.tree;
    }
    patchCanvas({ tiles: nextTiles, freeRects: nextFreeRects, tree: nextTree });
  }

  /**
   * Promote the transient canvas into a real, named WorkspaceDoc: snapshot its
   * geometry, make it the active workspace, and drop the scratch (it's now
   * superseded). From here the Add-tile picker also offers other worktrees.
   */
  function saveAsWorkspace() {
    const name = saveName.trim() || "Workspace";
    const cur = readCanvas();
    const store = useWorkspaceStore.getState();
    const id = store.createWorkspace(worktreeId, name, cur?.mode ?? "free");
    if (cur) {
      store.updateWorkspaceDoc(id, { tiles: cur.tiles, tree: cur.tree, freeRects: cur.freeRects });
    }
    store.setActiveWorkspace(worktreeId, id);
    store.clearScratchCanvas(worktreeId);
    setSavePromptOpen(false);
    setSaveName("");
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

    function onMove(ev: MouseEvent) {
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
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function renderTileChrome(tile: TileSpec, style?: CSSProperties): ReactNode {
    const session = tile.sessionId ? sessionById.get(tile.sessionId) : undefined;
    const baseLabel =
      tile.kind === "tools" ? "Tools" : session ? sessionLabel(session) : tile.kind;
    const otherWorktree =
      tile.worktreeId && tile.worktreeId !== worktreeId
        ? worktreeById.get(tile.worktreeId)
        : undefined;
    const label = otherWorktree
      ? `${baseLabel} · ${otherWorktree.name || otherWorktree.branch}`
      : baseLabel;
    const status =
      tile.kind !== "tools" && session && showAgentStatusBorders
        ? sessionStatus(session.state)
        : null;
    const paneKey = paneKeyForTile(tile, worktreeId);
    const outletVisible =
      tile.kind === "tools" ? toolPanelVisible : tile.kind === "terminal" ? terminalDockVisible : true;

    return (
      <div
        key={tile.id}
        ref={(el) => {
          tileRefs.current[tile.id] = el;
        }}
        className={`workspace-canvas__tile${
          draggingTileId === tile.id ? " workspace-canvas__tile--dragging" : ""
        }${status ? ` workspace-canvas__tile--${status}` : ""}`}
        style={style}
      >
        <div
          className="workspace-canvas__tile-header"
          onMouseDown={
            cv.mode === "free"
              ? (e) => startDrag(e, tile.id)
              : (e) => startTileDrag(e, tile.id)
          }
        >
          {status ? <StatusDot status={status} /> : null}
          <span className="workspace-canvas__tile-label">{label}</span>
          <button
            type="button"
            className="workspace-canvas__tile-close"
            aria-label={`Remove ${label} tile`}
            title="Remove from canvas"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              removeTile(tile.id);
            }}
          >
            <X size={13} />
          </button>
        </div>
        <div className="workspace-canvas__tile-body">
          {outletVisible ? (
            <PaneOutlet paneKey={paneKey} />
          ) : (
            <div className="workspace-canvas__tile-hidden">Hidden — toggle it on in the top bar</div>
          )}
        </div>
        {cv.mode === "free" ? (
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

  return (
    <div className="workspace-canvas">
      <div className="workspace-canvas__toolbar" role="toolbar" aria-label="Workspace canvas">
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
          {isSaved ? (
            <>
              <span className="workspace-canvas__doc-name" title="Saved workspace">
                {savedDoc.name}
              </span>
              <button
                type="button"
                className="workspace-canvas__ghost-btn"
                title="Leave this saved workspace and go back to the unsaved canvas"
                onClick={() => setActiveWorkspace(worktreeId, null)}
              >
                Back to unsaved
              </button>
            </>
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
              className="workspace-canvas__add-btn"
              onClick={() => setPickerOpen((v) => !v)}
              aria-expanded={pickerOpen}
            >
              <Plus size={14} /> Add tile
            </button>
            {pickerOpen ? (
              <div className="workspace-canvas__picker" role="menu">
                {pickerEmpty ? (
                  <div className="workspace-canvas__picker-empty">Everything's already on the canvas</div>
                ) : null}
                {availableAgents.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="workspace-canvas__picker-item"
                    onClick={() => addTile("agent", s.id)}
                  >
                    {sessionLabel(s)} <span className="workspace-canvas__picker-kind">agent</span>
                  </button>
                ))}
                {availableTerminals.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="workspace-canvas__picker-item"
                    onClick={() => addTile("terminal", s.id)}
                  >
                    {sessionLabel(s)} <span className="workspace-canvas__picker-kind">terminal</span>
                  </button>
                ))}
                {canAddTools ? (
                  <button
                    type="button"
                    className="workspace-canvas__picker-item"
                    onClick={() => addTile("tools")}
                  >
                    Tools <span className="workspace-canvas__picker-kind">tools</span>
                  </button>
                ) : null}
                {/* Cross-context panes — saved workspaces only (see otherContextGroups). */}
                {otherContextGroups.map((group) => (
                  <div key={group.project.id} className="workspace-canvas__picker-group">
                    <div className="workspace-canvas__picker-heading">{group.project.name}</div>
                    {group.worktrees.map(({ worktree, sessions, canAddTools: wtTools }) => (
                      <div key={worktree.id}>
                        <div className="workspace-canvas__picker-subheading">
                          {worktree.name || worktree.branch}
                        </div>
                        {sessions.map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            className="workspace-canvas__picker-item"
                            onClick={() => addTile(s.type as TileKind, s.id, worktree.id)}
                          >
                            {sessionLabel(s)}{" "}
                            <span className="workspace-canvas__picker-kind">{s.type}</span>
                          </button>
                        ))}
                        {wtTools ? (
                          <button
                            type="button"
                            className="workspace-canvas__picker-item"
                            onClick={() => addTile("tools", undefined, worktree.id)}
                          >
                            Tools <span className="workspace-canvas__picker-kind">tools</span>
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
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
