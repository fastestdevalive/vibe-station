import { DEFAULT_WORKTREE_LAYOUT, useWorkspaceStore } from "./useStore";

/** Layout slice: terminal orientation + pane visibility + active ids (persisted via useWorkspaceStore). */
export function useLayout() {
  const activeWorktreeId = useWorkspaceStore((s) => s.activeWorktreeId);
  const layoutByWorktree = useWorkspaceStore((s) => s.layoutByWorktree);
  const activeLayout = activeWorktreeId ? (layoutByWorktree[activeWorktreeId] ?? DEFAULT_WORKTREE_LAYOUT) : DEFAULT_WORKTREE_LAYOUT;
  const terminalPosition = activeLayout.terminalPosition;
  const paneCollapsed = activeLayout.paneCollapsed;
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const toggleTerminalPosition = useWorkspaceStore((s) => s.toggleTerminalPosition);
  const toggleSidebar = useWorkspaceStore((s) => s.toggleSidebar);
  const togglePaneCollapsed = useWorkspaceStore((s) => s.togglePaneCollapsed);
  const setActiveSession = useWorkspaceStore((s) => s.setActiveSession);
  const setActiveWorktree = useWorkspaceStore((s) => s.setActiveWorktree);

  const treePaneVisible = !paneCollapsed[0];
  const previewPaneVisible = !paneCollapsed[1];
  const terminalPaneVisible = !paneCollapsed[2];

  return {
    terminalPosition,
    paneCollapsed,
    treePaneVisible,
    previewPaneVisible,
    terminalPaneVisible,
    activeWorktreeId,
    activeSessionId,
    activeProjectId,
    toggleTerminalPosition,
    toggleSidebar,
    togglePaneCollapsed,
    setActiveSession,
    setActiveWorktree,
  };
}
