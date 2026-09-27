import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TopRightInsetProvider, useTopRightInset } from "@/context/TopRightInsetContext";
import { Layout } from "@/components/layout/Layout";
import { useWorkspaceStore } from "@/hooks/useStore";
import { MemoryRouter } from "react-router-dom";
import { TopBar } from "./TopBar";
import { PaneOutlet, PaneOutletProvider } from "./paneOutlets";
import { PaneHostLayer } from "./PaneHostLayer";

vi.mock("@/components/layout/PaneFullscreenChrome", () => ({
  PaneFullscreenChrome: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="fullscreen-chrome">{children}</div>
  ),
}));

vi.mock("react-resizable-panels", () => ({
  PanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="panel-group">{children}</div>
  ),
  Panel: ({ children, order }: { children: React.ReactNode; order?: number }) => (
    <div data-testid="panel" data-order={order}>
      {children}
    </div>
  ),
  PanelResizeHandle: () => <div data-testid="resize-handle" />,
}));

function Consumer() {
  const inset = useTopRightInset();
  return <div data-testid="inset-val">{JSON.stringify(inset)}</div>;
}

describe("TopRightInsetContext & Layout outer inset wiring", () => {
  it("provides default zero inset when not wrapped in provider", () => {
    render(<Consumer />);
    expect(screen.getByTestId("inset-val")).toHaveTextContent('{"width":0,"height":0}');
  });

  it("provides custom inset when wrapped in provider", () => {
    render(
      <TopRightInsetProvider value={{ width: 150, height: 35 }}>
        <Consumer />
      </TopRightInsetProvider>
    );
    expect(screen.getByTestId("inset-val")).toHaveTextContent('{"width":150,"height":35}');
  });

  it("routes inset to Tools pane when tool panel is open in classic layout", () => {
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      layoutByWorktree: {
        "wt-1": {
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

    render(
      <Layout
        isClassicLayout={true}
        floatingTopBar={<div data-testid="floating-bar">Floating Bar</div>}
        agentPane={<div data-testid="agent-slot"><Consumer /></div>}
        toolPanel={<div data-testid="tool-slot"><Consumer /></div>}
        terminalDock={<div />}
        leftSidebar={<div />}
        leftColumnPx={200}
        isMobile={false}
        mobileSidebarOpen={false}
        onMobileSidebarClose={() => {}}
      />
    );

    // Floating bar is rendered
    expect(screen.getByTestId("floating-bar")).toBeInTheDocument();

    const insets = screen.getAllByTestId("inset-val");
    // insets[0] is in agentPane (should be 0 because Tools is under top-right)
    expect(insets[0]).toHaveTextContent('{"width":0,"height":0}');
    // insets[1] is in toolPanel (should be default initial floating inset width > 0)
    const toolInset = JSON.parse(insets[1]!.textContent!);
    expect(toolInset.width).toBeGreaterThan(0);
  });

  it("routes inset to Agent pane when tool panel is closed in classic layout", () => {
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      layoutByWorktree: {
        "wt-1": {
          toolPanelVisible: false,
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

    render(
      <Layout
        isClassicLayout={true}
        floatingTopBar={<div data-testid="floating-bar">Floating Bar</div>}
        agentPane={<div data-testid="agent-slot"><Consumer /></div>}
        toolPanel={<div data-testid="tool-slot"><Consumer /></div>}
        terminalDock={<div />}
        leftSidebar={<div />}
        leftColumnPx={200}
        isMobile={false}
        mobileSidebarOpen={false}
        onMobileSidebarClose={() => {}}
      />
    );

    const insets = screen.getAllByTestId("inset-val");
    // insets[0] is in agentPane (should be floating inset because Tools is closed)
    const agentInset = JSON.parse(insets[0]!.textContent!);
    expect(agentInset.width).toBeGreaterThan(0);
  });

  it("TopBar variant='sidebar-header' renders sidebar toggle and project name on desktop, omitting worktree name", () => {
    useWorkspaceStore.setState({
      activeProjectId: "p1",
      activeWorktreeId: "w1",
    });

    render(
      <MemoryRouter>
        <PaneOutletProvider>
          <TopBar
            variant="sidebar-header"
            projects={[{ id: "p1", name: "MyProj", path: "/tmp", prefix: "mp", isGit: true, createdAt: "", hidden: false, lspEnabled: false }]}
            worktrees={[{ id: "w1", projectId: "p1", branch: "feat-test", baseBranch: "main", createdAt: "", pinnedAt: null, hiddenAt: null, lspEnabled: false }]}
            isMobile={false}
            onToggleLeftSidebar={() => {}}
            leftSidebarCollapsed={false}
            mobileSidebarOpen={false}
            onOpenQuickOpen={() => {}}
          />
        </PaneOutletProvider>
      </MemoryRouter>
    );

    expect(screen.getByLabelText("Hide projects sidebar")).toBeInTheDocument();
    // Project name is preserved on desktop; worktree/branch name is omitted
    // (already shown in the global bottom bar)
    expect(screen.getByText("MyProj")).toBeInTheDocument();
    expect(screen.queryByText("feat-test")).not.toBeInTheDocument();
    // Doesn't render Search or More options in sidebar-header variant
    expect(screen.queryByLabelText("Search files")).not.toBeInTheDocument();
  });

  it("TopBar preserves title for dashboard on desktop and project name on mobile", () => {
    const { unmount } = render(
      <MemoryRouter>
        <PaneOutletProvider>
          <TopBar
            layoutMode="dashboard"
            projects={[]}
            worktrees={[]}
            isMobile={false}
            onToggleLeftSidebar={() => {}}
            leftSidebarCollapsed={false}
            mobileSidebarOpen={false}
            onOpenQuickOpen={() => {}}
          />
        </PaneOutletProvider>
      </MemoryRouter>
    );
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    unmount();

    // Mobile preserves project name in top bar, omitting worktree/branch
    render(
      <MemoryRouter>
        <PaneOutletProvider>
          <TopBar
            layoutMode="workspace"
            projects={[{ id: "p1", name: "MyProj", path: "/tmp", prefix: "mp", isGit: true, createdAt: "", hidden: false, lspEnabled: false }]}
            worktrees={[{ id: "w1", projectId: "p1", branch: "feat-test", baseBranch: "main", createdAt: "", pinnedAt: null, hiddenAt: null, lspEnabled: false }]}
            isMobile={true}
            onToggleLeftSidebar={() => {}}
            leftSidebarCollapsed={false}
            mobileSidebarOpen={false}
            onOpenQuickOpen={() => {}}
          />
        </PaneOutletProvider>
      </MemoryRouter>
    );
    expect(screen.getByText("MyProj")).toBeInTheDocument();
    expect(screen.queryByText("feat-test")).not.toBeInTheDocument();
  });

  it("TopBar variant='floating' renders top-right actions", () => {
    render(
      <MemoryRouter>
        <PaneOutletProvider>
          <TopBar
            variant="floating"
            projects={[{ id: "p1", name: "MyProj", path: "/tmp", prefix: "mp", isGit: true, createdAt: "", hidden: false, lspEnabled: false }]}
            worktrees={[{ id: "w1", projectId: "p1", branch: "feat-test", baseBranch: "main", createdAt: "", pinnedAt: null, hiddenAt: null, lspEnabled: false }]}
            isMobile={false}
            onToggleLeftSidebar={() => {}}
            leftSidebarCollapsed={false}
            mobileSidebarOpen={false}
            onOpenQuickOpen={() => {}}
          />
        </PaneOutletProvider>
      </MemoryRouter>
    );

    expect(screen.getByLabelText("Search files")).toBeInTheDocument();
    expect(screen.getByLabelText("More options")).toBeInTheDocument();
    expect(screen.getByLabelText("Toggle tool panel")).toBeInTheDocument();
    // Doesn't render breadcrumb or sidebar toggle in floating variant
    expect(screen.queryByLabelText("Hide projects sidebar")).not.toBeInTheDocument();
    expect(screen.queryByText("MyProj")).not.toBeInTheDocument();
  });

  it("bridges inset from PaneOutlet to portaled pane via PaneHostLayer", () => {
    render(
      <PaneOutletProvider>
        <TopRightInsetProvider value={{ width: 140, height: 35 }}>
          <div data-testid="tools-outlet">
            <PaneOutlet paneKey="tools:wt-1" />
          </div>
        </TopRightInsetProvider>
        <PaneHostLayer
          paneKeys={["tools:wt-1"]}
          renderPane={() => (
            <div data-testid="portaled-pane">
              <Consumer />
            </div>
          )}
        />
      </PaneOutletProvider>
    );

    const portaledInset = JSON.parse(screen.getByTestId("inset-val").textContent!);
    expect(portaledInset).toEqual({ width: 140, height: 35 });
  });

  it("routes inset to workspaceCanvas when in canvas layout", () => {
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      layoutByWorktree: {
        "wt-1": {
          toolPanelVisible: true,
          toolPanelTab: "files",
          terminalDockVisible: false,
          toolSplitOrientation: "horizontal",
          layoutMode: "workspace",
          activeWorkspaceId: null,
          scratchCanvas: null,
          canvasToolbarVisible: true,
        },
      },
    });

    render(
      <Layout
        isClassicLayout={true}
        floatingTopBar={<div data-testid="floating-bar">Floating Bar</div>}
        workspaceCanvas={<div data-testid="canvas-slot"><Consumer /></div>}
        agentPane={<div data-testid="agent-slot">Agent</div>}
        toolPanel={<div data-testid="tool-slot">Tool</div>}
        terminalDock={<div />}
        leftSidebar={<div />}
        leftColumnPx={200}
        isMobile={false}
        mobileSidebarOpen={false}
        onMobileSidebarClose={() => {}}
      />
    );

    const canvasConsumer = screen.getByTestId("canvas-slot").querySelector("[data-testid='inset-val']");
    const canvasInset = JSON.parse(canvasConsumer!.textContent!);
    expect(canvasInset.width).toBeGreaterThan(0);
  });

  it("zeros insets for both Agent and Tools panes when tools pane is fullscreen", () => {
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      workspacePaneFullscreen: "tools",
      layoutByWorktree: {
        "wt-1": {
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

    render(
      <Layout
        isClassicLayout={true}
        floatingTopBar={<div data-testid="floating-bar">Floating Bar</div>}
        agentPane={<div data-testid="agent-slot"><Consumer /></div>}
        toolPanel={<div data-testid="tool-slot"><Consumer /></div>}
        terminalDock={<div />}
        leftSidebar={<div />}
        leftColumnPx={200}
        isMobile={false}
        mobileSidebarOpen={false}
        onMobileSidebarClose={() => {}}
      />
    );

    const insets = screen.getAllByTestId("inset-val");
    for (const el of insets) {
      expect(JSON.parse(el.textContent!)).toEqual({ width: 0, height: 0 });
    }
  });

  it("zeros insets for both Agent and Tools panes when agent pane is fullscreen", () => {
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      workspacePaneFullscreen: "agent",
      layoutByWorktree: {
        "wt-1": {
          toolPanelVisible: false,
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

    render(
      <Layout
        isClassicLayout={true}
        floatingTopBar={<div data-testid="floating-bar">Floating Bar</div>}
        agentPane={<div data-testid="agent-slot"><Consumer /></div>}
        toolPanel={<div data-testid="tool-slot"><Consumer /></div>}
        terminalDock={<div />}
        leftSidebar={<div />}
        leftColumnPx={200}
        isMobile={false}
        mobileSidebarOpen={false}
        onMobileSidebarClose={() => {}}
      />
    );

    const insets = screen.getAllByTestId("inset-val");
    for (const el of insets) {
      expect(JSON.parse(el.textContent!)).toEqual({ width: 0, height: 0 });
    }
  });

  it("renders explicit topBar, omits floatingTopBar, and zeroes insets when isMobile is true", () => {
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      workspacePaneFullscreen: null,
      layoutByWorktree: {
        "wt-1": {
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

    render(
      <Layout
        isClassicLayout={true}
        topBar={<div data-testid="explicit-bar">Explicit Bar</div>}
        floatingTopBar={<div data-testid="floating-bar">Floating Bar</div>}
        agentPane={<div data-testid="agent-slot"><Consumer /></div>}
        toolPanel={<div data-testid="tool-slot"><Consumer /></div>}
        terminalDock={<div />}
        leftSidebar={<div />}
        leftColumnPx={200}
        isMobile={true}
        mobileSidebarOpen={false}
        onMobileSidebarClose={() => {}}
      />
    );

    expect(screen.getByTestId("explicit-bar")).toBeInTheDocument();
    expect(screen.queryByTestId("floating-bar")).not.toBeInTheDocument();

    const insets = screen.getAllByTestId("inset-val");
    for (const el of insets) {
      expect(JSON.parse(el.textContent!)).toEqual({ width: 0, height: 0 });
    }
  });
});
