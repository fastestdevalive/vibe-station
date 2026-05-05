import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { DEFAULT_WORKTREE_LAYOUT, useWorkspaceStore } from "@/hooks/useStore";
import { useLayout } from "@/hooks/useLayout";

const WT_ID = "wt-test";

describe("useLayout", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.persist.clearStorage?.();
    useWorkspaceStore.setState({
      layoutByWorktree: {},
      activeWorktreeId: WT_ID,
      activeSessionId: null,
      activeProjectId: null,
    });
  });

  it("exposes pane visibility flags", () => {
    const { result } = renderHook(() => useLayout());
    expect(result.current.treePaneVisible).toBe(false);
    expect(result.current.previewPaneVisible).toBe(false);
    expect(result.current.terminalPaneVisible).toBe(true);
  });

  it("toggleSidebar flips file tree pane", () => {
    act(() => useWorkspaceStore.getState().toggleSidebar());
    const layout = useWorkspaceStore.getState().layoutByWorktree[WT_ID] ?? DEFAULT_WORKTREE_LAYOUT;
    expect(layout.paneCollapsed[0]).toBe(false);
    act(() => useWorkspaceStore.getState().toggleSidebar());
    const layout2 = useWorkspaceStore.getState().layoutByWorktree[WT_ID] ?? DEFAULT_WORKTREE_LAYOUT;
    expect(layout2.paneCollapsed[0]).toBe(true);
  });

  it("persists paneCollapsed in layoutByWorktree", () => {
    act(() => useWorkspaceStore.getState().togglePaneCollapsed(1));
    const raw = localStorage.getItem("vibestation:workspace");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as { state?: { layoutByWorktree?: Record<string, { paneCollapsed?: boolean[] }> } };
    expect(parsed.state?.layoutByWorktree?.[WT_ID]?.paneCollapsed?.[1]).toBe(false);
  });

  it("does not hide last visible workspace pane", () => {
    useWorkspaceStore.setState({
      layoutByWorktree: { [WT_ID]: { ...DEFAULT_WORKTREE_LAYOUT, paneCollapsed: [true, true, false] } },
    });
    act(() => useWorkspaceStore.getState().togglePaneCollapsed(2));
    const layout = useWorkspaceStore.getState().layoutByWorktree[WT_ID] ?? DEFAULT_WORKTREE_LAYOUT;
    expect(layout.paneCollapsed).toEqual([true, true, false]);
  });
});
