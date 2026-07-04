import { DEFAULT_WORKTREE_LAYOUT, useWorkspaceStore } from "./useStore";

/** Layout slice: region visibility + active tool tab + active ids (persisted via useWorkspaceStore). */
export function useLayout() {
  const activeWorktreeId = useWorkspaceStore((s) => s.activeWorktreeId);
  const layoutByWorktree = useWorkspaceStore((s) => s.layoutByWorktree);
  const activeLayout = activeWorktreeId
    ? (layoutByWorktree[activeWorktreeId] ?? DEFAULT_WORKTREE_LAYOUT)
    : DEFAULT_WORKTREE_LAYOUT;
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const activeTerminalSessionId = useWorkspaceStore((s) => s.activeTerminalSessionId);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const toggleToolPanel = useWorkspaceStore((s) => s.toggleToolPanel);
  const setToolPanelTab = useWorkspaceStore((s) => s.setToolPanelTab);
  const toggleTerminalDock = useWorkspaceStore((s) => s.toggleTerminalDock);
  const toggleToolSplitOrientation = useWorkspaceStore((s) => s.toggleToolSplitOrientation);
  const setActiveSession = useWorkspaceStore((s) => s.setActiveSession);
  const setActiveTerminalSession = useWorkspaceStore((s) => s.setActiveTerminalSession);
  const setActiveWorktree = useWorkspaceStore((s) => s.setActiveWorktree);

  return {
    toolPanelVisible: activeLayout.toolPanelVisible,
    toolPanelTab: activeLayout.toolPanelTab,
    terminalDockVisible: activeLayout.terminalDockVisible,
    toolSplitOrientation: activeLayout.toolSplitOrientation ?? "horizontal",
    activeWorktreeId,
    activeSessionId,
    activeTerminalSessionId,
    activeProjectId,
    toggleToolPanel,
    setToolPanelTab,
    toggleTerminalDock,
    toggleToolSplitOrientation,
    setActiveSession,
    setActiveTerminalSession,
    setActiveWorktree,
  };
}
