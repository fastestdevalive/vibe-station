import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, it, expect, beforeEach } from "vitest";
import { WorkspaceCanvas } from "./WorkspaceCanvas";
import { PaneOutletProvider, ToolbarOutlet, WORKSPACE_CANVAS_TOOLBAR_KEY } from "./paneOutlets";
import { DEFAULT_WORKTREE_LAYOUT, useWorkspaceStore, type CanvasGeometry } from "@/hooks/useStore";

const W1 = "wt-1";

// WorkspaceCanvas calls useNavigate() (saveAsWorkspace navigates to the new
// doc's /workspaces/:id route) — needs a Router ancestor even when a test
// never triggers a save.
function renderCanvas(canvasToolbarVisible = true) {
  return render(
    <MemoryRouter>
      <PaneOutletProvider>
        <WorkspaceCanvas
          worktreeId={W1}
          agentSessions={[]}
          terminalSessions={[]}
          hasTools
          toolPanelVisible
          terminalDockVisible
          allSessions={[]}
          worktrees={[]}
          projects={[]}
          canvasToolbarVisible={canvasToolbarVisible}
        />
      </PaneOutletProvider>
    </MemoryRouter>,
  );
}

describe("WorkspaceCanvas - canvas toolbar disclosure", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.persist.clearStorage?.();
    useWorkspaceStore.setState({
      layoutByWorktree: {},
      workspaceDocs: {},
    });
  });

  it("does not render its toolbar row when canvasToolbarVisible is false", () => {
    renderCanvas(false);
    expect(screen.queryByRole("toolbar", { name: "Workspace canvas" })).not.toBeInTheDocument();
  });

  it("renders its toolbar as a dedicated row above the canvas body when canvasToolbarVisible is true", () => {
    const { container } = renderCanvas(true);
    const toolbar = screen.getByRole("toolbar", { name: "Workspace canvas" });
    expect(toolbar).toBeInTheDocument();
    // Its OWN row — a direct child of `.workspace-canvas`, immediately before
    // the body — not portaled up into the top bar (that placement is the
    // detached /workspaces/:id view's alone).
    expect(toolbar.parentElement).toHaveClass("workspace-canvas");
    expect(toolbar.nextElementSibling).toHaveClass("workspace-canvas__body");
    expect(toolbar).not.toHaveClass("workspace-canvas__toolbar--portaled");
    expect(container.querySelector(".workspace-canvas__toolbar")).toBe(toolbar);
  });

  it("stays inline even when a toolbar outlet is registered (only the detached view portals)", () => {
    render(
      <MemoryRouter>
        <PaneOutletProvider>
          <ToolbarOutlet paneKey={WORKSPACE_CANVAS_TOOLBAR_KEY} />
          <WorkspaceCanvas
            worktreeId={W1}
            agentSessions={[]}
            terminalSessions={[]}
            hasTools
            toolPanelVisible
            terminalDockVisible
            allSessions={[]}
            worktrees={[]}
            projects={[]}
            canvasToolbarVisible
          />
        </PaneOutletProvider>
      </MemoryRouter>,
    );
    const toolbar = screen.getByRole("toolbar", { name: "Workspace canvas" });
    expect(toolbar.parentElement).toHaveClass("workspace-canvas");
  });
});

describe("WorkspaceCanvas - Add tile picker cross-worktree note", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.persist.clearStorage?.();
    useWorkspaceStore.setState({ layoutByWorktree: {}, workspaceDocs: {} });
  });

  it("shows the cross-worktree note on an unsaved (scratch) canvas", async () => {
    const user = userEvent.setup();
    renderCanvas();
    await user.click(screen.getByText("Add tile"));
    expect(
      screen.getByText("To add panes from other worktrees, save this canvas as a workspace."),
    ).toBeInTheDocument();
  });

  it("hides the cross-worktree note on the detached (saved) workspace-view — the only place isSaved is ever true", async () => {
    const user = userEvent.setup();
    const docId = "doc-1";
    const canvas: CanvasGeometry = { mode: "free", tiles: [], tree: null, freeRects: {} };
    useWorkspaceStore.setState({
      workspaceDocs: { [docId]: { id: docId, name: "Doc", contextKey: W1, ...canvas } },
    });
    render(
      <MemoryRouter>
        <PaneOutletProvider>
          <WorkspaceCanvas
            worktreeId={W1}
            agentSessions={[]}
            terminalSessions={[]}
            hasTools
            toolPanelVisible
            terminalDockVisible
            allSessions={[]}
            worktrees={[]}
            projects={[]}
            canvasToolbarVisible
            detachedWorkspaceId={docId}
          />
        </PaneOutletProvider>
      </MemoryRouter>,
    );
    await user.click(screen.getByText("Add tile"));
    expect(
      screen.queryByText("To add panes from other worktrees, save this canvas as a workspace."),
    ).not.toBeInTheDocument();
  });

  it("offers a project's direct sessions in the cross-context picker (saved workspace), addable with no worktreeId", async () => {
    const user = userEvent.setup();
    const docId = "doc-1";
    const canvas: CanvasGeometry = { mode: "free", tiles: [], tree: null, freeRects: {} };
    useWorkspaceStore.setState({
      workspaceDocs: { [docId]: { id: docId, name: "Doc", contextKey: W1, ...canvas } },
    });
    const project = {
      id: "proj-a",
      name: "Proj A",
      path: "/home/dev/proj-a",
      prefix: "pa",
      isGit: true,
      createdAt: new Date().toISOString(),
      hidden: false,
    };
    const directSession = {
      id: "sess-direct-1",
      worktreeId: null,
      projectId: "proj-a",
      modeId: "mode-1",
      type: "agent" as const,
      name: "My Direct Agent",
      isMain: false,
      state: "idle" as const,
      lifecycleState: "idle" as const,
      tmuxName: "sess-direct-1",
      createdAt: new Date().toISOString(),
    };
    render(
      <MemoryRouter>
        <PaneOutletProvider>
          <WorkspaceCanvas
            worktreeId={W1}
            agentSessions={[]}
            terminalSessions={[]}
            hasTools
            toolPanelVisible
            terminalDockVisible
            allSessions={[directSession]}
            worktrees={[]}
            projects={[project]}
            canvasToolbarVisible
            detachedWorkspaceId={docId}
          />
        </PaneOutletProvider>
      </MemoryRouter>,
    );
    await user.click(screen.getByText("Add tile"));
    expect(screen.getByText("Direct")).toBeInTheDocument();
    const item = screen.getByText("My Direct Agent");
    expect(item).toBeInTheDocument();

    await user.click(item);

    // Tile landed with the direct session's id and no worktreeId (undefined —
    // it's not scoped to any other worktree, matching an own-worktree tile).
    const doc = useWorkspaceStore.getState().workspaceDocs[docId];
    expect(doc?.tiles).toHaveLength(1);
    expect(doc?.tiles[0]).toMatchObject({ kind: "agent", sessionId: "sess-direct-1" });
    expect(doc?.tiles[0]?.worktreeId).toBeUndefined();
  });

  it("a worktree's classic canvas never binds to a saved doc even if a stale activeWorkspaceId is present (regression)", async () => {
    const user = userEvent.setup();
    const docId = "doc-1";
    const canvas: CanvasGeometry = { mode: "free", tiles: [], tree: null, freeRects: {} };
    useWorkspaceStore.setState({
      layoutByWorktree: {
        [W1]: { activeWorkspaceId: docId, scratchCanvas: { mode: "free", tiles: [], tree: null, freeRects: {} } } as never,
      },
      workspaceDocs: { [docId]: { id: docId, name: "Doc", contextKey: W1, ...canvas } },
    });
    renderCanvas();
    expect(screen.getByText("Unsaved canvas")).toBeInTheDocument();
    expect(screen.queryByText("Doc")).not.toBeInTheDocument();
    await user.click(screen.getByText("Add tile"));
    expect(
      screen.getByText("To add panes from other worktrees, save this canvas as a workspace."),
    ).toBeInTheDocument();
  });
});

describe("WorkspaceCanvas - saveAsWorkspace detachment", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.persist.clearStorage?.();
    useWorkspaceStore.setState({
      layoutByWorktree: {
        [W1]: {
          ...DEFAULT_WORKTREE_LAYOUT,
          scratchCanvas: { mode: "free", tiles: [{ id: "t1", kind: "tools" }], tree: null, freeRects: {} },
        },
      },
      workspaceDocs: {},
    });
  });

  it("creates a detached doc, clears the scratch canvas, and navigates to /workspaces/:id — without setting activeWorkspaceId", async () => {
    const user = userEvent.setup();
    function LocationProbe() {
      const location = useLocation();
      return <div data-testid="location">{location.pathname}</div>;
    }
    render(
      <MemoryRouter initialEntries={[`/worktree/${W1}`]}>
        <LocationProbe />
        <PaneOutletProvider>
          <WorkspaceCanvas
            worktreeId={W1}
            agentSessions={[]}
            terminalSessions={[]}
            hasTools={false}
            toolPanelVisible
            terminalDockVisible
            allSessions={[]}
            worktrees={[]}
            projects={[]}
            canvasToolbarVisible
          />
        </PaneOutletProvider>
      </MemoryRouter>,
    );
    await user.click(screen.getByText("Save as workspace"));
    await user.type(screen.getByLabelText("Workspace name"), "My Workspace");
    await user.click(screen.getByLabelText("Confirm save workspace"));

    const state = useWorkspaceStore.getState();
    const docs = Object.values(state.workspaceDocs);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.name).toBe("My Workspace");
    expect(docs[0]!.tiles).toHaveLength(1);
    // Detached: the worktree never remembers it (no setActiveWorkspace call).
    expect(state.layoutByWorktree[W1]!.activeWorkspaceId).toBeNull();
    // Its own scratch canvas was cleared and reset — NOT bound to the saved
    // doc's tiles (the pre-existing seed effect immediately reconstructs an
    // empty canvas from whatever's still open in this worktree, `hasTools`
    // false + no sessions here means genuinely empty — see its own doc
    // comment in WorkspaceCanvas.tsx).
    expect(state.layoutByWorktree[W1]!.scratchCanvas?.tiles).toHaveLength(0);
    // Navigated to the new doc's own route.
    expect(screen.getByTestId("location")).toHaveTextContent(`/workspaces/${docs[0]!.id}`);
  });
});

describe("WorkspaceCanvas - tile status/PR class emission (D21 dedup)", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.persist.clearStorage?.();
    useWorkspaceStore.setState({ layoutByWorktree: {}, workspaceDocs: {} });
  });

  const worktree = { id: W1, projectId: "proj-a", branch: "feature-x", name: "feature-x" } as never;

  function renderOneAgentTile(session: Record<string, unknown>) {
    const canvas: CanvasGeometry = {
      mode: "free",
      tiles: [{ id: "tile-a", kind: "agent", sessionId: "sess-a" }],
      tree: null,
      freeRects: { "tile-a": { x: 0, y: 0, w: 100, h: 100 } },
    };
    useWorkspaceStore.setState({
      layoutByWorktree: { [W1]: { scratchCanvas: canvas } as never },
      workspaceDocs: {},
    });
    return render(
      <MemoryRouter>
        <PaneOutletProvider>
          <WorkspaceCanvas
            worktreeId={W1}
            agentSessions={[session as never]}
            terminalSessions={[]}
            hasTools={false}
            toolPanelVisible
            terminalDockVisible
            allSessions={[session as never]}
            worktrees={[worktree]}
            projects={[]}
            canvasToolbarVisible
          />
        </PaneOutletProvider>
      </MemoryRouter>,
    );
  }

  it("exited + merged PR emits exactly --pr-merged and --exited (D21: colour disagrees with the dimming cue on purpose)", () => {
    const session = {
      id: "sess-a",
      worktreeId: W1,
      projectId: "proj-a",
      modeId: "mode-1",
      type: "agent",
      isMain: true,
      state: "exited",
      lifecycleState: "exited",
      tmuxName: "sess-a",
      createdAt: "",
      pr: { state: "merged", checkedAt: "", prBranch: "feature-x" },
    };
    const { container } = renderOneAgentTile(session);
    const tile = container.querySelector(".workspace-canvas__tile") as HTMLElement;
    expect(tile.className).toContain("workspace-canvas__tile--pr-merged");
    expect(tile.className).toContain("workspace-canvas__tile--exited");
    // Exactly one of each — no accidental duplicate class token.
    expect(tile.className.match(/workspace-canvas__tile--pr-merged/g)).toHaveLength(1);
    expect(tile.className.match(/workspace-canvas__tile--exited/g)).toHaveLength(1);
  });

  it("exited with no PR emits --exited only once (no duplicate from the lifecycleClass dedup)", () => {
    const session = {
      id: "sess-a",
      worktreeId: W1,
      projectId: "proj-a",
      modeId: "mode-1",
      type: "agent",
      isMain: true,
      state: "exited",
      lifecycleState: "exited",
      tmuxName: "sess-a",
      createdAt: "",
    };
    const { container } = renderOneAgentTile(session);
    const tile = container.querySelector(".workspace-canvas__tile") as HTMLElement;
    expect(tile.className).toContain("workspace-canvas__tile--exited");
    expect(tile.className).not.toContain("pr-merged");
    expect(tile.className).not.toContain("pr-open");
    expect(tile.className.match(/workspace-canvas__tile--exited/g)).toHaveLength(1);
  });
});

describe("WorkspaceCanvas - fullscreen reconciliation", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.persist.clearStorage?.();
  });

  it("un-hides the remaining tile when the fullscreen tile is removed by an external store mutation", () => {
    const canvas: CanvasGeometry = {
      mode: "free",
      tiles: [
        { id: "tile-a", kind: "tools" },
        { id: "tile-b", kind: "agent", sessionId: "sess-b" },
      ],
      tree: null,
      freeRects: {
        "tile-a": { x: 0, y: 0, w: 40, h: 40 },
        "tile-b": { x: 50, y: 0, w: 40, h: 40 },
      },
    };
    useWorkspaceStore.setState({
      layoutByWorktree: { [W1]: { scratchCanvas: canvas } as never },
      workspaceDocs: {},
    });
    renderCanvas();

    // Click (not drag) tile-a's title bar to enter fullscreen — every OTHER
    // tile (tile-b) hides via `display:none` while a tile is fullscreen.
    const headers = screen.getAllByTitle("Click to fullscreen · drag to move");
    act(() => {
      headers[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 0, clientY: 0 }));
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    expect(screen.getByTitle("Click to exit fullscreen")).toBeInTheDocument();
    const tileB = screen.getByText("agent").closest(".workspace-canvas__tile") as HTMLElement;
    expect(tileB.style.display).toBe("none");

    // Externally remove the (fullscreen) tile-a via the store, as
    // toggleWorktreeToolsTile does from TopBar — WorkspaceCanvas has no
    // direct hook into this removal, only the reconciliation effect.
    act(() => {
      useWorkspaceStore.setState({
        layoutByWorktree: {
          [W1]: {
            scratchCanvas: {
              mode: "free",
              tiles: [{ id: "tile-b", kind: "agent", sessionId: "sess-b" }],
              tree: null,
              freeRects: { "tile-b": { x: 50, y: 0, w: 40, h: 40 } },
            },
          } as never,
        },
      });
    });

    // tile-b is no longer hidden — the dangling fullscreenTileId ("tile-a")
    // was reconciled away instead of permanently hiding every other tile.
    expect(screen.queryByTitle("Click to exit fullscreen")).not.toBeInTheDocument();
    const tileBAfter = screen.getByText("agent").closest(".workspace-canvas__tile") as HTMLElement;
    expect(tileBAfter.style.display).not.toBe("none");
  });
});
