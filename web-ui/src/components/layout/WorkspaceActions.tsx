import {
  ChevronDown,
  ChevronUp,
  Columns2,
  LayoutGrid,
  MoreHorizontal,
  PanelRight,
  PanelTop,
  Rows2,
  Search,
  SquareTerminal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLayout } from "@/hooks/useLayout";
import { useDemoEnv, useEventTargets, usePortalRoot, useViewportWidth } from "@/context/DemoEnv";
import { shortcutHints } from "@/lib/shortcutHints";
import { CommentCountChip } from "@/components/comments/CommentsRailBadge";

/**
 * Last button of the actions group: classic = tools pane toggle; canvas = Add/Remove Tools tile.
 * Rendered inline: the group is never re-parented, so the toggle keeps its DOM node (and keyboard focus).
 */
function ToolsToggleButton({ canvas, vertical, badgeCount = 0 }: { canvas: boolean; vertical: boolean; badgeCount?: number }) {
  const { toolPanelVisible, toggleToolPanel, hasWorktreeToolsTile, toggleWorktreeToolsTile } = useLayout();
  const on = canvas ? hasWorktreeToolsTile : toolPanelVisible;
  const unsent = !canvas && !on && badgeCount > 0 ? badgeCount : 0;
  const label = canvas
    ? on
      ? "Remove Tools tile from canvas"
      : "Add Tools tile to canvas"
    : unsent
      ? `Toggle tool panel, ${unsent} unsent ${unsent === 1 ? "comment" : "comments"}`
      : "Toggle tool panel";
  return (
    <button
      type="button"
      className={`top-bar__pane-btn${on ? " top-bar__pane-btn--on" : ""}`}
      aria-pressed={on}
      aria-label={label}
      title={canvas ? label : `Toggle tool panel (${shortcutHints().toolPane})`}
      onClick={() => (canvas ? toggleWorktreeToolsTile() : toggleToolPanel())}
    >
      {vertical ? <PanelTop size={17} /> : <PanelRight size={17} />}
      {unsent ? (
        <span className="top-bar__pane-badge">
          <CommentCountChip count={unsent} />
        </span>
      ) : null}
    </button>
  );
}

interface WorkspaceActionsProps {
  isMobile: boolean;
  onOpenQuickOpen: () => void;
  /** Worktree whose canvas-mode chip the "…" menu and the toggle act on (`null` = project route: no canvas items). */
  canvasWorktreeId: string | null;
  /** Unsent comments count shown on (and announced by) the tools toggle while the pane is hidden. */
  toggleBadgeCount?: number;
}

/**
 * The workspace actions group: Search, the "…" menu, then the tools toggle (always last). The one markup shared by
 * every `TopBar` variant that carries it; add a button to the group HERE, and bump the count in `--top-actions-w` (workspace.css). The toggle is the last button, inline.
 */
export function WorkspaceActions({ isMobile, onOpenQuickOpen, canvasWorktreeId, toggleBadgeCount }: WorkspaceActionsProps) {
  const {
    terminalDockVisible,
    toggleTerminalDock,
    toolSplitOrientation,
    toolSplitOrientationUserSet,
    toggleToolSplitOrientation,
    canvasToolbarVisible,
    toggleCanvasToolbar,
    // ⚠️ the per-worktree pane-arrangement mode ("classic" | "workspace"), not TopBar's page-routing `layoutMode`.
    layoutMode: paneLayoutMode,
    setLayoutMode,
  } = useLayout();
  // On mobile the layout defaults to vertical stacking regardless of the stored value;
  // mirror the same logic as Layout.tsx so the overflow button reflects actual state.
  const effectiveSplitOrientation = !toolSplitOrientationUserSet && isMobile ? "vertical" : toolSplitOrientation;
  const inCanvasMode = paneLayoutMode === "workspace";

  const { doc } = useEventTargets();
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowMenuRef = useRef<HTMLDivElement | null>(null);
  const overflowTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [overflowPos, setOverflowPos] = useState<{ top: number; right: number } | null>(null);
  const demoEnv = useDemoEnv();
  const portalRoot = usePortalRoot();
  const viewportW = useViewportWidth();
  const hints = shortcutHints();

  // The "..." menu is portaled to the portal root and positioned with `position: fixed` from the
  // trigger's rect, so no row/pane overflow or stacking context clips it.
  // A demo stage is shown under a host `transform: scale(k)`: rects are scaled, CSS px are not.
  function toggleOverflow() {
    if (overflowOpen) {
      setOverflowOpen(false);
      return;
    }
    const rect = overflowTriggerRef.current?.getBoundingClientRect();
    if (rect) {
      const k = demoEnv.demo && demoEnv.scale > 0 ? demoEnv.scale : 1;
      setOverflowPos({ top: rect.bottom / k + 4, right: viewportW - rect.right / k });
    }
    setOverflowOpen(true);
  }

  useEffect(() => {
    if (!overflowOpen) return;
    let raf: number;
    const onDown = (e: MouseEvent) => {
      raf = requestAnimationFrame(() => {
        const t = e.target as Node;
        if (!overflowMenuRef.current?.contains(t) && !overflowTriggerRef.current?.contains(t)) {
          setOverflowOpen(false);
        }
      });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Capture phase: beat the tools-pane Esc handler so one Esc closes only this menu.
      e.stopPropagation();
      setOverflowOpen(false);
      overflowTriggerRef.current?.focus({ preventScroll: true });
    };
    doc.addEventListener("mousedown", onDown as EventListener);
    doc.addEventListener("keydown", onKey as EventListener, true);
    return () => {
      doc.removeEventListener("mousedown", onDown as EventListener);
      doc.removeEventListener("keydown", onKey as EventListener, true);
      cancelAnimationFrame(raf);
    };
  }, [overflowOpen, doc]);

  return (
    <>
      <button
        type="button"
        className="icon-btn"
        aria-label="Search files"
        title={`Search files (${hints.quickOpen})`}
        onClick={onOpenQuickOpen}
      >
        <Search size={18} />
      </button>
      <div className="top-bar__overflow-wrapper">
        <button
          type="button"
          className="icon-btn"
          aria-label="More options"
          title="More options"
          aria-expanded={overflowOpen}
          aria-haspopup="true"
          ref={overflowTriggerRef}
          onClick={toggleOverflow}
        >
          <MoreHorizontal size={18} />
        </button>
        {overflowOpen && overflowPos
          ? createPortal(
              <div
                className="top-bar__overflow-menu"
                role="menu"
                ref={overflowMenuRef}
                style={{ position: "fixed", top: overflowPos.top, right: overflowPos.right, zIndex: 4000 }}
              >
                {canvasWorktreeId ? (
                  <>
                    <button
                      type="button"
                      className={`top-bar__overflow-item${inCanvasMode ? " top-bar__overflow-item--active" : ""}`}
                      role="menuitemcheckbox"
                      aria-checked={inCanvasMode}
                      onClick={() => {
                        setLayoutMode(canvasWorktreeId, inCanvasMode ? "classic" : "workspace");
                        setOverflowOpen(false);
                      }}
                    >
                      <LayoutGrid size={14} />
                      <span>{inCanvasMode ? "Canvas layout (on)" : "Canvas layout"}</span>
                    </button>
                    <button
                      type="button"
                      className="top-bar__overflow-item"
                      role="menuitem"
                      disabled={!inCanvasMode}
                      title={
                        !inCanvasMode
                          ? "Switch to canvas mode first"
                          : canvasToolbarVisible
                            ? "Hide canvas toolbar"
                            : "Show canvas toolbar"
                      }
                      onClick={() => {
                        toggleCanvasToolbar();
                        setOverflowOpen(false);
                      }}
                    >
                      {canvasToolbarVisible ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      <span>{canvasToolbarVisible ? "Hide toolbar" : "Show toolbar"}</span>
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  className="top-bar__overflow-item"
                  role="menuitemcheckbox"
                  aria-checked={effectiveSplitOrientation === "vertical"}
                  disabled={paneLayoutMode === "workspace"}
                  onClick={() => {
                    toggleToolSplitOrientation(effectiveSplitOrientation);
                    setOverflowOpen(false);
                  }}
                >
                  {effectiveSplitOrientation === "horizontal" ? <Columns2 size={14} /> : <Rows2 size={14} />}
                  <span>{effectiveSplitOrientation === "horizontal" ? "Split: horizontal" : "Split: vertical"}</span>
                </button>
                <button
                  type="button"
                  className={`top-bar__overflow-item${terminalDockVisible ? " top-bar__overflow-item--active" : ""}`}
                  role="menuitemcheckbox"
                  aria-checked={terminalDockVisible}
                  disabled={paneLayoutMode === "workspace"}
                  onClick={() => {
                    toggleTerminalDock();
                    setOverflowOpen(false);
                  }}
                >
                  <SquareTerminal size={14} />
                  <span>Terminal</span>
                  {paneLayoutMode !== "workspace" ? <span className="top-bar__overflow-kbd">{hints.terminal}</span> : null}
                </button>
              </div>,
              portalRoot,
            )
          : null}
      </div>
      <ToolsToggleButton
        canvas={inCanvasMode && canvasWorktreeId != null}
        vertical={effectiveSplitOrientation === "vertical"}
        badgeCount={toggleBadgeCount}
      />
    </>
  );
}
