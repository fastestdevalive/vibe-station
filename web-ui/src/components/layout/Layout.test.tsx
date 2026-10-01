import { useEffect, type ReactNode } from "react";
import { render, act, screen, fireEvent } from "@testing-library/react";
import { DemoEnvProvider } from "@/context/DemoEnv";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useWorkspaceStore } from "@/hooks/useStore";
import { Layout } from "./Layout";
import { useTopRightInset } from "@/context/TopRightInsetContext";

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

describe("Layout top-right inset under a scaled demo stage", () => {
  function InsetProbe() {
    return <div data-testid="inset">{useTopRightInset().width}</div>;
  }

  function renderInset(env: { demo: boolean; scale: number }) {
    act(() => {
      useWorkspaceStore.setState({
        activeWorktreeId: "wt-inset",
        layoutByWorktree: {
          "wt-inset": {
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
    });
    const ui = (
      <Layout
        topBar={<div />}
        leftSidebar={<div />}
        agentPane={<InsetProbe />}
        toolPanel={<div />}
        terminalDock={<div />}
        leftColumnPx={200}
        isMobile={false}
        mobileSidebarOpen={false}
        onMobileSidebarClose={() => {}}
        onLeftSidebarResize={() => {}}
        isClassicLayout
        floatingTopBar={<span>controls</span>}
      />
    );
    return render(
      <DemoEnvProvider value={{ ...env, viewport: null, portalRoot: null, eventRoot: null }}>{ui}</DemoEnvProvider>,
    );
  }

  it("divides the measured floating-controls width by the host scale in demo mode", () => {
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 98, bottom: 35, width: 98, height: 35, toJSON: () => ({}) });
    try {
      renderInset({ demo: true, scale: 0.98 });
      expect(screen.getByTestId("inset").textContent).toBe("100");
    } finally {
      spy.mockRestore();
    }
  });

  it("uses the raw measured width outside demo mode", () => {
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 98, bottom: 35, width: 98, height: 35, toJSON: () => ({}) });
    try {
      renderInset({ demo: false, scale: 0.98 });
      expect(screen.getByTestId("inset").textContent).toBe("98");
    } finally {
      spy.mockRestore();
    }
  });
});
