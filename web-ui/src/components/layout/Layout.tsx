import { useEffect, useRef, type ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useLayout } from "@/hooks/useLayout";
import { PaneFullscreenChrome, type PaneFullscreenPlacement } from "@/components/layout/PaneFullscreenChrome";
import { useWorkspaceStore } from "@/hooks/useStore";

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
  isMobile,
  mobileSidebarOpen,
  onMobileSidebarClose,
}: LayoutProps) {
  const { toolPanelVisible, terminalDockVisible, toolSplitOrientation, activeWorktreeId, activeDirectContextId } = useLayout();

  const mainContentRef = useRef<HTMLDivElement>(null);

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
        width: leftColumnPx,
        flexShrink: 0,
        borderRight: "var(--border-width) solid var(--border-default)",
        overflow: "hidden",
      }}
    >
      {sidebarInner}
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
