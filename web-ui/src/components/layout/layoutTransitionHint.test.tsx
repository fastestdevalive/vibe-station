/**
 * Regression: collapse/resize/re-orient transitions must animate ONLY for an
 * explicit toggle action, never for a worktree switch — even when the
 * destination worktree's persisted layout differs (different split
 * orientation, tool-panel visibility, Files side-panel orientation/width), so
 * that the switch flips the exact same derived values a real toggle would.
 *
 * Two earlier fixes inferred "was this a toggle" from those derived values
 * changing and were wrong for exactly that reason; the fix drives the flag
 * from the store's toggle actions (`layoutTransitionHint`). These tests pin
 * both halves: toggles animate, worktree switches never do.
 */
import type { ReactNode } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import {
  useWorkspaceStore,
  DEFAULT_WORKTREE_LAYOUT,
  LAYOUT_TRANSITION_HINT_MS,
  type WorktreeLayout,
} from "@/hooks/useStore";
import { Layout } from "./Layout";
import { FilesPanel } from "@/components/tools/FilesPanel";

vi.mock("@/components/layout/PaneFullscreenChrome", () => ({
  PaneFullscreenChrome: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// Forward `data-animate-collapse` (and the autoSaveId, to tell the two groups
// apart) so the test can observe exactly what Layout hands the library.
vi.mock("react-resizable-panels", () => ({
  PanelGroup: ({
    children,
    autoSaveId,
    "data-animate-collapse": animate,
  }: {
    children: ReactNode;
    autoSaveId?: string;
    "data-animate-collapse"?: boolean;
  }) => (
    <div data-testid="panel-group" data-autosave={autoSaveId} data-animate-collapse={animate ? "" : undefined}>
      {children}
    </div>
  ),
  Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PanelResizeHandle: () => <div />,
}));

const WT_A = "wt-1";
const WT_B = "wt-2";

function layout(patch: Partial<WorktreeLayout>): WorktreeLayout {
  return { ...DEFAULT_WORKTREE_LAYOUT, ...patch };
}

function renderLayout() {
  return render(
    <Layout
      topBar={<div />}
      leftSidebar={<div />}
      agentPane={<div />}
      toolPanel={<div />}
      terminalDock={<div />}
      leftColumnPx={200}
      isMobile={false}
      mobileSidebarOpen={false}
      onMobileSidebarClose={() => {}}
    />,
  );
}

function animatedGroups(container: HTMLElement) {
  return container.querySelectorAll("[data-testid='panel-group'][data-animate-collapse]").length;
}

function switchWorktree(id: string) {
  act(() => {
    useWorkspaceStore.getState().setActiveWorktree("p1", id);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  act(() => {
    useWorkspaceStore.setState({
      activeProjectId: "p1",
      activeWorktreeId: WT_A,
      activeSessionId: null,
      activeDirectContextId: null,
      workspacePaneFullscreen: null,
      layoutTransitionHint: null,
      fileTreeVisible: true,
      layoutByWorktree: {
        [WT_A]: layout({ toolPanelVisible: true, toolSplitOrientation: "horizontal", masterDetailVertical: false }),
        [WT_B]: layout({ toolPanelVisible: false, toolSplitOrientation: "vertical", masterDetailVertical: true }),
      },
      filesLeftPaneWidthByWorktree: { [WT_A]: 240, [WT_B]: 400 },
      filesLeftPaneHeightByWorktree: { [WT_A]: 200, [WT_B]: 320 },
    });
  });
});

afterEach(() => {
  act(() => {
    vi.runOnlyPendingTimers();
  });
  vi.useRealTimers();
});

describe("layoutTransitionHint (store)", () => {
  it.each([
    ["toggleToolPanel", () => useWorkspaceStore.getState().toggleToolPanel(), "split"],
    ["toggleTerminalDock", () => useWorkspaceStore.getState().toggleTerminalDock(), "split"],
    ["toggleToolSplitOrientation", () => useWorkspaceStore.getState().toggleToolSplitOrientation(), "split"],
    ["toggleFileTree", () => useWorkspaceStore.getState().toggleFileTree(), "files"],
    ["setMasterDetailVertical", () => useWorkspaceStore.getState().setMasterDetailVertical(WT_A, true), "files"],
  ] as const)("%s raises the %s hint, which lapses on its own", (_name, action, kind) => {
    act(() => action());
    expect(useWorkspaceStore.getState().layoutTransitionHint).toBe(kind);
    act(() => {
      vi.advanceTimersByTime(LAYOUT_TRANSITION_HINT_MS);
    });
    expect(useWorkspaceStore.getState().layoutTransitionHint).toBeNull();
  });

  it("a worktree switch never raises the hint, and clears one still live from a toggle", () => {
    switchWorktree(WT_B);
    expect(useWorkspaceStore.getState().layoutTransitionHint).toBeNull();

    act(() => useWorkspaceStore.getState().toggleToolPanel());
    expect(useWorkspaceStore.getState().layoutTransitionHint).toBe("split");
    switchWorktree(WT_A); // well inside the hint window
    expect(useWorkspaceStore.getState().layoutTransitionHint).toBeNull();
  });
});

describe("Layout — data-animate-collapse", () => {
  it("is off at rest", () => {
    const { container } = renderLayout();
    expect(animatedGroups(container)).toBe(0);
  });

  it.each([
    ["toggleToolPanel (top-bar pane visibility)", () => useWorkspaceStore.getState().toggleToolPanel()],
    ["toggleTerminalDock (Ctrl+Shift+Z)", () => useWorkspaceStore.getState().toggleTerminalDock()],
    ["toggleToolSplitOrientation (split orientation)", () => useWorkspaceStore.getState().toggleToolSplitOrientation()],
  ])("is on right after %s, then lapses", (_name, action) => {
    const { container } = renderLayout();
    act(() => action());
    // Both the tools/agent group and the dock group animate.
    expect(animatedGroups(container)).toBe(2);
    act(() => {
      vi.advanceTimersByTime(LAYOUT_TRANSITION_HINT_MS);
    });
    expect(animatedGroups(container)).toBe(0);
  });

  it("stays off when switching to a worktree with a different split orientation AND tool-panel visibility", () => {
    const { container } = renderLayout();
    const before = container.querySelector("[data-testid='panel-group'] [data-testid='panel-group']")
      ?.getAttribute("data-autosave");
    switchWorktree(WT_B);
    // Sanity: the switch really did change the split (new orientation → new autoSaveId).
    const after = container.querySelector("[data-testid='panel-group'] [data-testid='panel-group']")
      ?.getAttribute("data-autosave");
    expect(after).not.toBe(before);
    expect(after).toContain("vertical");
    expect(animatedGroups(container)).toBe(0);

    switchWorktree(WT_A);
    expect(animatedGroups(container)).toBe(0);
  });

  it("stays off for a worktree switch made right after a toggle", () => {
    const { container } = renderLayout();
    act(() => useWorkspaceStore.getState().toggleTerminalDock());
    expect(animatedGroups(container)).toBe(2);
    switchWorktree(WT_B);
    expect(animatedGroups(container)).toBe(0);
  });
});

describe("FilesPanel — content padding transition", () => {
  const api = createMockApi();

  function content(container: HTMLElement) {
    return container.querySelector<HTMLElement>(".files-panel__content")!;
  }

  it("is off at rest, on right after toggleFileTree / setMasterDetailVertical", () => {
    const { container } = render(<FilesPanel api={api} worktreeId={WT_A} />);
    expect(content(container).style.transition).toBe("none");

    act(() => useWorkspaceStore.getState().toggleFileTree());
    expect(content(container).style.transition).toBe("padding-left 0.15s ease");
    act(() => {
      vi.advanceTimersByTime(LAYOUT_TRANSITION_HINT_MS);
    });
    expect(content(container).style.transition).toBe("none");

    act(() => useWorkspaceStore.getState().setMasterDetailVertical(WT_A, true));
    expect(content(container).style.transition).toBe("padding-top 0.15s ease");
  });

  it("stays off when switching to a worktree with a different side-panel orientation and size", () => {
    const { container, rerender } = render(<FilesPanel api={api} worktreeId={WT_A} />);
    expect(content(container).style.paddingLeft).not.toBe("0px");

    switchWorktree(WT_B);
    rerender(<FilesPanel api={api} worktreeId={WT_B} />);
    // Sanity: the switch really flipped the padding axis (stacked in WT_B).
    expect(content(container).style.paddingLeft).toBe("0px");
    expect(content(container).style.paddingTop).not.toBe("0px");
    expect(content(container).style.transition).toBe("none");

    switchWorktree(WT_A);
    rerender(<FilesPanel api={api} worktreeId={WT_A} />);
    expect(content(container).style.transition).toBe("none");
  });
});
