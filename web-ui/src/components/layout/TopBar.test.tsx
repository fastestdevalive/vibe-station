import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useState } from "react";
import { DemoEnvProvider } from "@/context/DemoEnv";
import { createTopActionsStore, TopActionsProvider } from "@/context/TopActionsContext";
import { ActionsHost, TopActionsOwner } from "./TopActionsSlot";
import { TopBar } from "./TopBar";
import { PaneOutletProvider } from "./paneOutlets";
import { DEFAULT_WORKTREE_LAYOUT, useWorkspaceStore, type CanvasGeometry } from "@/hooks/useStore";
import { useUpdateStore } from "@/hooks/useUpdateStore";
import type { Project, Worktree } from "@/api/types";

const W1 = "wt-1";

const projects: Project[] = [
  {
    id: "proj-1",
    name: "Proj A",
    path: "/tmp/proj-a",
    prefix: "proj-a",
    isGit: true,
    createdAt: new Date().toISOString(),
    hidden: false,
    lspEnabled: false,
  },
];
const worktrees: Worktree[] = [
  { id: W1, projectId: "proj-1", branch: "main", baseBranch: "main", createdAt: new Date().toISOString(), pinnedAt: null, hiddenAt: null, lspEnabled: false },
];

const emptyCanvas: CanvasGeometry = { mode: "free", tiles: [], tree: null, freeRects: {} };

function renderTopBar() {
  return render(
    <MemoryRouter>
      <PaneOutletProvider>
        <TopBar
          projects={projects}
          isMobile={false}
          onToggleLeftSidebar={() => {}}
          leftSidebarCollapsed={false}
          mobileSidebarOpen={false}
          onOpenQuickOpen={() => {}}
        />
      </PaneOutletProvider>
    </MemoryRouter>,
  );
}

describe("TopBar - canvas mode pane toggles", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.persist.clearStorage?.();
  });

  function setCanvasMode(overrides: Partial<typeof DEFAULT_WORKTREE_LAYOUT> = {}) {
    useWorkspaceStore.setState({
      activeProjectId: "proj-1",
      activeWorktreeId: W1,
      activeDirectContextId: null,
      layoutByWorktree: {
        [W1]: { ...DEFAULT_WORKTREE_LAYOUT, layoutMode: "workspace", scratchCanvas: emptyCanvas, ...overrides },
      },
      workspaceDocs: {},
    });
  }

  function setClassicMode() {
    useWorkspaceStore.setState({
      activeProjectId: "proj-1",
      activeWorktreeId: W1,
      activeDirectContextId: null,
      layoutByWorktree: { [W1]: { ...DEFAULT_WORKTREE_LAYOUT, layoutMode: "classic" } },
      workspaceDocs: {},
    });
  }

  it("disables the split-orientation and terminal-dock buttons in canvas mode", async () => {
    const user = userEvent.setup();
    setCanvasMode();
    renderTopBar();
    await user.click(screen.getByLabelText("More options"));
    expect(screen.getByText(/Split:/).closest("button")).toBeDisabled();
    expect(screen.getByText("Terminal").closest("button")).toBeDisabled();
  });

  it("leaves the split-orientation and terminal-dock buttons enabled in classic mode", async () => {
    const user = userEvent.setup();
    setClassicMode();
    renderTopBar();
    await user.click(screen.getByLabelText("More options"));
    expect(screen.getByText(/Split:/).closest("button")).toBeEnabled();
    expect(screen.getByText("Terminal").closest("button")).toBeEnabled();
  });

  it("Tools button adds/removes a canvas tile (not content visibility) in canvas mode", async () => {
    const user = userEvent.setup();
    setCanvasMode();
    renderTopBar();
    const toolsBtn = screen.getByLabelText("Add Tools tile to canvas");
    await user.click(toolsBtn);
    expect(useWorkspaceStore.getState().layoutByWorktree[W1]!.scratchCanvas!.tiles).toHaveLength(1);
    expect(screen.getByLabelText("Remove Tools tile from canvas")).toBeInTheDocument();
    // The content-visibility flag this button used to control is untouched.
    expect(useWorkspaceStore.getState().layoutByWorktree[W1]!.toolPanelVisible).toBe(
      DEFAULT_WORKTREE_LAYOUT.toolPanelVisible,
    );
  });

  function renderVariant(
    props: Partial<React.ComponentProps<typeof TopBar>> = {},
  ) {
    return render(
      <MemoryRouter>
        <PaneOutletProvider>
          <TopBar
            projects={projects}
            isMobile={false}
            onToggleLeftSidebar={() => {}}
            leftSidebarCollapsed={false}
            mobileSidebarOpen={false}
            onOpenQuickOpen={() => {}}
            {...props}
          />
        </PaneOutletProvider>
      </MemoryRouter>,
    );
  }

  it("floating classic: the LAST button of the actions group is the tools toggle; aria-pressed follows the store and a click flips it", async () => {
    const user = userEvent.setup();
    setClassicMode();
    const { container } = renderVariant({ variant: "floating" });
    const group = container.querySelector(".top-bar-floating-actions") as HTMLElement;
    const buttons = group.querySelectorAll("button");
    expect(buttons, "chip width is --top-actions-w (3 buttons): bump it in workspace.css and CHIP_W").toHaveLength(3);
    const last = buttons[buttons.length - 1] as HTMLElement;
    expect(last).toHaveAccessibleName("Toggle tool panel");
    expect(screen.getAllByLabelText("Toggle tool panel")).toHaveLength(1);
    expect(last).toHaveAttribute("aria-pressed", String(DEFAULT_WORKTREE_LAYOUT.toolPanelVisible));
    const before = useWorkspaceStore.getState().layoutByWorktree[W1]!.toolPanelVisible;
    await user.click(last);
    expect(useWorkspaceStore.getState().layoutByWorktree[W1]!.toolPanelVisible).toBe(!before);
    expect(screen.getByLabelText("Toggle tool panel")).toHaveAttribute("aria-pressed", String(!before));
    expect(screen.queryByLabelText("Add Tools tile to canvas")).not.toBeInTheDocument();
  });

  it("floating classic under an owner: the toggle (with its badge) is inline in the chip group and keeps aria-pressed", () => {
    setClassicMode();
    act(() => useWorkspaceStore.setState({ layoutByWorktree: { [W1]: { ...DEFAULT_WORKTREE_LAYOUT, layoutMode: "classic", toolPanelVisible: false } } }));
    const { container } = render(
      <MemoryRouter>
        <PaneOutletProvider>
          <TopActionsProvider store={createTopActionsStore()}>
            <div data-testid="row">
              <ActionsHost zone="agent" />
            </div>
            <TopActionsOwner zones={["agent"]}>
              <TopBar
                variant="floating"
                projects={projects}
                isMobile={false}
                onToggleLeftSidebar={() => {}}
                leftSidebarCollapsed={false}
                mobileSidebarOpen={false}
                onOpenQuickOpen={() => {}}
                toolsToggleCount={3}
              />
            </TopActionsOwner>
          </TopActionsProvider>
        </PaneOutletProvider>
      </MemoryRouter>,
    );
    const toggle = screen.getByLabelText(/^Toggle tool panel/);
    expect(screen.getAllByLabelText(/^Toggle tool panel/)).toHaveLength(1);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(container.querySelector(".top-bar-floating-actions")).toContainElement(toggle);
    expect(container.querySelector(".actions-host")).not.toContainElement(toggle);
    expect(toggle).toHaveAccessibleName("Toggle tool panel, 3 unsent comments");
    expect(container.querySelectorAll(".top-bar-floating-actions")).toHaveLength(1);
  });

  it("bar, mobile: the last button of .top-bar__end is the tools toggle with the PanelTop icon (vertical default split)", () => {
    setClassicMode();
    const { container } = renderVariant({ isMobile: true });
    const end = container.querySelector(".top-bar__end") as HTMLElement;
    const buttons = end.querySelectorAll("button");
    const last = buttons[buttons.length - 1] as HTMLElement;
    expect(last).toHaveAccessibleName("Toggle tool panel");
    expect(last.querySelector("svg.lucide-panel-top")).not.toBeNull();
  });

  it("project route in stored workspace mode (no canvas): the classic toggle", () => {
    useWorkspaceStore.setState({
      activeProjectId: "proj-1",
      activeWorktreeId: null,
      activeDirectContextId: "proj-1",
      layoutByWorktree: { "proj-1": { ...DEFAULT_WORKTREE_LAYOUT, layoutMode: "workspace" } },
      workspaceDocs: {},
    });
    renderVariant({ variant: "floating", layoutMode: "project-workspace" });
    expect(screen.getByLabelText("Toggle tool panel")).toBeInTheDocument();
    expect(screen.queryByLabelText("Add Tools tile to canvas")).not.toBeInTheDocument();
  });

  it("canvas mode: exactly one .top-bar__pane-btn, the Add/Remove Tools tile", () => {
    setCanvasMode();
    const { container } = renderVariant({ variant: "floating" });
    expect(container.querySelectorAll(".top-bar__pane-btn")).toHaveLength(1);
    expect(screen.getByLabelText("Add Tools tile to canvas")).toBeInTheDocument();
    expect(screen.queryByLabelText("Toggle tool panel")).not.toBeInTheDocument();
  });

  it("toolsToggleCount is shown and announced on the toggle only while the tools pane is hidden, never in canvas mode; none at 0", () => {
    setClassicMode();
    act(() => useWorkspaceStore.setState({ layoutByWorktree: { [W1]: { ...DEFAULT_WORKTREE_LAYOUT, layoutMode: "classic", toolPanelVisible: false } } }));
    const { container, unmount } = renderVariant({ variant: "floating", toolsToggleCount: 3 });
    expect(screen.getByRole("button", { name: "Toggle tool panel, 3 unsent comments" })).toBeInTheDocument();
    expect(container.querySelector(".top-bar__pane-badge")).toHaveTextContent("3");
    unmount();

    const zero = renderVariant({ variant: "floating", toolsToggleCount: 0 });
    expect(screen.getByRole("button", { name: "Toggle tool panel" })).toBeInTheDocument();
    expect(zero.container.querySelector(".top-bar__pane-badge")).toBeNull();
    zero.unmount();

    act(() => useWorkspaceStore.setState({ layoutByWorktree: { [W1]: { ...DEFAULT_WORKTREE_LAYOUT, layoutMode: "classic", toolPanelVisible: true } } }));
    const second = renderVariant({ variant: "floating", toolsToggleCount: 3 });
    expect(second.container.querySelector(".top-bar__pane-badge")).toBeNull();
    expect(screen.getByRole("button", { name: "Toggle tool panel" })).toBeInTheDocument();
    second.unmount();

    setCanvasMode();
    const canvas = renderVariant({ variant: "floating", toolsToggleCount: 3 });
    expect(canvas.container.querySelector(".top-bar__pane-badge")).toBeNull();
  });

  // The dedicated canvas toolbar itself lives in WorkspaceCanvas now (its own
  // row above the canvas body), not in TopBar — TopBar only owns the chip
  // that drives `canvasToolbarVisible`. See WorkspaceCanvas.test.tsx for the
  // "does the row actually show/hide" half of this behavior.
  it("keeps the canvas chip (mode toggle + chevron) mounted in both pane layout modes", async () => {
    const user = userEvent.setup();
    setClassicMode();
    const { unmount } = renderTopBar();
    await user.click(screen.getByLabelText("More options"));
    expect(screen.getByText(/Canvas layout/).closest("button")).toBeInTheDocument();
    expect(screen.getByTitle("Switch to canvas mode first")).toBeInTheDocument();
    unmount();

    setCanvasMode();
    renderTopBar();
    await user.click(screen.getByLabelText("More options"));
    expect(screen.getByText(/Canvas layout/).closest("button")).toBeInTheDocument();
    expect(screen.getByTitle("Hide canvas toolbar")).toBeInTheDocument();
  });

  it("disables the chevron outside canvas mode and enables it inside", async () => {
    const user = userEvent.setup();
    setClassicMode();
    const { unmount } = renderTopBar();
    await user.click(screen.getByLabelText("More options"));
    expect(screen.getByTitle("Switch to canvas mode first")).toBeDisabled();
    unmount();

    setCanvasMode();
    renderTopBar();
    await user.click(screen.getByLabelText("More options"));
    expect(screen.getByTitle("Hide canvas toolbar")).toBeEnabled();
  });

  it("chevron toggles canvasToolbarVisible (the flag WorkspaceCanvas's own toolbar row reads)", async () => {
    const user = userEvent.setup();
    setCanvasMode();
    renderTopBar();
    await user.click(screen.getByLabelText("More options"));
    // Default visible (canvasToolbarVisible defaults true).
    const hideBtn = screen.getByTitle("Hide canvas toolbar");
    await user.click(hideBtn);
    expect(useWorkspaceStore.getState().layoutByWorktree[W1]!.canvasToolbarVisible).toBe(false);

    // Reopen menu to toggle back on
    await user.click(screen.getByLabelText("More options"));
    const showBtn = screen.getByTitle("Show canvas toolbar");
    await user.click(showBtn);
    expect(useWorkspaceStore.getState().layoutByWorktree[W1]!.canvasToolbarVisible).toBe(true);
  });
});

describe("TopBar - project workspace", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.persist.clearStorage?.();
    useWorkspaceStore.setState({
      activeProjectId: "proj-1",
      activeWorktreeId: null,
      activeDirectContextId: "proj-1",
      layoutByWorktree: {},
      workspaceDocs: {},
    });
  });

  it("4.T9 — layoutMode 'project-workspace' renders project breadcrumb on desktop and renders action buttons", () => {
    render(
      <MemoryRouter>
        <PaneOutletProvider>
          <TopBar
            layoutMode="project-workspace"
            projects={projects}
            isMobile={false}
            onToggleLeftSidebar={() => {}}
            leftSidebarCollapsed={false}
            mobileSidebarOpen={false}
            onOpenQuickOpen={() => {}}
          />
        </PaneOutletProvider>
      </MemoryRouter>,
    );

    // On desktop, project name is rendered in the top bar
    expect(screen.getByText("Proj A")).toBeInTheDocument();
    expect(screen.queryByText("Dashboard")).not.toBeInTheDocument();

    // The pane-toggle buttons (Files search, More options) are present
    expect(screen.getByLabelText("Search files")).toBeInTheDocument();
    expect(screen.getByLabelText("More options")).toBeInTheDocument();
  });

  it("4.T9 — on mobile, layoutMode 'project-workspace' preserves project name", () => {
    render(
      <MemoryRouter>
        <PaneOutletProvider>
          <TopBar
            layoutMode="project-workspace"
            projects={projects}
            isMobile={true}
            onToggleLeftSidebar={() => {}}
            leftSidebarCollapsed={false}
            mobileSidebarOpen={false}
            onOpenQuickOpen={() => {}}
          />
        </PaneOutletProvider>
      </MemoryRouter>,
    );

    expect(screen.getByText("Proj A")).toBeInTheDocument();
  });

  it("renders UpdateChip next to ConnectionStatus when store is actionable", () => {
    useUpdateStore.setState({
      status: {
        current: "1.0.0",
        latest: "1.2.3",
        updateAvailable: true,
        behindCount: 1,
        skipped: [],
        installMethod: "curl",
        targets: [],
        autoCheck: true,
        platform: "linux-x86_64",
        noAsset: false,
      },
      canInstall: true,
    });

    render(
      <MemoryRouter>
        <PaneOutletProvider>
          <TopBar
            layoutMode="dashboard"
            projects={projects}
            isMobile={false}
            onToggleLeftSidebar={() => {}}
            leftSidebarCollapsed={false}
            mobileSidebarOpen={false}
            onOpenQuickOpen={() => {}}
          />
        </PaneOutletProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: /Update available/ })).toBeInTheDocument();
  });

  it("does not render UpdateChip when layoutMode is login", () => {
    useUpdateStore.setState({
      status: {
        current: "1.0.0",
        latest: "1.2.3",
        updateAvailable: true,
        behindCount: 1,
        skipped: [],
        installMethod: "curl",
        targets: [],
        autoCheck: true,
        platform: "linux-x86_64",
        noAsset: false,
      },
      canInstall: true,
    });

    render(
      <MemoryRouter>
        <PaneOutletProvider>
          <TopBar
            layoutMode="login"
            projects={projects}
            isMobile={false}
            onToggleLeftSidebar={() => {}}
            leftSidebarCollapsed={false}
            mobileSidebarOpen={false}
            onOpenQuickOpen={() => {}}
          />
        </PaneOutletProvider>
      </MemoryRouter>,
    );

    expect(screen.queryByRole("button", { name: /Update available/ })).toBeNull();
  });
});

describe("TopBar - Tauri drag region (3.T1)", () => {
  it("the main header is a deep drag region and its inner row carries no attribute of its own", () => {
    const { container } = renderTopBar();
    const header = container.querySelector("header.top-bar") as HTMLElement;
    expect(header.getAttribute("data-tauri-drag-region")).toBe("deep");
    const row = header.querySelector(".top-bar__row") as HTMLElement;
    expect(row.hasAttribute("data-tauri-drag-region")).toBe(false);
  });
});

describe("TopBar - dashboardTitle (R2F-04)", () => {
  function renderDash(isMobile: boolean, title?: string) {
    return render(
      <MemoryRouter>
        <PaneOutletProvider>
          <TopBar
            layoutMode="dashboard"
            dashboardTitle={title}
            projects={[]}
            isMobile={isMobile}
            onToggleLeftSidebar={() => {}}
            leftSidebarCollapsed={false}
            mobileSidebarOpen={false}
            onOpenQuickOpen={() => {}}
          />
        </PaneOutletProvider>
      </MemoryRouter>,
    );
  }

  for (const isMobile of [false, true]) {
    const label = isMobile ? "mobile" : "desktop";
    it(`${label}: custom title replaces Dashboard`, () => {
      renderDash(isMobile, "New agent");
      expect(screen.getAllByText("New agent").length).toBeGreaterThan(0);
      expect(screen.queryByText("Dashboard")).not.toBeInTheDocument();
    });
    it(`${label}: defaults to Dashboard`, () => {
      renderDash(isMobile);
      expect(screen.getAllByText("Dashboard").length).toBeGreaterThan(0);
    });
  }
});

describe("TopBar - portaled overflow menu (7.T4)", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.setState({
      activeProjectId: "proj-1",
      activeWorktreeId: W1,
      activeDirectContextId: null,
      layoutByWorktree: { [W1]: { ...DEFAULT_WORKTREE_LAYOUT, layoutMode: "classic" } },
      workspaceDocs: {},
    });
  });

  let setZone: (z: "agent" | "tools") => void = () => {};
  function Harness({ portalRoot, demo }: { portalRoot: HTMLElement | null; demo?: { scale: number } }) {
    const [zone, setZ] = useState<"agent" | "tools">("agent");
    setZone = setZ;
    const [st] = useState(createTopActionsStore);
    const env = {
      demo: !!demo,
      viewport: null,
      scale: demo?.scale ?? 1,
      portalRoot,
      eventRoot: null,
    };
    return (
      <DemoEnvProvider value={env}>
        <MemoryRouter>
          <PaneOutletProvider>
            <TopActionsProvider store={st}>
              <div data-testid="agent-row" style={{ overflow: "hidden" }}>
                <ActionsHost zone="agent" />
              </div>
              <div data-testid="tools-row" style={{ overflow: "hidden" }}>
                <ActionsHost zone="tools" />
              </div>
              <TopActionsOwner zones={[zone]}>
                <TopBar
                  variant="floating"
                  projects={projects}
                  isMobile={false}
                  onToggleLeftSidebar={() => {}}
                  leftSidebarCollapsed={false}
                  mobileSidebarOpen={false}
                  onOpenQuickOpen={() => {}}
                />
              </TopActionsOwner>
            </TopActionsProvider>
          </PaneOutletProvider>
        </MemoryRouter>
      </DemoEnvProvider>
    );
  }

  it("opens with either row reserving the chip; the menu is a fixed child of the portal root, not of the row", async () => {
    const user = userEvent.setup();
    const root = document.createElement("div");
    document.body.appendChild(root);
    try {
      render(<Harness portalRoot={root} />);
      for (const zone of ["agent", "tools"] as const) {
        act(() => setZone(zone));
        const row = screen.getByTestId(`${zone}-row`);
        // The chip (and its "…") is outside every row; the row only holds the active reserve.
        expect(row.querySelector(".actions-host__reserve[data-active]")).not.toBeNull();
        expect(row.contains(screen.getByLabelText("More options"))).toBe(false);
        await user.click(screen.getByLabelText("More options"));
        const menu = screen.getByRole("menu");
        expect(menu.parentElement).toBe(root);
        expect(row.contains(menu)).toBe(false);
        expect(menu.style.position).toBe("fixed");
        expect(parseFloat(menu.style.top)).toBeGreaterThanOrEqual(0);
        expect(parseFloat(menu.style.right)).toBeGreaterThanOrEqual(0);
        expect(parseFloat(menu.style.right)).toBeLessThanOrEqual(window.innerWidth);
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("menu")).toBeNull();
      }
    } finally {
      root.remove();
    }
  });

  it("R1F-03 — Esc closes only the open menu: it never reaches bubble listeners inside the tools row", async () => {
    const user = userEvent.setup();
    render(<Harness portalRoot={null} />);
    act(() => setZone("tools"));
    const bubble = vi.fn();
    screen.getByTestId("tools-row").addEventListener("keydown", bubble);
    const trigger = screen.getByLabelText("More options");
    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(bubble.mock.calls.some(([ev]) => (ev as KeyboardEvent).key === "Escape")).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("under a scaled demo stage the fixed top is the unscaled rect bottom + 4", async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ x: 0, y: 0, top: 10, left: 0, right: 98, bottom: 49, width: 98, height: 39, toJSON: () => ({}) });
    try {
      render(<Harness portalRoot={null} demo={{ scale: 0.98 }} />);
      await user.click(screen.getByLabelText("More options"));
      const menu = screen.getByRole("menu");
      expect(parseFloat(menu.style.top)).toBeCloseTo(49 / 0.98 + 4, 5);
      expect(parseFloat(menu.style.right)).toBeCloseTo(window.innerWidth - 98 / 0.98, 5);
    } finally {
      spy.mockRestore();
    }
  });

  it("clicking outside closes the menu; clicking the trigger again toggles it shut", async () => {
    const user = userEvent.setup();
    render(<Harness portalRoot={null} />);
    await user.click(screen.getByLabelText("More options"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.click(screen.getByLabelText("More options"));
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(screen.getByLabelText("More options"));
    await user.click(document.body);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
