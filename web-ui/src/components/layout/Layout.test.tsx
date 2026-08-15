import { useEffect, type ReactNode } from "react";
import { render, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useWorkspaceStore } from "@/hooks/useStore";
import { Layout } from "./Layout";

// Stub out PaneFullscreenChrome to focus only on Layout rendering/reconciling.
vi.mock("@/components/layout/PaneFullscreenChrome", () => ({
  PaneFullscreenChrome: ({ children }: { children: ReactNode }) => (
    <div data-testid="fullscreen-chrome">{children}</div>
  ),
}));

// Mock react-resizable-panels components to avoid library side effects in DOM
vi.mock("react-resizable-panels", () => ({
  PanelGroup: ({ children }: { children: ReactNode }) => (
    <div data-testid="panel-group">{children}</div>
  ),
  Panel: ({ children }: { children: ReactNode }) => (
    <div data-testid="panel">{children}</div>
  ),
  PanelResizeHandle: () => <div data-testid="resize-handle" />,
}));

let agentChildMounts = 0;
let agentChildUnmounts = 0;

function AgentChild() {
  useEffect(() => {
    agentChildMounts += 1;
    return () => {
      agentChildUnmounts += 1;
    };
  }, []);
  return <div data-testid="agent-child">Agent Content</div>;
}

describe("Layout orientation toggle remount invariant", () => {
  beforeEach(() => {
    agentChildMounts = 0;
    agentChildUnmounts = 0;

    // Reset workspace store state to horizontal orientation by default
    act(() => {
      useWorkspaceStore.setState({
        activeWorktreeId: "wt-test",
        layoutByWorktree: {
          "wt-test": {
            toolPanelVisible: true,
            toolPanelTab: "files",
            terminalDockVisible: false,
            toolSplitOrientation: "horizontal",
          layoutMode: "classic",
          activeWorkspaceId: null,
          scratchCanvas: null,
          canvasToolbarVisible: true,
          },
        },
      });
    });
  });

  it("does not unmount agentPane contents when toggling toolSplitOrientation between horizontal and vertical", () => {
    const agentPane = <AgentChild />;
    const toolPanel = <div data-testid="tool-panel">Tools</div>;

    const { rerender, queryByTestId } = render(
      <Layout
        topBar={<div />}
        leftSidebar={<div />}
        agentPane={agentPane}
        toolPanel={toolPanel}
        terminalDock={<div />}
        leftColumnPx={200}
        isMobile={false}
        mobileSidebarOpen={false}
        onMobileSidebarClose={() => {}}
      />
    );

    // Initial check: horizontal
    expect(agentChildMounts).toBe(1);
    expect(agentChildUnmounts).toBe(0);
    expect(queryByTestId("agent-child")).toBeInTheDocument();

    // Toggle orientation to vertical in the store
    act(() => {
      useWorkspaceStore.setState({
        layoutByWorktree: {
          "wt-test": {
            toolPanelVisible: true,
            toolPanelTab: "files",
            terminalDockVisible: false,
            toolSplitOrientation: "vertical",
          layoutMode: "classic",
          activeWorkspaceId: null,
          scratchCanvas: null,
          canvasToolbarVisible: true,
          },
        },
      });
    });

    // Rerender component to apply new store values
    rerender(
      <Layout
        topBar={<div />}
        leftSidebar={<div />}
        agentPane={agentPane}
        toolPanel={toolPanel}
        terminalDock={<div />}
        leftColumnPx={200}
        isMobile={false}
        mobileSidebarOpen={false}
        onMobileSidebarClose={() => {}}
      />
    );

    // Ensure agentChild has NOT unmounted/remounted
    expect(agentChildMounts).toBe(1);
    expect(agentChildUnmounts).toBe(0);
    expect(queryByTestId("agent-child")).toBeInTheDocument();

    // Toggle orientation back to horizontal in the store
    act(() => {
      useWorkspaceStore.setState({
        layoutByWorktree: {
          "wt-test": {
            toolPanelVisible: true,
            toolPanelTab: "files",
            terminalDockVisible: false,
            toolSplitOrientation: "horizontal",
          layoutMode: "classic",
          activeWorkspaceId: null,
          scratchCanvas: null,
          canvasToolbarVisible: true,
          },
        },
      });
    });

    // Rerender component to apply new store values
    rerender(
      <Layout
        topBar={<div />}
        leftSidebar={<div />}
        agentPane={agentPane}
        toolPanel={toolPanel}
        terminalDock={<div />}
        leftColumnPx={200}
        isMobile={false}
        mobileSidebarOpen={false}
        onMobileSidebarClose={() => {}}
      />
    );

    // Ensure agentChild still has NOT unmounted/remounted
    expect(agentChildMounts).toBe(1);
    expect(agentChildUnmounts).toBe(0);
    expect(queryByTestId("agent-child")).toBeInTheDocument();
  });
});
