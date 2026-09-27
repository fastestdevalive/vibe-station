import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, beforeEach } from "vitest";
import { TopBar } from "./TopBar";
import { PaneOutletProvider } from "./paneOutlets";
import { DEFAULT_WORKTREE_LAYOUT, useWorkspaceStore, type CanvasGeometry } from "@/hooks/useStore";
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
          worktrees={worktrees}
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

  it("Tools button toggles toolPanelVisible in classic mode (unchanged behavior)", async () => {
    const user = userEvent.setup();
    setClassicMode();
    renderTopBar();
    await user.click(screen.getByLabelText("Toggle tool panel"));
    expect(useWorkspaceStore.getState().layoutByWorktree[W1]!.toolPanelVisible).toBe(
      !DEFAULT_WORKTREE_LAYOUT.toolPanelVisible,
    );
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
            worktrees={worktrees}
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
            worktrees={worktrees}
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
});
