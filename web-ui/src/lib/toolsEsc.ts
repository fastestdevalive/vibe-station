import { DEFAULT_WORKTREE_LAYOUT, effectiveToolTab, isFilesLeftPaneOpen, useWorkspaceStore } from "@/hooks/useStore";

/**
 * R16: Escape-key handling order when both the expanded files panel and tools
 * fullscreen are active: Esc first closes the files panel (if open); a second
 * Esc exits tools-pane fullscreen.
 *
 * Shared by every container that owns the "tools" keyboard scope: each
 * `ToolPanel` root and the window-level `ToolsRailColumn`. Callers attach it as
 * a BUBBLE-phase keydown listener on their container, so it only fires when
 * focus is inside that container and never swallows Esc meant for the terminal
 * (Esc-to-interrupt, vim) or Quick Open.
 *
 * `focusFallback` is the container's root; see the focus hand-off below.
 * `wt` is the files context id (worktree id, project id, or "__none__").
 */
export function handleToolsEsc(e: KeyboardEvent, wt: string, focusFallback?: HTMLElement | null): void {
  if (e.key !== "Escape") return;
  const s = useWorkspaceStore.getState();
  // The panel's OWN context (`wt`), not the active one: a canvas tools tile may show another worktree.
  // Same resolution as useLayout(): the layout may have no persisted entry yet (fresh view), in which
  // case the DEFAULT layout's tab applies — the default is "files", so a bare lookup would report closed.
  const layout = s.layoutByWorktree[wt] ?? DEFAULT_WORKTREE_LAYOUT;
  const panelOpen =
    effectiveToolTab(layout.toolPanelTab) === "files" && isFilesLeftPaneOpen(s.fileTreeVisible, s.filesLeftPaneMode[wt] ?? "tree");
  if (panelOpen) {
    e.stopPropagation();
    // The list overlay goes display:none on close, which would drop focus to <body>
    // and leave the second Esc with no listener. Park focus on the pane root first.
    const active = document.activeElement;
    if (
      focusFallback &&
      active instanceof HTMLElement &&
      focusFallback.contains(active) &&
      active.closest(".files-left-pane-overlay")
    ) {
      focusFallback.focus({ preventScroll: true });
    }
    s.closeFilesLeftPane(wt);
  } else if (s.workspacePaneFullscreen === "tools") {
    e.stopPropagation();
    s.setWorkspacePaneFullscreen(null);
  }
}
