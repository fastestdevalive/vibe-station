import { DEFAULT_WORKTREE_LAYOUT, useWorkspaceStore } from "./useStore";

/** Layout slice: region visibility + active tool tab + active ids (persisted via useWorkspaceStore). */
export function useLayout() {
  const activeWorktreeId = useWorkspaceStore((s) => s.activeWorktreeId);
  const activeDirectContextId = useWorkspaceStore((s) => s.activeDirectContextId);
  const layoutByWorktree = useWorkspaceStore((s) => s.layoutByWorktree);
  // Direct sessions (no worktree) key their layout by the project id.
  const layoutKey = activeWorktreeId ?? activeDirectContextId;
  const activeLayout = layoutKey
    ? (layoutByWorktree[layoutKey] ?? DEFAULT_WORKTREE_LAYOUT)
    : DEFAULT_WORKTREE_LAYOUT;
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const activeTerminalSessionId = useWorkspaceStore((s) => s.activeTerminalSessionId);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const toggleToolPanel = useWorkspaceStore((s) => s.toggleToolPanel);
  const setToolPanelTab = useWorkspaceStore((s) => s.setToolPanelTab);
  const toggleTerminalDock = useWorkspaceStore((s) => s.toggleTerminalDock);
  const toggleToolSplitOrientation = useWorkspaceStore((s) => s.toggleToolSplitOrientation);
  const toggleCanvasToolbar = useWorkspaceStore((s) => s.toggleCanvasToolbar);
  const toggleWorktreeToolsTile = useWorkspaceStore((s) => s.toggleWorktreeToolsTile);
  const setActiveSession = useWorkspaceStore((s) => s.setActiveSession);
  const setActiveTerminalSession = useWorkspaceStore((s) => s.setActiveTerminalSession);
  const setActiveWorktree = useWorkspaceStore((s) => s.setActiveWorktree);
  const setLayoutMode = useWorkspaceStore((s) => s.setLayoutMode);

  // Canvas-mode "does this worktree's scratch canvas already have a Tools
  // tile" — a worktree's classic canvas is ALWAYS its own scratch canvas now
  // (it never binds to a saved WorkspaceDoc, see WorkspaceCanvas.tsx's
  // module doc), so this only ever reads `scratchCanvas`. Mirrors
  // WorkspaceCanvas.tsx's own `placedToolWorktrees` resolution
  // (tile.worktreeId ?? the worktree this canvas is viewed in), so this
  // selector and the renderer never disagree about which tile "counts" as
  // this worktree's Tools tile.
  const hasWorktreeToolsTile = layoutKey
    ? !!activeLayout.scratchCanvas?.tiles.some(
        (t) => t.kind === "tools" && (t.worktreeId ?? layoutKey) === layoutKey,
      )
    : false;

  return {
    toolPanelVisible: activeLayout.toolPanelVisible,
    toolPanelTab: activeLayout.toolPanelTab,
    terminalDockVisible: activeLayout.terminalDockVisible,
    toolSplitOrientation: activeLayout.toolSplitOrientation ?? "horizontal",
    /** Pane-arrangement mode ("classic" | "workspace") for the active worktree/direct
     *  context. NOT the page-routing `layoutMode` prop TopBar/Workspace pass around
     *  ("workspace"|"dashboard"|"settings"|...) — callers destructuring this should
     *  alias it (e.g. `const { layoutMode: paneLayoutMode } = useLayout();`). */
    layoutMode: activeLayout.layoutMode ?? "classic",
    /** Show/hide the workspace-canvas toolbar's disclosure under the crumb (classic per-worktree canvas placement only). */
    canvasToolbarVisible: activeLayout.canvasToolbarVisible ?? true,
    /** Whether the scratch canvas already has a Tools tile for this worktree — canvas mode's Tools-button "on" state. */
    hasWorktreeToolsTile,
    activeWorktreeId,
    activeDirectContextId,
    activeSessionId,
    activeTerminalSessionId,
    activeProjectId,
    toggleToolPanel,
    setToolPanelTab,
    toggleTerminalDock,
    toggleToolSplitOrientation,
    toggleCanvasToolbar,
    toggleWorktreeToolsTile,
    setActiveSession,
    setActiveTerminalSession,
    setActiveWorktree,
    setLayoutMode,
  };
}
