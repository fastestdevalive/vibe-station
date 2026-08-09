import { useEffect, useRef, useState, type ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useLayout } from "@/hooks/useLayout";
import { PaneFullscreenChrome, type PaneFullscreenPlacement } from "@/components/layout/PaneFullscreenChrome";
import { useWorkspaceStore, LEFT_SIDEBAR_MIN_WIDTH, LEFT_SIDEBAR_MAX_WIDTH } from "@/hooks/useStore";

interface LayoutProps {
  topBar: ReactNode;
  leftSidebar: ReactNode;
  /** When set, main area is this single pane (dashboard) instead of the IDE regions. */
  dashboardPane?: ReactNode;
  /** Center region — agent sessions. Required when `dashboardPane` is omitted. */
  agentPane?: ReactNode;
  /** Right region — tool panel (Files/Preview/Browser/Emulator/Artifacts).
   *  Pass `null` when the region is unavailable (e.g. direct sessions are
   *  terminal-only): the split is skipped regardless of stored visibility. */
  toolPanel?: ReactNode;
  /** Bottom region — terminal dock. Pass `null` when unavailable. */
  terminalDock?: ReactNode;
  leftColumnPx: number;
  /** Whether the desktop sidebar is collapsed to its icon rail (hides the drag handle). */
  leftSidebarCollapsed?: boolean;
  /** Commits a new desktop sidebar width (px) once a drag ends. Omit to disable dragging. */
  onLeftSidebarResize?: (px: number) => void;
  isMobile: boolean;
  mobileSidebarOpen: boolean;
  onMobileSidebarClose: () => void;
}

export function Layout({
  topBar,
  leftSidebar,
  dashboardPane,
  agentPane,
  toolPanel,
  terminalDock,
  leftColumnPx,
  leftSidebarCollapsed,
  onLeftSidebarResize,
  isMobile,
  mobileSidebarOpen,
  onMobileSidebarClose,
}: LayoutProps) {
  const { toolPanelVisible, terminalDockVisible, toolSplitOrientation, activeWorktreeId, activeDirectContextId } = useLayout();

  const mainContentRef = useRef<HTMLDivElement>(null);

  // Live width while dragging the sidebar's right-edge handle; null when not dragging.
  // Kept local (not round-tripped through the store) so drag motion is jank-free —
  // the store (and its localStorage write) is only updated once, on mouseup.
  const [dragWidth, setDragWidth] = useState<number | null>(null);

  function startSidebarResize(e: React.MouseEvent) {
    if (!onLeftSidebarResize) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = leftColumnPx;
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    function clamp(px: number) {
      return Math.min(LEFT_SIDEBAR_MAX_WIDTH, Math.max(LEFT_SIDEBAR_MIN_WIDTH, px));
    }
    function onMove(ev: MouseEvent) {
      setDragWidth(clamp(startWidth + (ev.clientX - startX)));
    }
    function onUp(ev: MouseEvent) {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
      onLeftSidebarResize?.(clamp(startWidth + (ev.clientX - startX)));
      setDragWidth(null);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // Must be called unconditionally — before any early returns — to satisfy Rules of Hooks.
  const paneFullscreen = useWorkspaceStore((s) => s.workspacePaneFullscreen);
  const setPaneFullscreen = useWorkspaceStore((s) => s.setWorkspacePaneFullscreen);

  // `null` slots mean the region is unavailable in this mode (direct sessions
  // are terminal-only) — treat them as hidden no matter what the persisted
  // per-worktree layout says (activeWorktreeId is null there, so the DEFAULT
  // layout with toolPanelVisible:true would otherwise apply).
  const hasToolPanel = toolPanel != null;
  const hasTerminalDock = terminalDock != null;
  const showToolPanel = toolPanelVisible && hasToolPanel;
  const showTerminalDock = terminalDockVisible && hasTerminalDock;

  // Drop a stale fullscreen if the region it targets is no longer visible.
  useEffect(() => {
    if (paneFullscreen === "tools" && !showToolPanel) setPaneFullscreen(null);
    if (paneFullscreen === "terminal" && !showTerminalDock) setPaneFullscreen(null);
  }, [paneFullscreen, showToolPanel, showTerminalDock, setPaneFullscreen]);

  const sidebarInner = (
    <div
      className="pane-left-inner"
      style={{
        height: "100%",
        overflow: "auto",
        background: "var(--bg-primary)",
      }}
    >
      {leftSidebar}
    </div>
  );

  const sidebarDesktop = (
    <div
      className="pane-left"
      style={{
        width: dragWidth ?? leftColumnPx,
        flexShrink: 0,
        borderRight: "var(--border-width) solid var(--border-default)",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {sidebarInner}
      {onLeftSidebarResize && !leftSidebarCollapsed ? (
        <div
          className="pane-left-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          data-dragging={dragWidth !== null}
          onMouseDown={startSidebarResize}
        />
      ) : null}
    </div>
  );

  const sidebarMobile = (
    <>
      {mobileSidebarOpen ? (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close sidebar"
          onClick={onMobileSidebarClose}
        />
      ) : null}
      <aside
        className={`pane-left pane-left--mobile ${mobileSidebarOpen ? "pane-left--open" : ""}`}
        aria-hidden={!mobileSidebarOpen}
      >
        {sidebarInner}
      </aside>
    </>
  );

  if (dashboardPane != null) {
    return (
      <div className="app-shell">
        {topBar}
        <div
          id="workspace-layout"
          className="layout-main"
          data-mode="dashboard"
          style={{ position: "relative" }}
        >
          {isMobile ? sidebarMobile : sidebarDesktop}
          <div
            className="pane pane-dashboard"
            style={{ overflow: "auto", background: "var(--bg-primary)" }}
          >
            {dashboardPane}
          </div>
        </div>
      </div>
    );
  }

  if (agentPane === undefined || toolPanel === undefined || terminalDock === undefined) {
    throw new Error("Layout: agentPane, toolPanel, and terminalDock are required when dashboardPane is omitted.");
  }

  // Key persisted panel sizes on the worktree, or — for direct sessions, which
  // have no worktree — the direct context (project) id. Matches how useLayout
  // keys region visibility, so each context keeps its own split sizes instead
  // of every direct session sharing one "__none__" bucket.
  const wt = activeWorktreeId ?? activeDirectContextId ?? "__none__";

  function wrap(node: ReactNode, placement: PaneFullscreenPlacement = "panel") {
    return <PaneFullscreenChrome placement={placement}>{node}</PaneFullscreenChrome>;
  }

  // The agent pane and terminal dock both contain a live xterm that must never
  // remount on a fullscreen toggle (a remount kills + recreates the PTY stream
  // and leaves a ghost — see AGENTS.md). So they always render in their slot;
  // fullscreen only swaps the wrapper class to position:fixed (covers the
  // viewport, escaping Panel's overflow:hidden). The tool panel holds no PTY,
  // so it can safely use the duplicate-in-overlay pattern.
  function regionWrapper(node: ReactNode, fullscreen: boolean) {
    return (
      <div
        className={fullscreen ? "pane-viewport-fullscreen" : undefined}
        style={fullscreen ? undefined : { flex: 1, height: "100%", minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}
      >
        {wrap(node, fullscreen ? "viewport" : "panel")}
      </div>
    );
  }

  const agentFullscreen = paneFullscreen === "agent";
  const terminalFullscreen = paneFullscreen === "terminal";
  const toolsInSplit = showToolPanel && paneFullscreen !== "tools";

  const agentWrapper = () => regionWrapper(agentPane, agentFullscreen);
  const dockWrapper = () => regionWrapper(terminalDock, terminalFullscreen);

  // Agent pane ↔ tool panel split: horizontal (side by side) or vertical
  // (stacked). In vertical orientation, the tool panel goes on top of the agent pane.
  const vertical = toolSplitOrientation === "vertical";
  const topRow = toolsInSplit ? (
    <PanelGroup
      direction={vertical ? "vertical" : "horizontal"}
      autoSaveId={`vs-ide-top-${wt}-${toolSplitOrientation}`}
      style={{ width: "100%", height: "100%" }}
    >
      {[
        vertical ? (
          <Panel defaultSize={42} minSize={18} key="tools">
            {wrap(toolPanel)}
          </Panel>
        ) : (
          <Panel defaultSize={58} minSize={25} key="agent">
            {agentWrapper()}
          </Panel>
        ),
        <PanelResizeHandle
          className={`resize-handle ${vertical ? "resize-handle--row" : "resize-handle--col"}`}
          key="handle"
        />,
        vertical ? (
          <Panel defaultSize={58} minSize={25} key="agent">
            {agentWrapper()}
          </Panel>
        ) : (
          <Panel defaultSize={42} minSize={18} key="tools">
            {wrap(toolPanel)}
          </Panel>
        ),
      ]}
    </PanelGroup>
  ) : (
    agentWrapper()
  );

  const mainColumnInner = showTerminalDock ? (
    <PanelGroup
      direction="vertical"
      autoSaveId={`vs-ide-dock-${wt}`}
      style={{ width: "100%", height: "100%" }}
    >
      <Panel defaultSize={68} minSize={20}>
        {topRow}
      </Panel>
      <PanelResizeHandle className="resize-handle resize-handle--row" />
      <Panel defaultSize={32} minSize={12}>
        {dockWrapper()}
      </Panel>
    </PanelGroup>
  ) : (
    topRow
  );

  const mainColumn = (
    <div
      ref={mainContentRef}
      style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}
    >
      {mainColumnInner}
    </div>
  );

  const fullscreenOverlay =
    paneFullscreen === "tools" && hasToolPanel ? (
      <div className="pane-viewport-fullscreen" key="viewport-fs-tools">
        {wrap(toolPanel, "viewport")}
      </div>
    ) : null;

  return (
    <div className="app-shell">
      {topBar}
      <div
        id="workspace-layout"
        className="layout-main"
        data-ide="regions"
        style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "row", position: "relative" }}
      >
        {isMobile ? sidebarMobile : sidebarDesktop}
        {mainColumn}
      </div>
      {fullscreenOverlay}
    </div>
  );
}
