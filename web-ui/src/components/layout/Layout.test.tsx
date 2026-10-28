import { useEffect, type ReactNode } from "react";
import { render, act, screen, fireEvent, within } from "@testing-library/react";
import { DemoEnvProvider } from "@/context/DemoEnv";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useWorkspaceStore } from "@/hooks/useStore";
import { Layout } from "./Layout";
import { MemoryRouter } from "react-router-dom";
import { createMockApi } from "@/api/mock";
import { TabsStrip } from "./TabsStrip";
import { ActionsHost } from "./TopActionsSlot";
import { WorkspaceActions } from "./WorkspaceActions";

// Stub out PaneFullscreenChrome to focus only on Layout rendering/reconciling.
vi.mock("@/components/layout/PaneFullscreenChrome", () => ({
  PaneFullscreenChrome: ({ children }: { children: ReactNode }) => (
    <div data-testid="fullscreen-chrome">{children}</div>
  ),
}));

// Mock react-resizable-panels components to avoid library side effects in DOM.
// `order` is surfaced as `data-order` so Phase 5's tests can assert on it
// without depending on the library's own internal panel-ordering behavior.
vi.mock("react-resizable-panels", () => ({
  PanelGroup: ({ children }: { children: ReactNode }) => (
    <div data-testid="panel-group">{children}</div>
  ),
  Panel: ({ children, order }: { children: ReactNode; order?: number }) => (
    <div data-testid="panel" data-order={order}>
      {children}
    </div>
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

describe("Layout split-handle order fix (Phase 5, Decision 10)", () => {
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

  it("vertical orientation: tools Panel gets order=1, agent Panel gets order=2", () => {
    renderWithOrientation("vertical");

    const toolsPanel = screen.getByTestId("tool-panel").closest('[data-testid="panel"]');
    const agentPanel = screen.getByTestId("agent-child").closest('[data-testid="panel"]');

    expect(toolsPanel).toHaveAttribute("data-order", "1");
    expect(agentPanel).toHaveAttribute("data-order", "2");
  });

  it("horizontal orientation: agent Panel gets order=1, tools Panel gets order=2", () => {
    renderWithOrientation("horizontal");

    const toolsPanel = screen.getByTestId("tool-panel").closest('[data-testid="panel"]');
    const agentPanel = screen.getByTestId("agent-child").closest('[data-testid="panel"]');

    expect(agentPanel).toHaveAttribute("data-order", "1");
    expect(toolsPanel).toHaveAttribute("data-order", "2");
  });
});

function setLayoutState(
  patch: Partial<{
    toolPanelVisible: boolean;
    toolSplitOrientation: "horizontal" | "vertical";
    layoutMode: "classic" | "workspace";
  }> = {},
) {
  act(() => {
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-rail",
      workspacePaneFullscreen: null,
      layoutByWorktree: {
        "wt-rail": {
          toolPanelVisible: true,
          toolPanelTab: "files",
          terminalDockVisible: false,
          toolSplitOrientation: "horizontal",
          layoutMode: "classic",
          activeWorkspaceId: null,
          scratchCanvas: null,
          canvasToolbarVisible: true,
          ...patch,
        },
      },
    });
  });
}

describe("Layout window rail column (R1, R92)", () => {
  beforeEach(() => {
    agentChildMounts = 0;
    agentChildUnmounts = 0;
    setLayoutState();
  });

  const toolPanelNode = (
    <div data-testid="tool-panel">
      <div className="files-panel__content" data-testid="preview" />
      <div className="files-left-pane-overlay" data-testid="list" />
    </div>
  );

  function renderLayout(props: Partial<React.ComponentProps<typeof Layout>> = {}) {
    const base = (
      <Layout
        topBar={<div />}
        leftSidebar={<div />}
        agentPane={<AgentChild />}
        toolPanel={toolPanelNode}
        terminalDock={<div />}
        leftColumnPx={200}
        isMobile={false}
        mobileSidebarOpen={false}
        onMobileSidebarClose={() => {}}
        {...props}
      />
    );
    return render(base);
  }

  it("2.T2 — agent never remounts; the rail exists iff tools are shown and is stable while they stay visible", () => {
    renderLayout();
    let rail = screen.getByTestId("tools-rail-column");
    expect(agentChildMounts).toBe(1);

    const check = (visible: boolean) => {
      expect(agentChildMounts).toBe(1);
      expect(agentChildUnmounts).toBe(0);
      if (visible) expect(screen.getByTestId("tools-rail-column")).toBeInTheDocument();
      else expect(screen.queryByTestId("tools-rail-column")).not.toBeInTheDocument();
    };

    setLayoutState({ toolPanelVisible: false });
    check(false);
    setLayoutState({ toolPanelVisible: true });
    check(true);
    rail = screen.getByTestId("tools-rail-column");

    // While continuously visible, orientation and fullscreen steps keep the very same rail node.
    const steps: Array<() => void> = [
      () => setLayoutState({ toolSplitOrientation: "vertical" }),
      () => setLayoutState({ toolSplitOrientation: "horizontal" }),
      () => act(() => useWorkspaceStore.getState().setWorkspacePaneFullscreen("tools")),
      () => act(() => useWorkspaceStore.getState().setWorkspacePaneFullscreen(null)),
    ];
    for (const step of steps) {
      step();
      check(true);
      expect(screen.getByTestId("tools-rail-column")).toBe(rail);
    }
  });

  it("2.T2 — hidden tools render no rail column; without a chip the main column is the last child of #workspace-layout, with one the chip is", () => {
    setLayoutState({ toolPanelVisible: false });
    const { container, unmount } = renderLayout();
    expect(screen.queryByTestId("tools-rail-column")).not.toBeInTheDocument();
    const layoutMain = container.querySelector("#workspace-layout") as HTMLElement;
    expect(layoutMain.lastElementChild?.contains(screen.getByTestId("agent-child"))).toBe(true);
    unmount();
    const withChip = renderLayout({ isClassicLayout: true, actionsGroup: <button type="button">grp</button> });
    const lm = withChip.container.querySelector("#workspace-layout") as HTMLElement;
    expect(lm.lastElementChild).toHaveClass("top-actions-anchor");
    expect(lm.lastElementChild?.previousElementSibling?.contains(screen.getByTestId("agent-child"))).toBe(true);
  });

  it("2.T3 — the chip is the last child of #workspace-layout; the rail precedes it, outside every panel group, after preview and list", () => {
    const { container } = renderLayout({
      isClassicLayout: true,
      actionsGroup: <button type="button" aria-label="Toggle tool panel" />,
      toolPanel: (
        <div data-testid="tool-panel">
          <ActionsHost zone="tools" />
          <div className="files-panel__content" data-testid="preview" />
          <div className="files-left-pane-overlay" data-testid="list" />
        </div>
      ),
    });
    const layoutMain = container.querySelector("#workspace-layout") as HTMLElement;
    const rail = screen.getByTestId("tools-rail-column");
    expect(layoutMain.lastElementChild).toHaveClass("top-actions-anchor");
    expect(layoutMain.lastElementChild?.previousElementSibling).toBe(rail);
    for (const group of screen.getAllByTestId("panel-group")) {
      expect(group.contains(rail)).toBe(false);
    }
    // Head cell: an empty spacer under the chip (the toggle lives in the chip, never here).
    const head = rail.firstElementChild as HTMLElement;
    expect(head).toHaveClass("tools-rail__head");
    expect(head).toHaveAttribute("aria-hidden", "true");
    expect(head).toHaveAttribute("data-tauri-drag-region", "deep");
    expect(head.childNodes).toHaveLength(0);
    expect(rail.querySelector("button[aria-label='Toggle tool panel']")).toBeNull();
    const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(screen.getByTestId("preview"), screen.getByTestId("list"))).toBe(true);
    expect(follows(screen.getByTestId("list"), rail)).toBe(true);
  });

  it("2.T3 — absent when toolPanel is null", () => {
    renderLayout({ toolPanel: null });
    expect(screen.queryByTestId("tools-rail-column")).not.toBeInTheDocument();
  });

  it("2.T3 — absent in canvas mode, present in workspace mode without a canvas node", () => {
    setLayoutState({ layoutMode: "workspace" });
    const { unmount } = renderLayout({ workspaceCanvas: <div data-testid="canvas" /> });
    expect(screen.getByTestId("canvas")).toBeInTheDocument();
    expect(screen.queryByTestId("tools-rail-column")).not.toBeInTheDocument();
    unmount();

    renderLayout();
    expect(screen.getByTestId("tools-rail-column")).toBeInTheDocument();
  });

  it("8.T2 — mobile: no window column and no strip; #workspace-layout directly follows the top bar", () => {
    const { container } = renderLayout({ isMobile: true, topBar: <div data-testid="top-bar" /> });
    expect(screen.queryByTestId("tools-rail-column")).not.toBeInTheDocument();
    expect(container.querySelector(".tools-rail--strip")).toBeNull();
    expect(container.querySelector(".tools-rail--column")).toBeNull();
    const shell = container.querySelector(".app-shell") as HTMLElement;
    expect(shell.children[0]).toBe(screen.getByTestId("top-bar"));
    expect(shell.children[1]).toBe(container.querySelector("#workspace-layout"));
  });

  it("8.T2 — mobile: the agent never remounts across isMobile false -> true -> false", () => {
    const props = {
      topBar: <div />,
      leftSidebar: <div />,
      agentPane: <AgentChild />,
      toolPanel: toolPanelNode,
      terminalDock: <div />,
      leftColumnPx: 200,
      mobileSidebarOpen: false,
      onMobileSidebarClose: () => {},
    };
    const { rerender } = render(<Layout {...props} isMobile={false} />);
    expect(screen.getByTestId("tools-rail-column")).toBeInTheDocument();
    rerender(<Layout {...props} isMobile />);
    expect(screen.queryByTestId("tools-rail-column")).not.toBeInTheDocument();
    rerender(<Layout {...props} isMobile={false} />);
    expect(screen.getByTestId("tools-rail-column")).toBeInTheDocument();
    expect(agentChildMounts).toBe(1);
    expect(agentChildUnmounts).toBe(0);
  });

  it("8.T2 — mobile canvas / without a tool panel: no rail column", () => {
    setLayoutState({ layoutMode: "workspace" });
    const { unmount } = renderLayout({ isMobile: true, workspaceCanvas: <div data-testid="canvas" /> });
    expect(screen.queryByTestId("tools-rail-column")).not.toBeInTheDocument();
    unmount();
    renderLayout({ isMobile: true, toolPanel: null });
    expect(screen.queryByTestId("tools-rail-column")).not.toBeInTheDocument();
  });

  it("tools fullscreen overlay stops short of the rail column", () => {
    const { container } = renderLayout();
    act(() => useWorkspaceStore.getState().setWorkspacePaneFullscreen("tools"));
    expect(container.querySelector(".pane-viewport-fullscreen--keep-rail")).not.toBeNull();
  });

  it("mobile tools fullscreen overlay has no keep-rail (the pane carries its own rail)", () => {
    const { container } = renderLayout({ isMobile: true });
    act(() => useWorkspaceStore.getState().setWorkspacePaneFullscreen("tools"));
    expect(container.querySelector(".pane-viewport-fullscreen")).not.toBeNull();
    expect(container.querySelector(".pane-viewport-fullscreen--keep-rail")).toBeNull();
  });
});

describe("Layout sidebar resize and host page writes", () => {
  function renderWithResize(demo: boolean) {
    const ui = (
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
        onLeftSidebarResize={() => {}}
      />
    );
    const env = { demo, viewport: null, scale: 1, portalRoot: null, eventRoot: null };
    return render(<DemoEnvProvider value={env}>{ui}</DemoEnvProvider>);
  }

  function startResize() {
    const handle = screen.getByRole("separator", { name: "Resize sidebar" });
    (handle as HTMLElement).setPointerCapture = vi.fn();
    const ev = new MouseEvent("pointerdown", { clientX: 200, bubbles: true, cancelable: true });
    Object.defineProperty(ev, "pointerId", { value: 1 });
    fireEvent(handle, ev);
  }

  it("a sidebar resize drag writes body cursor/userSelect outside demo mode", () => {
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    renderWithResize(false);
    startResize();
    expect(document.body.style.cursor).toBe("col-resize");
    window.dispatchEvent(new MouseEvent("pointerup", { clientX: 210 }));
    expect(document.body.style.cursor).toBe("");
  });

  it("does not touch document.body styles in demo mode", () => {
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    renderWithResize(true);
    startResize();
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });
});

describe("Layout actions chip (7.T1-7.T3)", () => {
  const probe = <button type="button" data-testid="actions-probe">s</button>;

  function setState(
    patch: Partial<{
      toolPanelVisible: boolean;
      toolSplitOrientation: "horizontal" | "vertical";
      layoutMode: "classic" | "workspace";
      terminalDockVisible: boolean;
    }> = {},
  ) {
    act(() => {
      useWorkspaceStore.setState({
        activeWorktreeId: "wt-own",
        workspacePaneFullscreen: null,
        layoutByWorktree: {
          "wt-own": {
            toolPanelVisible: true,
            toolPanelTab: "files",
            terminalDockVisible: false,
            toolSplitOrientation: "horizontal",
            layoutMode: "classic",
            activeWorkspaceId: null,
            scratchCanvas: null,
            canvasToolbarVisible: true,
            ...patch,
          },
        },
      });
    });
  }

  function ui(props: Partial<React.ComponentProps<typeof Layout>> = {}) {
    return (
      <Layout
        topBar={<div />}
        leftSidebar={<div />}
        agentPane={
          <div data-testid="agent-host">
            <ActionsHost zone="agent" />
          </div>
        }
        toolPanel={
          <div data-testid="tools-host">
            <ActionsHost zone="tools" />
          </div>
        }
        terminalDock={<div />}
        leftColumnPx={200}
        isMobile={false}
        mobileSidebarOpen={false}
        onMobileSidebarClose={() => {}}
        isClassicLayout
        actionsGroup={probe}
        {...props}
      />
    );
  }

  /** The chip renders once (a `.top-actions-anchor`, last child of #workspace-layout); `hostTestId` holds the ONE active reserve. */
  function expectOneIn(hostTestId: string | null) {
    const found = screen.queryAllByTestId("actions-probe");
    if (hostTestId == null) {
      expect(document.querySelectorAll(".actions-host__reserve[data-active]")).toHaveLength(0);
      return;
    }
    expect(found).toHaveLength(1);
    expect(found[0]!.closest(".top-actions-anchor")).not.toBeNull();
    const active = document.querySelectorAll(".actions-host__reserve[data-active]");
    expect(active).toHaveLength(1);
    expect(screen.getByTestId(hostTestId).contains(active[0]!)).toBe(true);
  }

  beforeEach(() => setState());

  it("7.T1 — classic with tools visible: the tools host reserves the chip", () => {
    render(ui());
    expectOneIn("tools-host");
  });

  it("7.T1 — tools hidden: the agent host reserves the chip", () => {
    setState({ toolPanelVisible: false });
    render(ui());
    expectOneIn("agent-host");
  });

  it("7.T1 — the reserve follows tools hide/show and the chip stays single", () => {
    render(ui());
    expectOneIn("tools-host");
    setState({ toolPanelVisible: false });
    expectOneIn("agent-host");
    setState({ toolPanelVisible: true });
    expectOneIn("tools-host");
    setState({ toolSplitOrientation: "vertical" });
    expectOneIn("tools-host");
  });

  it("7.T1 — any non-null workspacePaneFullscreen: chip stays mounted (hidden by data-pane-fullscreen), no reserve", () => {
    const { container } = render(ui());
    const layoutMain = container.querySelector("#workspace-layout") as HTMLElement;
    const probeNode = screen.getByTestId("actions-probe");
    act(() => useWorkspaceStore.getState().setWorkspacePaneFullscreen("tools"));
    expectOneIn(null);
    expect(layoutMain).toHaveAttribute("data-pane-fullscreen", "tools");
    expect(screen.getByTestId("actions-probe")).toBe(probeNode);
    act(() => useWorkspaceStore.getState().setWorkspacePaneFullscreen("agent"));
    expectOneIn(null);
    expect(layoutMain).toHaveAttribute("data-pane-fullscreen", "agent");
    act(() => useWorkspaceStore.getState().setWorkspacePaneFullscreen(null));
    expectOneIn("tools-host");
    expect(layoutMain).not.toHaveAttribute("data-pane-fullscreen");
    expect(screen.getByTestId("actions-probe")).toBe(probeNode);
  });

  it("7.T1 — terminal fullscreen: no reserve, chip mounted", () => {
    setState({ terminalDockVisible: true });
    const { container } = render(ui());
    act(() => useWorkspaceStore.getState().setWorkspacePaneFullscreen("terminal"));
    expectOneIn(null);
    expect(container.querySelector("#workspace-layout")).toHaveAttribute("data-pane-fullscreen", "terminal");
    expect(container.querySelectorAll(".top-actions-anchor")).toHaveLength(1);
  });

  it("7.T1 — canvas: the canvas host carries the group", () => {
    setState({ layoutMode: "workspace" });
    render(
      ui({
        workspaceCanvas: (
          <div data-testid="canvas-host">
            <ActionsHost zone="canvas" />
          </div>
        ),
      }),
    );
    expectOneIn("canvas-host");
  });

  it("7.T1 — workspace mode without a canvas node takes the classic path", () => {
    setState({ layoutMode: "workspace" });
    render(ui());
    expectOneIn("tools-host");
  });

  it("7.T1 — mobile or no actionsGroup: no chip and no reserve", () => {
    const { unmount, container } = render(ui({ isMobile: true }));
    expectOneIn(null);
    expect(container.querySelector(".top-actions-anchor")).toBeNull();
    unmount();
    const second = render(ui({ actionsGroup: undefined }));
    expectOneIn(null);
    expect(second.container.querySelector(".top-actions-anchor")).toBeNull();
  });

  it("7.T2 — terminal dock strip + agent strip with tools hidden: exactly one active reserve, in the agent strip", () => {
    setState({ toolPanelVisible: false, terminalDockVisible: true });
    const api = createMockApi();
    render(
      <MemoryRouter>
        {ui({
          agentPane: (
            <div data-testid="agent-strip">
              <TabsStrip api={api} worktreeId="wt-own" kind="agent" />
            </div>
          ),
          terminalDock: (
            <div data-testid="dock-strip">
              <TabsStrip api={api} worktreeId="wt-own" kind="terminal" />
            </div>
          ),
        })}
      </MemoryRouter>,
    );
    expectOneIn("agent-strip");
    expect(screen.getByTestId("dock-strip").querySelector(".actions-host")).toBeNull();
  });

  it("7.T3 — .pane-left keeps its node identity when dashboardPane is added/removed; exactly one chip anchor", () => {
    const { container, rerender } = render(ui());
    const paneLeft = container.querySelector(".pane-left");
    expect(paneLeft).not.toBeNull();
    rerender(ui({ dashboardPane: <div data-testid="dash" /> }));
    expect(screen.getByTestId("dash")).toBeInTheDocument();
    expect(container.querySelector(".pane-left")).toBe(paneLeft);
    rerender(ui());
    expect(container.querySelector(".pane-left")).toBe(paneLeft);
    expect(container.querySelectorAll(".top-actions-anchor")).toHaveLength(1);
    expect(container.querySelector(".top-bar-floating-actions-container")).toBeNull();
    expect(container.querySelector(".tool-panel__top-actions")).toBeNull();
  });
});

function WorkspaceActionsHarness() {
  return <WorkspaceActions isMobile={false} onOpenQuickOpen={() => {}} canvasWorktreeId="wt-own" />;
}

describe("actions chip never remounts or moves", () => {
  const TOGGLE = "Toggle tool panel";
  const stub = (
    <div data-testid="group">
      <button type="button" aria-label="Search files" />
      <button type="button" aria-label="More options" />
      <button type="button" aria-label={TOGGLE} />
    </div>
  );

  function setState(patch: Record<string, unknown> = {}) {
    act(() => {
      useWorkspaceStore.setState({
        activeWorktreeId: "wt-own",
        workspacePaneFullscreen: null,
        layoutTransitionHint: null,
        layoutByWorktree: {
          "wt-own": {
            toolPanelVisible: true,
            toolPanelTab: "files",
            terminalDockVisible: false,
            toolSplitOrientation: "horizontal",
            layoutMode: "classic",
            activeWorkspaceId: null,
            scratchCanvas: null,
            canvasToolbarVisible: true,
            ...patch,
          },
        },
      });
    });
  }

  function ui(props: Partial<React.ComponentProps<typeof Layout>> = {}) {
    return (
      <Layout
        topBar={<div />}
        leftSidebar={<div />}
        agentPane={
          <div data-testid="agent-host">
            <AgentChild />
            <ActionsHost zone="agent" />
          </div>
        }
        toolPanel={
          <div data-testid="tools-host">
            <ActionsHost zone="tools" />
          </div>
        }
        terminalDock={<div />}
        leftColumnPx={200}
        isMobile={false}
        mobileSidebarOpen={false}
        onMobileSidebarClose={() => {}}
        isClassicLayout
        actionsGroup={stub}
        {...props}
      />
    );
  }

  beforeEach(() => {
    agentChildMounts = 0;
    agentChildUnmounts = 0;
    setState();
  });

  const layoutOf = (c: HTMLElement) => c.querySelector("#workspace-layout") as HTMLElement;

  it("(a) the chip, Search, '...' and the toggle keep node identity and parent through every layout step", () => {
    const { container } = render(ui());
    const layout = layoutOf(container);
    const chip = container.querySelector(".top-actions-anchor") as HTMLElement;
    // The rail also has a "Search files" mode button: scope Search to the chip.
    const search = () => within(chip).getByLabelText("Search files");
    const nodes = [chip, search(), screen.getByLabelText("More options"), screen.getByLabelText(TOGGLE)];
    const check = (label: string) => {
      expect(container.querySelectorAll(".top-actions-anchor"), label).toHaveLength(1);
      expect(container.querySelector(".top-actions-anchor"), label).toBe(chip);
      expect(search(), label).toBe(nodes[1]);
      expect(screen.getByLabelText("More options"), label).toBe(nodes[2]);
      expect(screen.getByLabelText(TOGGLE), label).toBe(nodes[3]);
      expect(chip.parentElement, label).toBe(layout);
      expect(layout.lastElementChild, label).toBe(chip);
      // (d) data-rail is present iff the rail is rendered.
      expect(layout.hasAttribute("data-rail"), label).toBe(screen.queryByTestId("tools-rail-column") != null);
      // (e) the terminal never remounts.
      expect(agentChildMounts, label).toBe(1);
      expect(agentChildUnmounts, label).toBe(0);
    };
    check("initial");
    expect(layout).toHaveAttribute("data-rail");
    const steps: Array<[string, () => void]> = [
      ["tools hidden", () => setState({ toolPanelVisible: false })],
      ["tools shown", () => setState({ toolPanelVisible: true })],
      ["tools hidden again", () => setState({ toolPanelVisible: false })],
      ["tools shown again", () => setState({ toolPanelVisible: true })],
      ["vertical", () => setState({ toolSplitOrientation: "vertical" })],
      ["horizontal", () => setState({ toolSplitOrientation: "horizontal" })],
      ["list toggled", () => act(() => useWorkspaceStore.getState().toggleFileTree())],
      ["list toggled back", () => act(() => useWorkspaceStore.getState().toggleFileTree())],
      ["tools fullscreen", () => act(() => useWorkspaceStore.getState().setWorkspacePaneFullscreen("tools"))],
      ["fullscreen exit", () => act(() => useWorkspaceStore.getState().setWorkspacePaneFullscreen(null))],
      ["toggleToolPanel", () => act(() => useWorkspaceStore.getState().toggleToolPanel())],
      ["toggleToolPanel back", () => act(() => useWorkspaceStore.getState().toggleToolPanel())],
    ];
    for (const [label, step] of steps) {
      step();
      check(label);
    }
  });

  it("(b) no transition hold: no data-tools-transition, and no inline visibility/opacity on the chip subtree", () => {
    const { container } = render(ui());
    const chip = container.querySelector(".top-actions-anchor") as HTMLElement;
    const noHold = () => {
      expect(layoutOf(container)).not.toHaveAttribute("data-tools-transition");
      for (const el of [chip, ...Array.from(chip.querySelectorAll<HTMLElement>("*"))]) {
        expect(el.style.visibility).toBe("");
        expect(el.style.opacity).toBe("");
      }
    };
    noHold();
    act(() => useWorkspaceStore.getState().toggleToolPanel());
    noHold(); // right after the toggle, inside the former hold window
    act(() => useWorkspaceStore.getState().toggleToolPanel());
    noHold();
  });

  it("(c) a keyboard hide keeps focus on the very same toggle node", () => {
    render(ui({ actionsGroup: <WorkspaceActionsHarness /> }));
    const toggle = screen.getByLabelText(TOGGLE);
    toggle.focus();
    fireEvent.click(toggle, { detail: 0 });
    expect(screen.queryByTestId("tools-rail-column")).not.toBeInTheDocument();
    expect(screen.getByLabelText(TOGGLE)).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
    fireEvent.click(toggle, { detail: 0 });
    expect(screen.getByTestId("tools-rail-column")).toBeInTheDocument();
    expect(document.activeElement).toBe(toggle);
  });

  it("the rail head is an empty spacer; the chip alone holds the toggle (tools shown and hidden)", () => {
    render(ui());
    const head = screen.getByTestId("tools-rail-column").querySelector(".tools-rail__head") as HTMLElement;
    expect(head.childNodes).toHaveLength(0);
    expect(screen.getAllByLabelText(TOGGLE)).toHaveLength(1);
    setState({ toolPanelVisible: false });
    expect(screen.getAllByLabelText(TOGGLE)).toHaveLength(1);
    expect(screen.getByLabelText(TOGGLE).closest(".top-actions-anchor")).not.toBeNull();
  });

  it("tools fullscreen keeps the toggle mounted (hidden by CSS on #workspace-layout[data-pane-fullscreen])", () => {
    const { container } = render(ui());
    act(() => useWorkspaceStore.getState().setWorkspacePaneFullscreen("tools"));
    expect(screen.queryAllByLabelText(TOGGLE)).toHaveLength(1);
    expect(layoutOf(container)).toHaveAttribute("data-pane-fullscreen", "tools");
  });

  it("canvas: the chip is present, there is no rail and no data-rail", () => {
    setState({ layoutMode: "workspace" });
    const { container } = render(
      ui({
        workspaceCanvas: (
          <div data-testid="canvas-host">
            <ActionsHost zone="canvas" />
          </div>
        ),
      }),
    );
    expect(screen.queryByTestId("tools-rail-column")).not.toBeInTheDocument();
    expect(layoutOf(container)).not.toHaveAttribute("data-rail");
    expect(screen.getAllByLabelText(TOGGLE)).toHaveLength(1);
    expect(container.querySelector(".top-actions-anchor")).not.toBeNull();
  });

  it("phones: no chip, no rail head, no toggle from Layout", () => {
    const { container } = render(ui({ isMobile: true }));
    expect(container.querySelector(".top-actions-anchor")).toBeNull();
    expect(container.querySelector(".tools-rail__head")).toBeNull();
    expect(screen.queryAllByLabelText(TOGGLE)).toHaveLength(0);
  });
});

describe("Layout: dashboard <-> worktree return keeps paneHostLayer at the same child index", () => {
  function base(extra: Partial<React.ComponentProps<typeof Layout>>) {
    return (
      <Layout
        topBar={<div />}
        leftSidebar={<div />}
        leftColumnPx={200}
        isMobile={false}
        mobileSidebarOpen={false}
        onMobileSidebarClose={() => {}}
        paneHostLayer={<AgentChild />}
        {...extra}
      />
    );
  }

  it("a live pane in paneHostLayer is NOT remounted going dashboard -> regions -> dashboard", () => {
    agentChildMounts = 0;
    agentChildUnmounts = 0;
    const regions = { agentPane: <div />, toolPanel: <div />, terminalDock: <div /> };
    const { rerender } = render(base({ dashboardPane: <div data-testid="dash" /> }));
    expect(agentChildMounts).toBe(1);
    rerender(base(regions));
    expect(screen.queryByTestId("dash")).not.toBeInTheDocument();
    rerender(base({ dashboardPane: <div data-testid="dash" /> }));
    expect(screen.getByTestId("dash")).toBeInTheDocument();
    expect(agentChildMounts).toBe(1);
    expect(agentChildUnmounts).toBe(0);
  });
});
