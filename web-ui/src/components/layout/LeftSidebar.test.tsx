import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactNode } from "react";
import type { ApiInstance } from "@/api";
import { createMockApi } from "@/api/mock";
import { LeftSidebar } from "./LeftSidebar";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useServerStore } from "@/hooks/useServerStore";
import { useServerSync } from "@/hooks/useServerSync";

/** In production `useServerSync` is mounted by `Workspace`. Tests render
 *  LeftSidebar in isolation, so this harness wires the same hook above it so
 *  WS events emitted via `api.__test.emit` flow into the central store. */
function Harness({ api, children }: { api: ApiInstance; children: ReactNode }) {
  useServerSync(api);
  return <>{children}</>;
}

describe("LeftSidebar", () => {
  const api = createMockApi();

  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.persist.clearStorage?.();
    useWorkspaceStore.setState({
      activeProjectId: "proj-a",
      activeWorktreeId: "wt-1",
      activeSessionId: "sess-main",
      sessionStates: {},
      lastSessionByWorktree: {},
      diffScopeByWorktree: {},
    });
    // Reset central server store between tests. Harness (via useServerSync)
    // will refill it from the mock api on mount.
    useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
  });

  it("renders projects from mock api", async () => {
    render(
      <MemoryRouter>
        <Harness api={api}>
          <LeftSidebar api={api} />
        </Harness>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText("Proj A")).toBeInTheDocument();
    });
  });

  it("clicking project name toggles worktrees (expand control)", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Harness api={api}>
          <LeftSidebar api={api} />
        </Harness>
      </MemoryRouter>,
    );
    await screen.findByRole("link", { name: /Open worktree wt-1/i });
    await user.click(screen.getByText("Proj A"));
    expect(screen.queryByRole("link", { name: /Open worktree wt-1/i })).toBeNull();
    await user.click(screen.getByText("Proj A"));
    await screen.findByRole("link", { name: /Open worktree wt-1/i });
  });

  it("clicking worktree sets active worktree", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Harness api={api}>
          <LeftSidebar api={api} />
        </Harness>
      </MemoryRouter>,
    );
    await screen.findByRole("link", { name: /Open worktree wt-2/i });
    await user.click(screen.getByRole("link", { name: /Open worktree wt-2/i }));
    expect(useWorkspaceStore.getState().activeWorktreeId).toBe("wt-2");
  });

  it("ctrl/meta/middle-clicking a worktree does NOT change the active worktree (new-tab open)", async () => {
    render(
      <MemoryRouter>
        <Harness api={api}>
          <LeftSidebar api={api} />
        </Harness>
      </MemoryRouter>,
    );
    const link = await screen.findByRole("link", { name: /Open worktree wt-2/i });
    // Active worktree starts at wt-1 (set in beforeEach).
    expect(useWorkspaceStore.getState().activeWorktreeId).toBe("wt-1");

    // Each modified click should let the browser open a new tab without
    // mutating the current tab's active worktree.
    fireEvent.click(link, { ctrlKey: true });
    expect(useWorkspaceStore.getState().activeWorktreeId).toBe("wt-1");

    fireEvent.click(link, { metaKey: true });
    expect(useWorkspaceStore.getState().activeWorktreeId).toBe("wt-1");

    fireEvent.click(link, { button: 1 });
    expect(useWorkspaceStore.getState().activeWorktreeId).toBe("wt-1");
  });

  it("worktree row exposes overflow menu control", async () => {
    render(
      <MemoryRouter>
        <Harness api={api}>
          <LeftSidebar api={api} />
        </Harness>
      </MemoryRouter>,
    );
    await screen.findByRole("link", { name: /Open worktree wt-1/i });
    const menus = screen.getAllByRole("button", { name: /Worktree actions for/i });
    expect(menus[0]?.className).toContain("wt-menu-trigger");
  });

  it("collapsed rail shows abbreviated labels and hides worktree overflow menu", async () => {
    render(
      <MemoryRouter>
        <Harness api={api}>
          <LeftSidebar api={api} collapsed />
        </Harness>
      </MemoryRouter>,
    );
    await screen.findByText("Pra");
    await screen.findByText("Prb");
    await screen.findByText("wt1");
    await screen.findByText("wt2");
    expect(screen.queryAllByRole("button", { name: /Worktree actions for/i })).toHaveLength(0);
  });

  it("session:created with snapshot appends session and updates rolled-up status dot", async () => {
    render(
      <MemoryRouter>
        <Harness api={api}>
          <LeftSidebar api={api} />
        </Harness>
      </MemoryRouter>,
    );
    await screen.findByRole("link", { name: /Open worktree wt-1/i });
    api.__test.emit({
      type: "session:created",
      sessionId: "sess-extra",
      worktreeId: "wt-1",
      sessionType: "agent",
      mode: "mode-1",
      snapshot: {
        id: "sess-extra",
        worktreeId: "wt-1",
        modeId: "mode-1",
        type: "agent",
        label: "extra",
        slot: "a9",
        state: "not_started",
        lifecycleState: "not_started",
        tmuxName: "tm-x",
        createdAt: new Date().toISOString(),
      },
    });
    await waitFor(() => {
      expect(screen.getAllByLabelText(/status:/i).length).toBeGreaterThan(0);
    });
  });

  // ─── Pinning ───────────────────────────────────────────────────────────
  describe("worktree pinning", () => {
    it("does not render the pinned section when no worktrees are pinned", async () => {
      render(
        <MemoryRouter>
          <Harness api={api}>
            <LeftSidebar api={api} />
          </Harness>
        </MemoryRouter>,
      );
      await screen.findByText("Proj A");
      expect(screen.queryByRole("region", { name: /pinned worktrees/i })).toBeNull();
    });

    it("pin action in the ⋯ menu calls api.pinWorktree and the row appears in the pinned section", async () => {
      const localApi = createMockApi();
      // Ensure mock starts unpinned (each createMockApi has its own state).
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <Harness api={localApi}>
            <LeftSidebar api={localApi} />
          </Harness>
        </MemoryRouter>,
      );
      await screen.findByRole("link", { name: /Open worktree wt-1/i });

      // Open the menu for wt-1
      const wtRow = screen.getByRole("link", { name: /Open worktree wt-1/i }).closest(".tree-row")!;
      const trigger = wtRow.querySelector("[data-wt-menu-trigger]")! as HTMLElement;
      await user.click(trigger);

      const pinItem = await screen.findByRole("menuitem", { name: /pin to top/i });
      await user.click(pinItem);

      // The pinned section should appear; the mock api emits worktree:updated
      // synchronously so useServerSync will re-render in a microtask.
      await waitFor(() => {
        expect(screen.getByRole("region", { name: /pinned worktrees/i })).toBeInTheDocument();
      });
      // The pinned-row link is labelled differently to disambiguate.
      expect(screen.getByRole("link", { name: /Open pinned worktree wt-1/i })).toBeInTheDocument();
    });

    it("pinned section shows project name as subheader", async () => {
      const localApi = createMockApi();
      await localApi.pinWorktree("wt-1");
      render(
        <MemoryRouter>
          <Harness api={localApi}>
            <LeftSidebar api={localApi} />
          </Harness>
        </MemoryRouter>,
      );
      await screen.findByRole("region", { name: /pinned worktrees/i });
      // The mock seeds "Proj A" as the name for proj-a (the project that owns wt-1)
      const subheads = document.querySelectorAll(".pinned-row__subhead");
      expect(Array.from(subheads).some((s) => s.textContent === "Proj A")).toBe(true);
    });

    it("⋯ menu on a pinned row reads 'Unpin' and calls api.unpinWorktree", async () => {
      const localApi = createMockApi();
      await localApi.pinWorktree("wt-1");
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <Harness api={localApi}>
            <LeftSidebar api={localApi} />
          </Harness>
        </MemoryRouter>,
      );
      await screen.findByRole("region", { name: /pinned worktrees/i });

      const pinnedLink = screen.getByRole("link", { name: /Open pinned worktree wt-1/i });
      const pinnedRow = pinnedLink.closest(".pinned-row")! as HTMLElement;
      const trigger = pinnedRow.querySelector("[data-wt-menu-trigger]")! as HTMLElement;
      expect(trigger).toBeTruthy();
      await user.click(trigger);

      const unpinItem = await screen.findByRole("menuitem", { name: /^unpin$/i });
      await user.click(unpinItem);

      await waitFor(() => {
        expect(screen.queryByRole("region", { name: /pinned worktrees/i })).toBeNull();
      });
    });

    it("pinned-row ⋯ button carries data-wt-menu-trigger", async () => {
      const localApi = createMockApi();
      await localApi.pinWorktree("wt-2");
      render(
        <MemoryRouter>
          <Harness api={localApi}>
            <LeftSidebar api={localApi} />
          </Harness>
        </MemoryRouter>,
      );
      await screen.findByRole("region", { name: /pinned worktrees/i });
      const pinnedRow = screen
        .getByRole("link", { name: /Open pinned worktree wt-2/i })
        .closest(".pinned-row")! as HTMLElement;
      const trigger = pinnedRow.querySelector("[data-wt-menu-trigger]");
      expect(trigger).not.toBeNull();
    });

    it("pinned section is hidden when collapsed=true even with pinned worktrees", async () => {
      const localApi = createMockApi();
      await localApi.pinWorktree("wt-1");
      render(
        <MemoryRouter>
          <Harness api={localApi}>
            <LeftSidebar api={localApi} collapsed />
          </Harness>
        </MemoryRouter>,
      );
      await screen.findByText("Pra");
      expect(screen.queryByRole("region", { name: /pinned worktrees/i })).toBeNull();
    });

    it("pinned rows render in pinnedAt DESC order (newest first)", async () => {
      const localApi = createMockApi();
      await localApi.pinWorktree("wt-2"); // older
      await new Promise((r) => setTimeout(r, 5));
      await localApi.pinWorktree("wt-3"); // newer
      render(
        <MemoryRouter>
          <Harness api={localApi}>
            <LeftSidebar api={localApi} />
          </Harness>
        </MemoryRouter>,
      );
      await screen.findByRole("region", { name: /pinned worktrees/i });
      const region = screen.getByRole("region", { name: /pinned worktrees/i });
      const labels = Array.from(region.querySelectorAll(".pinned-row__primary")).map(
        (n) => n.textContent,
      );
      // wt-3 is "wt-main" in the mock; wt-2 is "wt-2"
      expect(labels[0]).toBe("wt-main");
      expect(labels[1]).toBe("wt-2");
    });

    it("worktree:updated event from another tab updates the pinned section", async () => {
      const localApi = createMockApi();
      render(
        <MemoryRouter>
          <Harness api={localApi}>
            <LeftSidebar api={localApi} />
          </Harness>
        </MemoryRouter>,
      );
      await screen.findByRole("link", { name: /Open worktree wt-1/i });
      expect(screen.queryByRole("region", { name: /pinned worktrees/i })).toBeNull();

      // Simulate another tab pinning wt-1
      localApi.__test.emit({
        type: "worktree:updated",
        worktree: {
          id: "wt-1",
          projectId: "proj-a",
          branch: "wt-1",
          baseBranch: "main",
          baseSha: "abc123",
          createdAt: new Date().toISOString(),
          pinnedAt: new Date().toISOString(),
        },
      });

      await waitFor(() => {
        expect(screen.getByRole("region", { name: /pinned worktrees/i })).toBeInTheDocument();
      });
    });
  });

  // ─── Project hiding ──────────────────────────────────────────────────────
  describe("project hiding", () => {
    it("project row exposes a project actions (⋮) menu with Hide project + New worktree", async () => {
      const user = userEvent.setup();
      const localApi = createMockApi();
      render(
        <MemoryRouter>
          <Harness api={localApi}>
            <LeftSidebar api={localApi} />
          </Harness>
        </MemoryRouter>,
      );
      await screen.findByText("Proj A");
      const trigger = screen.getAllByRole("button", { name: /Project actions for Proj A/i })[0]!;
      await user.click(trigger);
      expect(await screen.findByRole("menuitem", { name: /Hide project/i })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: /New worktree/i })).toBeInTheDocument();
    });

    it("clicking Hide project calls api.hideProject", async () => {
      const user = userEvent.setup();
      const localApi = createMockApi();
      const spy = vi.spyOn(localApi, "hideProject");
      render(
        <MemoryRouter>
          <Harness api={localApi}>
            <LeftSidebar api={localApi} />
          </Harness>
        </MemoryRouter>,
      );
      await screen.findByText("Proj A");
      await user.click(screen.getAllByRole("button", { name: /Project actions for Proj A/i })[0]!);
      await user.click(await screen.findByRole("menuitem", { name: /Hide project/i }));
      expect(spy).toHaveBeenCalledWith("proj-a");
    });

    it("a hidden project (and its worktrees) is filtered out of the sidebar", async () => {
      const localApi = createMockApi();
      render(
        <MemoryRouter>
          <Harness api={localApi}>
            <LeftSidebar api={localApi} />
          </Harness>
        </MemoryRouter>,
      );
      await screen.findByText("Proj A");
      // Another tab hides proj-a.
      localApi.__test.emit({
        type: "project:updated",
        project: {
          id: "proj-a",
          name: "Proj A",
          path: "/home/dev/proj-a",
          prefix: "pa",
          defaultBranch: "main",
          createdAt: new Date().toISOString(),
          hidden: true,
        },
      });
      await waitFor(() => {
        expect(screen.queryByText("Proj A")).toBeNull();
      });
      // Worktrees of the hidden project are gone too.
      expect(screen.queryByRole("link", { name: /Open worktree wt-1/i })).toBeNull();
      // A different (visible) project remains.
      expect(screen.getByText("Proj B")).toBeInTheDocument();
    });
  });

  // ─── Scroll-to-selected on reopen ────────────────────────────────────────
  describe("scroll-to-selected worktree", () => {
    beforeEach(() => {
      // jsdom doesn't implement scrollIntoView — provide a spy so the guarded
      // call runs and we can assert on it.
      Element.prototype.scrollIntoView = vi.fn();
    });

    it("snaps the active worktree into view when the sidebar transitions hidden→visible", async () => {
      const localApi = createMockApi();
      const { rerender } = render(
        <MemoryRouter initialEntries={["/worktree/wt-1"]}>
          <Harness api={localApi}>
            <LeftSidebar api={localApi} collapsed />
          </Harness>
        </MemoryRouter>,
      );
      await screen.findByText("Pra"); // collapsed (not visible) — abbreviated label
      (Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mockClear();

      // Reopen: collapsed → expanded (rising edge).
      rerender(
        <MemoryRouter initialEntries={["/worktree/wt-1"]}>
          <Harness api={localApi}>
            <LeftSidebar api={localApi} />
          </Harness>
        </MemoryRouter>,
      );
      await waitFor(() => {
        expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
      });
    });

    it("does not scroll when there is no active worktree", async () => {
      useWorkspaceStore.setState({ activeWorktreeId: null, activeProjectId: null });
      const localApi = createMockApi();
      const { rerender } = render(
        <MemoryRouter initialEntries={["/"]}>
          <Harness api={localApi}>
            <LeftSidebar api={localApi} collapsed />
          </Harness>
        </MemoryRouter>,
      );
      await screen.findByText("Pra");
      (Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mockClear();
      rerender(
        <MemoryRouter initialEntries={["/"]}>
          <Harness api={localApi}>
            <LeftSidebar api={localApi} />
          </Harness>
        </MemoryRouter>,
      );
      await screen.findByText("Proj A");
      // Give the double-rAF a chance to (not) fire.
      await new Promise((r) => setTimeout(r, 30));
      expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    });
  });

  it("Settings is a link with accessible name", async () => {
    render(
      <MemoryRouter>
        <Harness api={api}>
          <LeftSidebar api={api} />
        </Harness>
      </MemoryRouter>,
    );
    await screen.findByText("Proj A");
    const settings = screen.getByRole("link", { name: /^Settings$/i });
    expect(settings).toBeInTheDocument();
    expect(settings).toHaveAttribute("href", "/settings");
  });
});
