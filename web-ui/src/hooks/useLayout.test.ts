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
      activeTerminalSessionId: null,
      activeProjectId: null,
    });
  });

  it("exposes region flags from defaults", () => {
    const { result } = renderHook(() => useLayout());
    expect(result.current.toolPanelVisible).toBe(DEFAULT_WORKTREE_LAYOUT.toolPanelVisible);
    expect(result.current.toolPanelTab).toBe(DEFAULT_WORKTREE_LAYOUT.toolPanelTab);
    expect(result.current.terminalDockVisible).toBe(DEFAULT_WORKTREE_LAYOUT.terminalDockVisible);
  });

  it("toggleToolPanel flips tool panel visibility", () => {
    act(() => useWorkspaceStore.getState().toggleToolPanel());
    const layout = useWorkspaceStore.getState().layoutByWorktree[WT_ID] ?? DEFAULT_WORKTREE_LAYOUT;
    expect(layout.toolPanelVisible).toBe(!DEFAULT_WORKTREE_LAYOUT.toolPanelVisible);
    act(() => useWorkspaceStore.getState().toggleToolPanel());
    const layout2 = useWorkspaceStore.getState().layoutByWorktree[WT_ID] ?? DEFAULT_WORKTREE_LAYOUT;
    expect(layout2.toolPanelVisible).toBe(DEFAULT_WORKTREE_LAYOUT.toolPanelVisible);
  });

  it("setToolPanelTab selects a tab and makes the panel visible", () => {
    act(() => useWorkspaceStore.getState().toggleToolPanel()); // hide
    act(() => useWorkspaceStore.getState().setToolPanelTab("devices"));
    const layout = useWorkspaceStore.getState().layoutByWorktree[WT_ID] ?? DEFAULT_WORKTREE_LAYOUT;
    expect(layout.toolPanelTab).toBe("devices");
    expect(layout.toolPanelVisible).toBe(true);
  });

  it("persists layoutByWorktree", () => {
    act(() => useWorkspaceStore.getState().setToolPanelTab("artifacts"));
    const raw = localStorage.getItem("vibestation:workspace");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as {
      state?: { layoutByWorktree?: Record<string, { toolPanelTab?: string }> };
    };
    expect(parsed.state?.layoutByWorktree?.[WT_ID]?.toolPanelTab).toBe("artifacts");
  });

  it("toggleTerminalDock flips the bottom dock", () => {
    act(() => useWorkspaceStore.getState().toggleTerminalDock());
    const layout = useWorkspaceStore.getState().layoutByWorktree[WT_ID] ?? DEFAULT_WORKTREE_LAYOUT;
    expect(layout.terminalDockVisible).toBe(!DEFAULT_WORKTREE_LAYOUT.terminalDockVisible);
  });

  it("exposes canvasToolbarVisible defaulting true, flipped by toggleCanvasToolbar", () => {
    const { result } = renderHook(() => useLayout());
    expect(result.current.canvasToolbarVisible).toBe(true);
    act(() => useWorkspaceStore.getState().toggleCanvasToolbar());
    const { result: result2 } = renderHook(() => useLayout());
    expect(result2.current.canvasToolbarVisible).toBe(false);
  });

  it("hasWorktreeToolsTile reflects the active canvas's tiles, updated by toggleWorktreeToolsTile", () => {
    useWorkspaceStore.setState({
      layoutByWorktree: {
        [WT_ID]: { ...DEFAULT_WORKTREE_LAYOUT, scratchCanvas: { mode: "free", tiles: [], tree: null, freeRects: {} } },
      },
    });
    const { result } = renderHook(() => useLayout());
    expect(result.current.hasWorktreeToolsTile).toBe(false);

    act(() => useWorkspaceStore.getState().toggleWorktreeToolsTile());
    const { result: result2 } = renderHook(() => useLayout());
    expect(result2.current.hasWorktreeToolsTile).toBe(true);

    act(() => useWorkspaceStore.getState().toggleWorktreeToolsTile());
    const { result: result3 } = renderHook(() => useLayout());
    expect(result3.current.hasWorktreeToolsTile).toBe(false);
  });
});
