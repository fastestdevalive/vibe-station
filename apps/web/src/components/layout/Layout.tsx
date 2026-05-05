import { useEffect, useRef, useState, type ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useLayout } from "@/hooks/useLayout";
import { PaneFullscreenChrome, type PaneFullscreenPlacement } from "@/components/layout/PaneFullscreenChrome";
import { useWorkspaceStore } from "@/hooks/useStore";

interface LayoutProps {
  topBar: ReactNode;
  leftSidebar: ReactNode;
  /** When set, main area is this single pane (dashboard) instead of terminal / preview / file tree. */
  dashboardPane?: ReactNode;
  /** Required when `dashboardPane` is omitted (IDE layout). */
  terminalPane?: ReactNode;
  previewPane?: ReactNode;
  fileTree?: ReactNode;
  leftColumnPx: number;
  isMobile: boolean;
  mobileSidebarOpen: boolean;
  onMobileSidebarClose: () => void;
}

function PanesAllHidden() {
  return (
    <div className="pane empty-state" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
      All workspace panes are hidden. Use the toolbar or ⌘⇧F / ⌘⇧P / ⌘⇧Z to show the file tree, preview, or terminal.
    </div>
  );
}

export function Layout({
  topBar,
  leftSidebar,
  dashboardPane,
  terminalPane,
  previewPane,
  fileTree,
  leftColumnPx,
  isMobile,
  mobileSidebarOpen,
  onMobileSidebarClose,
}: LayoutProps) {
  const { terminalPosition, treePaneVisible, previewPaneVisible, terminalPaneVisible, activeWorktreeId } = useLayout();

  const mainContentRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(1200);

  // Must be called unconditionally — before any early returns — to satisfy Rules of Hooks.
  const paneFullscreen = useWorkspaceStore((s) => s.workspacePaneFullscreen);
  const setPaneFullscreen = useWorkspaceStore((s) => s.setWorkspacePaneFullscreen);

  useEffect(() => {
    const el = mainContentRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = entry.contentRect.width;
      if (w > 0) setContainerWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (paneFullscreen === "terminal" && !terminalPaneVisible) setPaneFullscreen(null);
    if (paneFullscreen === "preview" && !previewPaneVisible) setPaneFullscreen(null);
  }, [paneFullscreen, terminalPaneVisible, previewPaneVisible, setPaneFullscreen]);

  useEffect(() => {
    setPaneFullscreen(null);
  }, [terminalPosition, setPaneFullscreen]);

  const treeMaxPct = Math.min(99, (400 / containerWidth) * 100);

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
          style={{
            position: "relative",
          }}
        >
          {isMobile ? sidebarMobile : sidebarDesktop}
          <div
            className="pane pane-dashboard"
            style={{
              overflow: "auto",
              background: "var(--bg-primary)",
            }}
          >
            {dashboardPane}
          </div>
        </div>
      </div>
    );
  }

  if (terminalPane === undefined || previewPane === undefined || fileTree === undefined) {
    throw new Error("Layout: terminalPane, previewPane, and fileTree are required when dashboardPane is omitted.");
  }

  const ideTerminalPane = terminalPane;
  const idePreviewPane = previewPane;
  const ideFileTree = fileTree;

  const vTree = treePaneVisible;
  const vPreview = previewPaneVisible;
  const vTerm = terminalPaneVisible;

  const terminalInSplit = vTerm;
  const previewInSplit = vPreview && paneFullscreen !== "preview";
  const wt = activeWorktreeId ?? "__none__";

  // Stable wrapper for the terminal — className/style swap between normal and
  // fullscreen without changing the element type, so TerminalPane never remounts.
  // position:fixed escapes Panel's overflow:hidden and covers the viewport.
  const terminalFullscreen = paneFullscreen === "terminal";
  const terminalWrapClass = terminalFullscreen ? "pane-viewport-fullscreen" : undefined;
  const terminalWrapStyle = terminalFullscreen ? undefined : { flex: 1, height: "100%", minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" } as const;
  const terminalPlacement: PaneFullscreenPlacement = terminalFullscreen ? "viewport" : "panel";
  function terminalWrapper() {
    return (
      <div className={terminalWrapClass} style={terminalWrapStyle}>
        {wrapTerminal(ideTerminalPane, terminalPlacement)}
      </div>
    );
  }

  function wrapTerminal(node: ReactNode, placement: PaneFullscreenPlacement = "panel") {
    return <PaneFullscreenChrome placement={placement}>{node}</PaneFullscreenChrome>;
  }

  function wrapPreview(node: ReactNode, placement: PaneFullscreenPlacement = "panel") {
    return <PaneFullscreenChrome placement={placement}>{node}</PaneFullscreenChrome>;
  }

  const dataSidebar = vTree ? "open" : "closed";

  const leftSplitNodes: React.ReactElement[] = [];
  if (terminalInSplit) {
    leftSplitNodes.push(
      <Panel key="term" defaultSize={33.4} minSize={18}>
        {terminalWrapper()}
      </Panel>,
    );
  }
  if (previewInSplit) {
    leftSplitNodes.push(
      <Panel key="preview" defaultSize={33.3} minSize={15}>
        {wrapPreview(idePreviewPane)}
      </Panel>,
    );
  }
  if (vTree) {
    leftSplitNodes.push(
      <Panel key="tree" defaultSize={33.3} minSize={14} maxSize={treeMaxPct}>
        {ideFileTree}
      </Panel>,
    );
  }

  const leftSplitInner =
    leftSplitNodes.length === 0 ? (
      <PanesAllHidden />
    ) : (
      <PanelGroup direction="horizontal" autoSaveId={`vs-ide-left-${wt}-${+terminalInSplit}${+previewInSplit}${+vTree}`} style={{ width: "100%", height: "100%" }}>
        {leftSplitNodes.flatMap((panel, i) =>
          i === 0 ? [panel] : [<PanelResizeHandle key={`sep-${i}`} className="resize-handle resize-handle--col" />, panel],
        )}
      </PanelGroup>
    );

  const leftSplit = (
    <div ref={mainContentRef} style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      {leftSplitInner}
    </div>
  );

  const topRowVisible = vPreview || vTree;

  let bottomTop: React.ReactNode = null;
  if (vPreview && vTree) {
    if (previewInSplit) {
      bottomTop = (
        <PanelGroup direction="horizontal" autoSaveId={`vs-ide-bottom-pt-${wt}-${+previewInSplit}${+vTree}`} style={{ width: "100%", height: "100%" }}>
          <Panel defaultSize={72} minSize={30}>
            {wrapPreview(idePreviewPane)}
          </Panel>
          <PanelResizeHandle className="resize-handle resize-handle--col" />
          <Panel defaultSize={28} minSize={14} maxSize={treeMaxPct}>
            {ideFileTree}
          </Panel>
        </PanelGroup>
      );
    } else {
      bottomTop = (
        <div className="pane-fill-host">
          {ideFileTree}
        </div>
      );
    }
  } else if (vPreview) {
    bottomTop = previewInSplit ? wrapPreview(idePreviewPane) : null;
  } else if (vTree) {
    bottomTop = ideFileTree;
  }

  const bottomTopRow = bottomTop ?? <div className="pane-split-placeholder" aria-hidden />;

  const bottomSplitInner =
    vTerm && topRowVisible ? (
      <PanelGroup direction="vertical" autoSaveId={`vs-ide-bottom-v-${wt}-${+vPreview}${+vTree}`} style={{ width: "100%", height: "100%" }}>
        <Panel defaultSize={68} minSize={28}>
          {bottomTopRow}
        </Panel>
        <PanelResizeHandle className="resize-handle resize-handle--row" />
        <Panel defaultSize={32} minSize={18}>
          {terminalInSplit ? terminalWrapper() : <div className="pane-split-placeholder" aria-hidden />}
        </Panel>
      </PanelGroup>
    ) : vTerm && !topRowVisible ? (
      terminalInSplit ? (
        terminalWrapper()
      ) : (
        <div className="pane-split-placeholder pane-split-placeholder--grow" aria-hidden />
      )
    ) : !vTerm && topRowVisible ? (
      bottomTop ?? <PanesAllHidden />
    ) : (
      <PanesAllHidden />
    );

  const bottomSplit = (
    <div ref={mainContentRef} style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      {bottomSplitInner}
    </div>
  );

  const ideMainColumn = terminalPosition === "left" ? leftSplit : bottomSplit;

  const fullscreenOverlay =
    paneFullscreen === "preview" ? (
      <div className="pane-viewport-fullscreen" key="viewport-fs">
        {wrapPreview(idePreviewPane, "viewport")}
      </div>
    ) : null;

  if (terminalPosition === "left") {
    return (
      <div className="app-shell">
        {topBar}
        <div
          id="workspace-layout"
          className="layout-main"
          data-terminal="left"
          data-sidebar={dataSidebar}
          style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
        >
          <div
            style={{
              display: "flex",
              flex: 1,
              minHeight: 0,
              position: "relative",
            }}
          >
            {isMobile ? sidebarMobile : sidebarDesktop}
            {ideMainColumn}
          </div>
        </div>
        {fullscreenOverlay}
      </div>
    );
  }

  return (
    <div className="app-shell">
      {topBar}
      <div
        id="workspace-layout"
        data-terminal="bottom"
        data-sidebar={dataSidebar}
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "row",
          position: "relative",
        }}
      >
        {isMobile ? sidebarMobile : sidebarDesktop}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>{ideMainColumn}</div>
      </div>
      {fullscreenOverlay}
    </div>
  );
}
