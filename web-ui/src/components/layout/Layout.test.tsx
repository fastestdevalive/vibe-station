import { type ReactNode } from "react";
import { render, act, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useWorkspaceStore } from "@/hooks/useStore";
import { Layout } from "./Layout";

// Stub out PaneFullscreenChrome to focus only on Layout rendering/reconciling.
vi.mock("@/components/layout/PaneFullscreenChrome", () => ({
  PaneFullscreenChrome: ({ children }: { children: ReactNode }) => (
    <div data-testid="fullscreen-chrome">{children}</div>
  ),
}));

// Mock react-resizable-panels components to avoid library side effects in DOM.
vi.mock("react-resizable-panels", () => ({
  PanelGroup: ({ children, id }: { children: ReactNode; id?: string }) => (
    <div data-testid="panel-group" data-id={id}>{children}</div>
  ),
  Panel: ({ children, id }: { children: ReactNode; id?: string }) => (
    <div data-testid="panel" data-id={id}>
      {children}
    </div>
  ),
  PanelResizeHandle: () => <div data-testid="resize-handle" />,
}));

describe("Layout orientation toggle remount invariant", () => {
  beforeEach(() => {
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

  // The PanelGroup is keyed on orientation, so it remounts on every toggle.
  // agentPane (a PaneOutlet in production) remounts with it, but the actual
  // terminal lives in PaneHostLayer outside the PanelGroup — so no PTY is
  // killed. This test verifies that after each toggle the agentPane content
  // is still present in the DOM and that each orientation renders the correct
  // panel ordering.
  it("renders agentPane in DOM after toggling toolSplitOrientation horizontal→vertical→horizontal", () => {
    const agentPane = <div data-testid="agent-child">Agent Content</div>;
    const toolPanel = <div data-testid="tool-panel">Tools</div>;

    const { rerender, queryByTestId, getAllByTestId } = render(
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

    // Initial check: horizontal — agent panel first, tools second
    expect(queryByTestId("agent-child")).toBeInTheDocument();
    const [agentPanel0, toolsPanel0] = getAllByTestId("panel");
    expect(agentPanel0).toHaveAttribute("data-id", "agent-pane");
    expect(toolsPanel0).toHaveAttribute("data-id", "tools-pane");

    // Toggle orientation to vertical
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

    // Vertical: tools panel first, agent second
    expect(queryByTestId("agent-child")).toBeInTheDocument();
    const [toolsPanel1, agentPanel1] = getAllByTestId("panel");
    expect(toolsPanel1).toHaveAttribute("data-id", "tools-pane");
    expect(agentPanel1).toHaveAttribute("data-id", "agent-pane");

    // Toggle back to horizontal
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

    // Back to horizontal: agent panel first, tools second
    expect(queryByTestId("agent-child")).toBeInTheDocument();
    const [agentPanel2, toolsPanel2] = getAllByTestId("panel");
    expect(agentPanel2).toHaveAttribute("data-id", "agent-pane");
    expect(toolsPanel2).toHaveAttribute("data-id", "tools-pane");
  });
});

describe("Layout split-handle DOM order", () => {
  function renderWithOrientation(orientation: "horizontal" | "vertical") {
    act(() => {
      useWorkspaceStore.setState({
        activeWorktreeId: "wt-order",
        layoutByWorktree: {
          "wt-order": {
            toolPanelVisible: true,
            toolPanelTab: "files",
            terminalDockVisible: false,
            toolSplitOrientation: orientation,
            layoutMode: "classic",
            activeWorkspaceId: null,
            scratchCanvas: null,
            canvasToolbarVisible: true,
          },
        },
      });
    });

    return render(
      <Layout
        topBar={<div />}
        leftSidebar={<div />}
        agentPane={<div data-testid="agent-child">Agent</div>}
        toolPanel={<div data-testid="tool-panel">Tools</div>}
        terminalDock={<div />}
        leftColumnPx={200}
        isMobile={false}
        mobileSidebarOpen={false}
        onMobileSidebarClose={() => {}}
      />,
    );
  }

  it("vertical orientation: tools panel appears before agent panel in DOM", () => {
    renderWithOrientation("vertical");

    const panels = screen.getAllByTestId("panel");
    expect(panels[0]).toHaveAttribute("data-id", "tools-pane");
    expect(panels[1]).toHaveAttribute("data-id", "agent-pane");
  });

  it("horizontal orientation: agent panel appears before tools panel in DOM", () => {
    renderWithOrientation("horizontal");

    const panels = screen.getAllByTestId("panel");
    expect(panels[0]).toHaveAttribute("data-id", "agent-pane");
    expect(panels[1]).toHaveAttribute("data-id", "tools-pane");
  });
});
