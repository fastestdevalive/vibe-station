import { createElement } from "react";
import { render, screen, waitFor, fireEvent, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactNode } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import type { ApiInstance } from "@/api";
import { createMockApi } from "@/api/mock";
import { LeftSidebar } from "./LeftSidebar";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useServerStore } from "@/hooks/useServerStore";
import { useServerSync } from "@/hooks/useServerSync";

/**
 * Capture the LAST `DndContext`'s `onDragStart`/`onDragEnd` LeftSidebar hands
 * to dnd-kit (same non-stubbing approach as TabsStrip.test.tsx — the real
 * component still renders). With no pinned worktrees/sessions and no direct
 * sessions in the `proj-a` fixture, the worktree list under `proj-a` is the
 * only `DndContext` rendered, so "last" is unambiguous here.
 */
let capturedOnDragStart: (() => void) | null = null;
let capturedOnDragEnd: ((e: DragEndEvent) => void) | null = null;
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: Parameters<typeof actual.DndContext>[0]) => {
      capturedOnDragStart = (props.onDragStart as (() => void) | undefined) ?? null;
      capturedOnDragEnd = props.onDragEnd ?? null;
      return createElement(actual.DndContext, props);
    },
  };
});

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
    capturedOnDragStart = null;
    capturedOnDragEnd = null;
    localStorage.clear();
    useWorkspaceStore.persist.clearStorage?.();
    useWorkspaceStore.setState({
      activeProjectId: "proj-a",
      activeWorktreeId: "wt-1",
      activeSessionId: "sess-main",
      sessionStates: {},
      lastSessionByWorktree: {},
      diffScopeByWorktree: {},
      // Keep all worktrees visible by default; these tests assert on worktree
      // rows regardless of the "hide done" product default (now true).
      hideInactiveWorktrees: false,
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

  // Regression: dragging a non-active worktree to reorder it ALSO selected it.
  //
  // The sortable rows are React Router <Link>s, i.e. real <a href> elements.
  // When a drag ends with the pointer still inside the dragged row's bounds,
  // the browser dispatches a trailing `click` on that anchor — and dnd-kit's
  // PointerSensor kills it only with `stopPropagation()` at DOCUMENT capture.
  // That stops React (and therefore any row onClick guard) from ever seeing
  // it, but leaves the anchor's DEFAULT ACTION intact, so the browser
  // navigated to the dragged row's URL. Reproducing that requires replaying
  // dnd-kit's suppressor too — a bare `fireEvent.click` would let the click
  // reach React and be handled there, which is exactly the blind spot the
  // previous fix had.
  it("dragging a non-active worktree to reorder it does not also select it", async () => {
    render(
      <MemoryRouter>
        <Harness api={api}>
          <LeftSidebar api={api} />
        </Harness>
      </MemoryRouter>,
    );
    const link = await screen.findByRole("link", { name: /Open worktree wt-2/i });
    // Active worktree starts at wt-1 (set in beforeEach); wt-2 is the one we drag.
    expect(useWorkspaceStore.getState().activeWorktreeId).toBe("wt-1");
    expect(capturedOnDragStart).toBeTypeOf("function");
    expect(capturedOnDragEnd).toBeTypeOf("function");

    // Stand-in for dnd-kit's PointerSensor click suppression.
    const dndSuppressor = (e: Event) => e.stopPropagation();
    document.addEventListener("click", dndSuppressor, true);
    try {
      act(() => {
        capturedOnDragStart!();
        capturedOnDragEnd!({
          active: { id: "wt-2" },
          over: { id: "wt-1" },
        } as unknown as DragEndEvent);
      });
      const trailingClick = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
      });
      link.dispatchEvent(trailingClick);

      // The anchor's default navigation — the thing that actually selected the
      // dragged worktree — must be cancelled.
      expect(trailingClick.defaultPrevented).toBe(true);
    } finally {
      document.removeEventListener("click", dndSuppressor, true);
    }

    expect(useWorkspaceStore.getState().activeWorktreeId).toBe("wt-1");
  });

  // Regression: the previous fix used a "drag occurred" boolean consumed by the
  // row's onClick. Because that onClick never runs (see above), the flag was
  // never reset and swallowed the NEXT genuine click on any row.
  it("a click after a drag whose trailing click never arrived still selects", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      render(
        <MemoryRouter>
          <Harness api={api}>
            <LeftSidebar api={api} />
          </Harness>
        </MemoryRouter>,
      );
      const link = await screen.findByRole("link", { name: /Open worktree wt-2/i });
      act(() => {
        capturedOnDragStart!();
        capturedOnDragEnd!({
          active: { id: "wt-2" },
          over: { id: "wt-2" },
        } as unknown as DragEndEvent);
      });
      // No trailing click reaches the app (dnd-kit ate it / the pointer landed
      // on a neighbour). Later the user deliberately clicks a row.
      now += 2_000;
      fireEvent.click(link);

      expect(useWorkspaceStore.getState().activeWorktreeId).toBe("wt-2");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("a plain click (no preceding drag) still selects the worktree", async () => {
    render(
      <MemoryRouter>
        <Harness api={api}>
          <LeftSidebar api={api} />
        </Harness>
      </MemoryRouter>,
    );
    const link = await screen.findByRole("link", { name: /Open worktree wt-2/i });
    fireEvent.click(link);
    expect(useWorkspaceStore.getState().activeWorktreeId).toBe("wt-2");
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
      projectId: "proj-1",
      sessionType: "agent",
      mode: "mode-1",
      snapshot: {
        id: "sess-extra",
        worktreeId: "wt-1",
      projectId: "proj-1",
        modeId: "mode-1",
        type: "agent",
        name: "extra",
        isMain: false,
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
      expect(screen.queryByRole("region", { name: /^pinned$/i })).toBeNull();
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
        expect(screen.getByRole("region", { name: /^pinned$/i })).toBeInTheDocument();
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
      await screen.findByRole("region", { name: /^pinned$/i });
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
      await screen.findByRole("region", { name: /^pinned$/i });

      const pinnedLink = screen.getByRole("link", { name: /Open pinned worktree wt-1/i });
      const pinnedRow = pinnedLink.closest(".pinned-row")! as HTMLElement;
      const trigger = pinnedRow.querySelector("[data-wt-menu-trigger]")! as HTMLElement;
      expect(trigger).toBeTruthy();
      await user.click(trigger);

      const unpinItem = await screen.findByRole("menuitem", { name: /^unpin$/i });
      await user.click(unpinItem);

      await waitFor(() => {
        expect(screen.queryByRole("region", { name: /^pinned$/i })).toBeNull();
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
      await screen.findByRole("region", { name: /^pinned$/i });
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
      expect(screen.queryByRole("region", { name: /^pinned$/i })).toBeNull();
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
      await screen.findByRole("region", { name: /^pinned$/i });
      const region = screen.getByRole("region", { name: /^pinned$/i });
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
      expect(screen.queryByRole("region", { name: /^pinned$/i })).toBeNull();

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
        expect(screen.getByRole("region", { name: /^pinned$/i })).toBeInTheDocument();
      });
    });

    it("pinned direct sessions and pinned worktrees are combined and sorted by pinnedAt DESC", async () => {
      const localApi = createMockApi();
      await localApi.pinWorktree("wt-2");
      const sess = await localApi.createDirectSession({
        target: "direct",
        projectId: "proj-a",
        type: "agent",
        name: "direct-agent-1",
      });
      await localApi.pinSession(sess.id, true);
      render(
        <MemoryRouter>
          <Harness api={localApi}>
            <LeftSidebar api={localApi} />
          </Harness>
        </MemoryRouter>,
      );
      await screen.findByRole("region", { name: /^pinned$/i });
      const now = Date.now();
      act(() => {
        localApi.__test.emit({
          type: "session:updated",
          sessionId: sess.id,
          pinnedAt: new Date(now + 10000).toISOString(),
        });
        localApi.__test.emit({
          type: "worktree:updated",
          worktree: {
            id: "wt-2",
            projectId: "proj-a",
            branch: "wt-2",
            baseBranch: "main",
            baseSha: "def456",
            createdAt: new Date().toISOString(),
            pinnedAt: new Date(now - 10000).toISOString(),
          },
        });
      });
      const region = screen.getByRole("region", { name: /^pinned$/i });
      await waitFor(() => {
        const labels = Array.from(region.querySelectorAll(".pinned-row__primary")).map(
          (n) => n.textContent,
        );
        expect(labels).toEqual(["direct-agent-1", "wt-2"]);
      });
    });
  });

  // ─── Project hiding ──────────────────────────────────────────────────────
  describe("project hiding", () => {
    it("project row exposes a project actions (⋮) menu with Hide project (New worktree moved to the + menu)", async () => {
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
      // "New worktree" was intentionally removed from the ⋮ menu — it lives in
      // the project + (plus) menu instead.
      expect(screen.queryByRole("menuitem", { name: /New worktree/i })).not.toBeInTheDocument();
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
          isGit: true,
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

  // ─── Direct sessions ───────────────────────────────────────────────────
  describe("direct sessions", () => {
    /**
     * The terminal dock auto-creates a shell for the project scope, which the
     * daemon stores in project.directSessions alongside direct agents. The
     * sidebar lists agents only, so that shell must not surface as a row —
     * it previously did, appearing as a bogus top-level "Terminal 1".
     */
    function emitDirect(sessionId: string, type: "agent" | "terminal", label: string) {
      api.__test.emit({
        type: "session:created",
        sessionId,
        worktreeId: null,
        projectId: "proj-a",
        sessionType: type,
        snapshot: {
          id: sessionId,
          worktreeId: null,
          projectId: "proj-a",
          modeId: type === "agent" ? "mode-1" : null,
          type,
          name: label,
          isMain: false,
          state: "idle",
          lifecycleState: "idle",
          tmuxName: `tm-${sessionId}`,
          createdAt: new Date().toISOString(),
        },
      });
    }

    it("lists direct agent sessions but never direct terminals", async () => {
      render(
        <MemoryRouter>
          <Harness api={api}>
            <LeftSidebar api={api} />
          </Harness>
        </MemoryRouter>,
      );
      await screen.findByText("Proj A");

      emitDirect("proj-a-d1", "agent", "direct 1");
      emitDirect("proj-a-d2", "terminal", "Terminal 1");

      // The agent row shows up...
      await screen.findByRole("link", { name: /Open direct session direct 1/i });
      // ...and the auto-created terminal never does.
      expect(
        screen.queryByRole("link", { name: /Open direct session Terminal 1/i }),
      ).toBeNull();
      expect(screen.queryByText("Terminal 1")).toBeNull();
    });

    it("3.3 — an archived direct session row is visually dimmed with an 'archived' badge", async () => {
      render(
        <MemoryRouter>
          <Harness api={api}>
            <LeftSidebar api={api} />
          </Harness>
        </MemoryRouter>,
      );
      await screen.findByText("Proj A");

      api.__test.emit({
        type: "session:created",
        sessionId: "proj-a-d3",
        worktreeId: null,
        projectId: "proj-a",
        sessionType: "agent",
        snapshot: {
          id: "proj-a-d3",
          worktreeId: null,
          projectId: "proj-a",
          modeId: "mode-1",
          type: "agent",
          name: "old direct",
          isMain: false,
          state: "idle",
          lifecycleState: "idle",
          tmuxName: "tm-proj-a-d3",
          createdAt: new Date().toISOString(),
          archivedAt: new Date().toISOString(),
        },
      });

      const link = await screen.findByRole("link", { name: /Open direct session old direct/i });
      const row = link.closest(".tree-row")! as HTMLElement;
      expect(row).toHaveAttribute("data-archived", "true");
      expect(within(row).getByText(/archived/i)).toBeInTheDocument();
    });

    it("A2.T4 — a failed terminate surfaces the daemon's error instead of failing silently", async () => {
      // NOTE: LeftSidebar's session-actions menu only ever operates on
      // DIRECT sessions (filtered via `worktreeId === null`, LeftSidebar.tsx
      // :213) — a direct session can never be `isMain` (daemon CHECK
      // constraint), so the specific "worktree's only session" 400 that Fix 1
      // introduces cannot be reproduced through THIS file's UI. This test
      // instead verifies the actual code change generically: any
      // `terminateSession` failure now surfaces to the user via `window.alert`
      // rather than the previous bare `catch { /* surface errors later */ }`.
      const user = userEvent.setup();
      const localApi = createMockApi();
      const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
      vi.spyOn(localApi, "terminateSession").mockRejectedValue(
        new Error("Cannot delete the main session: no other agent session exists in this worktree to promote to main."),
      );
      try {
        render(
          <MemoryRouter>
            <Harness api={localApi}>
              <LeftSidebar api={localApi} />
            </Harness>
          </MemoryRouter>,
        );
        await screen.findByText("Proj A");
        localApi.__test.emit({
          type: "session:created",
          sessionId: "proj-a-d4",
          worktreeId: null,
          projectId: "proj-a",
          sessionType: "agent",
          snapshot: {
            id: "proj-a-d4",
            worktreeId: null,
            projectId: "proj-a",
            modeId: "mode-1",
            type: "agent",
            name: "sole direct agent",
            isMain: false,
            state: "idle",
            lifecycleState: "idle",
            tmuxName: "tm-proj-a-d4",
            createdAt: new Date().toISOString(),
          },
        });

        const trigger = await screen.findByRole("button", { name: /Session actions for sole direct agent/i });
        await user.click(trigger);
        await user.click(await screen.findByRole("menuitem", { name: /^Terminate$/i }));
        await user.click(await screen.findByRole("button", { name: /^Terminate$/i }));

        await waitFor(() => {
          expect(alertSpy).toHaveBeenCalledWith(
            expect.stringContaining("no other agent session exists in this worktree"),
          );
        });
      } finally {
        alertSpy.mockRestore();
      }
    });
  });

  // ─── Inline rename (Part 03 Phase 3 — double-click, no modal fallback) ──
  // The modal `RenameDialog` is removed entirely (Decision 8); the sidebar
  // now mirrors TabsStrip.tsx's inline double-click rename exactly.
  describe("inline rename", () => {
    // The mock api's `pinSession` mutates its backing store but — unlike
    // `pinWorktree`/`renameSession` — does not emit a `session:updated` WS
    // event, so the client-side store never learns about the change. Pin via
    // the api call (so its own state stays consistent) then emit the event
    // by hand, mirroring what a real server round-trip would deliver.
    async function pinSessionAndSync(
      targetApi: ReturnType<typeof createMockApi>,
      sessionId: string,
    ) {
      await targetApi.pinSession(sessionId, true);
      targetApi.__test.emit({ type: "session:updated", sessionId, pinnedAt: new Date(0).toISOString() });
    }

    function emitDirectAgent(targetApi: ReturnType<typeof createMockApi>, sessionId: string, label: string) {
      targetApi.__test.emit({
        type: "session:created",
        sessionId,
        worktreeId: null,
        projectId: "proj-a",
        sessionType: "agent",
        snapshot: {
          id: sessionId,
          worktreeId: null,
          projectId: "proj-a",
          modeId: "mode-1",
          type: "agent",
          name: label,
          isMain: false,
          state: "idle",
          lifecycleState: "idle",
          tmuxName: `tm-${sessionId}`,
          createdAt: new Date().toISOString(),
        },
      });
    }

    it("3.T1 — double-clicking a worktree row reveals a prefilled input; Enter calls renameWorktree", async () => {
      const localApi = createMockApi();
      const renameSpy = vi.spyOn(localApi, "renameWorktree");
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <Harness api={localApi}>
            <LeftSidebar api={localApi} />
          </Harness>
        </MemoryRouter>,
      );
      const link = await screen.findByRole("link", { name: /Open worktree wt-1/i });
      const row = link.closest(".tree-row")! as HTMLElement;
      fireEvent.doubleClick(row);

      const input = await screen.findByLabelText("Rename");
      expect(input).toHaveValue("wt-1");
      await user.clear(input);
      await user.type(input, "renamed-wt{Enter}");

      await waitFor(() => {
        expect(renameSpy).toHaveBeenCalledWith("wt-1", "renamed-wt");
      });
      // Store reconciles via the `worktree:updated` WS event the mock emits.
      await waitFor(() => {
        expect(screen.getByRole("link", { name: /Open worktree renamed-wt/i })).toBeInTheDocument();
      });
    });

    it("3.T2 — double-clicking a direct-session row and pressing Enter calls renameSession", async () => {
      const localApi = createMockApi();
      const renameSpy = vi.spyOn(localApi, "renameSession");
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <Harness api={localApi}>
            <LeftSidebar api={localApi} />
          </Harness>
        </MemoryRouter>,
      );
      await screen.findByText("Proj A");
      emitDirectAgent(localApi, "proj-a-rename", "direct rename");

      const link = await screen.findByRole("link", { name: /Open direct session direct rename/i });
      const row = link.closest(".tree-row")! as HTMLElement;
      fireEvent.doubleClick(row);

      const input = await screen.findByLabelText("Rename");
      expect(input).toHaveValue("direct rename");
      await user.clear(input);
      await user.type(input, "renamed-session{Enter}");

      await waitFor(() => {
        expect(renameSpy).toHaveBeenCalledWith("proj-a-rename", "renamed-session");
      });
    });

    it("3.T3 — Escape during inline edit restores the label and calls no rename endpoint", async () => {
      const localApi = createMockApi();
      const renameWorktreeSpy = vi.spyOn(localApi, "renameWorktree");
      const renameSessionSpy = vi.spyOn(localApi, "renameSession");
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <Harness api={localApi}>
            <LeftSidebar api={localApi} />
          </Harness>
        </MemoryRouter>,
      );
      const link = await screen.findByRole("link", { name: /Open worktree wt-1/i });
      const row = link.closest(".tree-row")! as HTMLElement;
      fireEvent.doubleClick(row);

      const input = await screen.findByLabelText("Rename");
      await user.clear(input);
      await user.type(input, "should-not-save");
      await user.keyboard("{Escape}");

      expect(screen.queryByLabelText("Rename")).toBeNull();
      expect(screen.getByRole("link", { name: /Open worktree wt-1/i })).toBeInTheDocument();
      expect(renameWorktreeSpy).not.toHaveBeenCalled();
      expect(renameSessionSpy).not.toHaveBeenCalled();
    });

    it("3.T4 — blurring the inline input commits (calls renameWorktree once)", async () => {
      const localApi = createMockApi();
      const renameSpy = vi.spyOn(localApi, "renameWorktree");
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <Harness api={localApi}>
            <LeftSidebar api={localApi} />
          </Harness>
        </MemoryRouter>,
      );
      const link = await screen.findByRole("link", { name: /Open worktree wt-1/i });
      const row = link.closest(".tree-row")! as HTMLElement;
      fireEvent.doubleClick(row);

      const input = await screen.findByLabelText("Rename");
      await user.clear(input);
      await user.type(input, "blur-renamed");
      fireEvent.blur(input);

      await waitFor(() => {
        expect(renameSpy).toHaveBeenCalledTimes(1);
        expect(renameSpy).toHaveBeenCalledWith("wt-1", "blur-renamed");
      });
    });

    // Regression: the tree/pinned worktree row is `role="button"` with its
    // own `onKeyDown` that calls `e.preventDefault()` on Enter/Space to
    // trigger `selectWorktree`. The rename `<input>` is a DOM descendant of
    // that row, so without `e.stopPropagation()` on the input's own
    // `onKeyDown`, every keystroke bubbles up to the row handler too: Space
    // keystrokes get swallowed (preventDefault on a native `<input>`'s
    // keydown blocks the character insertion) and Enter both commits the
    // rename AND fires the row's own "select this worktree" side effect.
    it("3.T6 — typing spaces into the TREE worktree rename input does not swallow them, and committing via Enter on a non-active worktree does not also select it", async () => {
      const localApi = createMockApi();
      const renameSpy = vi.spyOn(localApi, "renameWorktree");
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <Harness api={localApi}>
            <LeftSidebar api={localApi} />
          </Harness>
        </MemoryRouter>,
      );
      // wt-1 is the active worktree per the `beforeEach` store seed; wt-2 is
      // NOT active, so an errant "select" side effect is observable.
      expect(useWorkspaceStore.getState().activeWorktreeId).toBe("wt-1");
      const link = await screen.findByRole("link", { name: /Open worktree wt-2/i });
      const row = link.closest(".tree-row")! as HTMLElement;
      fireEvent.doubleClick(row);

      const input = await screen.findByLabelText("Rename");
      await user.clear(input);
      await user.type(input, "my new name{Enter}");

      await waitFor(() => {
        expect(renameSpy).toHaveBeenCalledWith("wt-2", "my new name");
      });
      // The row's own Enter/Space handler must NOT also have fired
      // `selectWorktree` as a side effect of the rename commit.
      expect(useWorkspaceStore.getState().activeWorktreeId).toBe("wt-1");
    });

    it("3.T7 — typing spaces into the PINNED worktree rename input does not swallow them", async () => {
      const localApi = createMockApi();
      await localApi.pinWorktree("wt-2");
      const renameSpy = vi.spyOn(localApi, "renameWorktree");
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <Harness api={localApi}>
            <LeftSidebar api={localApi} />
          </Harness>
        </MemoryRouter>,
      );
      const link = await screen.findByRole("link", { name: /Open pinned worktree wt-2/i });
      const row = link.closest(".tree-row")! as HTMLElement;
      fireEvent.doubleClick(row);

      const input = await screen.findByLabelText("Rename");
      await user.clear(input);
      await user.type(input, "my other name{Enter}");

      await waitFor(() => {
        expect(renameSpy).toHaveBeenCalledWith("wt-2", "my other name");
      });
    });

    it("3.T5 — collapsed rail: double-clicking a worktree row renders no input", async () => {
      render(
        <MemoryRouter>
          <Harness api={api}>
            <LeftSidebar api={api} collapsed />
          </Harness>
        </MemoryRouter>,
      );
      await screen.findByText("wt1");
      const row = screen.getByText("wt1").closest(".tree-row")! as HTMLElement;
      fireEvent.doubleClick(row);
      expect(screen.queryByLabelText("Rename")).toBeNull();
    });

    it("does not render a 'Rename' item in the worktree or session ⋯ menus", async () => {
      const localApi = createMockApi();
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <Harness api={localApi}>
            <LeftSidebar api={localApi} />
          </Harness>
        </MemoryRouter>,
      );
      const wtRow = (await screen.findByRole("link", { name: /Open worktree wt-1/i })).closest(".tree-row")!;
      const wtTrigger = wtRow.querySelector("[data-wt-menu-trigger]")! as HTMLElement;
      await user.click(wtTrigger);
      expect(await screen.findByRole("menuitem", { name: /pin to top/i })).toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: /^rename$/i })).toBeNull();

      // Close the worktree menu, then check the session ⋯ menu too — the
      // modal RenameDialog was the only consumer of a "Rename" menuitem on
      // EITHER menu, so both need the same regression coverage.
      await user.click(wtTrigger);
      await waitFor(() => expect(screen.queryByRole("menuitem", { name: /pin to top/i })).toBeNull());

      await screen.findByText("Proj A");
      emitDirectAgent(localApi, "proj-a-menu-check", "menu check session");
      const sessRow = (
        await screen.findByRole("link", { name: /Open direct session menu check session/i })
      ).closest(".tree-row")!;
      const sessTrigger = sessRow.querySelector("[data-sess-menu-trigger]")! as HTMLElement;
      await user.click(sessTrigger);
      expect(await screen.findByRole("menuitem", { name: /pin to top/i })).toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: /^rename$/i })).toBeNull();
    });

    // ─── Finding 1 regression (pinned rows are MIRRORED, not moved) ────────
    // Pinned worktrees/direct-sessions render simultaneously in the "Pinned"
    // section AND the regular project tree. Keying the inline-rename state
    // only by {kind, id} made double-clicking either copy flip BOTH into
    // edit mode — the second mount's autoFocus stole focus from the first,
    // firing its onBlur and committing a rename with the UNEDITED value.
    it("double-clicking a PINNED worktree row opens only the pinned input, not the mirrored tree-row copy", async () => {
      const localApi = createMockApi();
      const renameSpy = vi.spyOn(localApi, "renameWorktree");
      await localApi.pinWorktree("wt-1");
      render(
        <MemoryRouter>
          <Harness api={localApi}>
            <LeftSidebar api={localApi} />
          </Harness>
        </MemoryRouter>,
      );
      await screen.findByRole("region", { name: /^pinned$/i });

      const pinnedLink = screen.getByRole("link", { name: /Open pinned worktree wt-1/i });
      const pinnedRow = pinnedLink.closest(".tree-row")! as HTMLElement;
      const treeLink = screen.getByRole("link", { name: /^Open worktree wt-1$/i });
      const treeRow = treeLink.closest(".tree-row")! as HTMLElement;

      fireEvent.doubleClick(pinnedRow);

      // Exactly one input renders — inside the pinned row, not the tree row.
      const inputs = screen.getAllByLabelText("Rename");
      expect(inputs).toHaveLength(1);
      expect(pinnedRow.contains(inputs[0]!)).toBe(true);
      expect(treeRow.contains(inputs[0]!)).toBe(false);
      expect(within(treeRow).queryByLabelText("Rename")).toBeNull();

      // The mirrored copy never mounted a second autoFocus input, so no
      // focus-fight blur ever commits an unedited rename.
      expect(renameSpy).not.toHaveBeenCalled();
    });

    it("double-clicking a PINNED direct-session row opens only the pinned input, not the mirrored tree-row copy", async () => {
      const localApi = createMockApi();
      const renameSpy = vi.spyOn(localApi, "renameSession");
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <Harness api={localApi}>
            <LeftSidebar api={localApi} />
          </Harness>
        </MemoryRouter>,
      );
      await screen.findByText("Proj A");
      // Use the mock api's own createDirectSession (registers the session in
      // its backing store) rather than the raw `emitDirectAgent` WS-event
      // helper, so the subsequent `pinSession` call can find it.
      const sess = await localApi.createDirectSession({
        target: "direct",
        projectId: "proj-a",
        type: "agent",
        name: "pin mirror session",
      });
      await pinSessionAndSync(localApi, sess.id);

      await screen.findByRole("region", { name: /^pinned$/i });
      const pinnedLink = await screen.findByRole("link", {
        name: /Open pinned direct session pin mirror session/i,
      });
      const pinnedRow = pinnedLink.closest(".tree-row")! as HTMLElement;
      const treeLink = screen.getByRole("link", { name: /^Open direct session pin mirror session$/i });
      const treeRow = treeLink.closest(".tree-row")! as HTMLElement;

      fireEvent.doubleClick(pinnedRow);

      const inputs = screen.getAllByLabelText("Rename");
      expect(inputs).toHaveLength(1);
      expect(pinnedRow.contains(inputs[0]!)).toBe(true);
      expect(within(treeRow).queryByLabelText("Rename")).toBeNull();

      await user.type(inputs[0]!, "-renamed{Enter}");
      await waitFor(() => {
        expect(renameSpy).toHaveBeenCalledWith(sess.id, "pin mirror session-renamed");
      });
    });

    it("double-clicking the TREE copy of a pinned worktree opens only the tree input, not the pinned copy", async () => {
      const localApi = createMockApi();
      const renameSpy = vi.spyOn(localApi, "renameWorktree");
      await localApi.pinWorktree("wt-1");
      render(
        <MemoryRouter>
          <Harness api={localApi}>
            <LeftSidebar api={localApi} />
          </Harness>
        </MemoryRouter>,
      );
      await screen.findByRole("region", { name: /^pinned$/i });

      const pinnedLink = screen.getByRole("link", { name: /Open pinned worktree wt-1/i });
      const pinnedRow = pinnedLink.closest(".tree-row")! as HTMLElement;
      const treeLink = screen.getByRole("link", { name: /^Open worktree wt-1$/i });
      const treeRow = treeLink.closest(".tree-row")! as HTMLElement;

      fireEvent.doubleClick(treeRow);

      const inputs = screen.getAllByLabelText("Rename");
      expect(inputs).toHaveLength(1);
      expect(treeRow.contains(inputs[0]!)).toBe(true);
      expect(within(pinnedRow).queryByLabelText("Rename")).toBeNull();
      expect(renameSpy).not.toHaveBeenCalled();
    });

    // ─── Finding 2 regression — the rename input must carry a dedicated
    // `*__rename-input` class that CSS raises above the full-bleed
    // `.wt-row__stretch-link` anchor (z-index 1), so a click to place the
    // caret lands in the input, not on the anchor. jsdom in this suite does
    // not evaluate the external stylesheet's cascade (LeftSidebar.tsx never
    // imports `workspace.css` itself — see `vitest.config.ts`, no `css: true`),
    // so this asserts the structural half (the class is actually applied to
    // every render site) — the CSS half (`position: relative; z-index: 2` on
    // `.wt-row__rename-input`/`.pinned-row__rename-input`/
    // `.direct-session__rename-input` in `src/styles/workspace.css`) is
    // reviewed alongside this fix and matches `.wt-row__trail`'s own z-index-2
    // treatment for the same anchor-overlay problem.
    it("the inline rename input carries a *__rename-input class at every render site", async () => {
      const localApi = createMockApi();
      await localApi.pinWorktree("wt-1");
      const sess = await localApi.createDirectSession({
        target: "direct",
        projectId: "proj-a",
        type: "agent",
        name: "class check session",
      });
      await pinSessionAndSync(localApi, sess.id);
      render(
        <MemoryRouter>
          <Harness api={localApi}>
            <LeftSidebar api={localApi} />
          </Harness>
        </MemoryRouter>,
      );

      // Tree worktree row
      const treeWtLink = await screen.findByRole("link", { name: /^Open worktree wt-1$/i });
      const treeWtRow = treeWtLink.closest(".tree-row")! as HTMLElement;
      fireEvent.doubleClick(treeWtRow);
      expect((await screen.findByLabelText("Rename")).className).toContain("wt-row__rename-input");
      fireEvent.keyDown(screen.getByLabelText("Rename"), { key: "Escape" });

      // Pinned worktree row
      const pinnedWtLink = screen.getByRole("link", { name: /Open pinned worktree wt-1/i });
      const pinnedWtRow = pinnedWtLink.closest(".tree-row")! as HTMLElement;
      fireEvent.doubleClick(pinnedWtRow);
      expect((await screen.findByLabelText("Rename")).className).toContain("pinned-row__rename-input");
      fireEvent.keyDown(screen.getByLabelText("Rename"), { key: "Escape" });

      // Tree direct-session row
      const treeSessLink = screen.getByRole("link", { name: /^Open direct session class check session$/i });
      const treeSessRow = treeSessLink.closest(".tree-row")! as HTMLElement;
      fireEvent.doubleClick(treeSessRow);
      expect((await screen.findByLabelText("Rename")).className).toContain("direct-session__rename-input");
      fireEvent.keyDown(screen.getByLabelText("Rename"), { key: "Escape" });

      // Pinned direct-session row
      const pinnedSessLink = await screen.findByRole("link", {
        name: /Open pinned direct session class check session/i,
      });
      const pinnedSessRow = pinnedSessLink.closest(".tree-row")! as HTMLElement;
      fireEvent.doubleClick(pinnedSessRow);
      expect((await screen.findByLabelText("Rename")).className).toContain("pinned-row__rename-input");
    });

    // ─── Finding 4 regression — a double-click's SECOND click (event.detail
    // === 2) must not navigate the row's <Link>, since preventDefault() in
    // an onDoubleClick handler fires too late (click already dispatched). ──
    it("the second click of a double-click does not trigger the row's navigation onClick", async () => {
      const localApi = createMockApi();
      const user = userEvent.setup();
      // isMobile: true — this is the concretely-bad case from Finding 4: the
      // pinned direct-session Link's onClick calls setMobileSidebarOpen(false)
      // only when isMobile, so the regression only reproduces under this prop.
      render(
        <MemoryRouter>
          <Harness api={localApi}>
            <LeftSidebar api={localApi} isMobile />
          </Harness>
        </MemoryRouter>,
      );
      await screen.findByText("Proj A");
      const sess = await localApi.createDirectSession({
        target: "direct",
        projectId: "proj-a",
        type: "agent",
        name: "detail check session",
      });
      await pinSessionAndSync(localApi, sess.id);
      await screen.findByRole("region", { name: /^pinned$/i });

      const setMobileSidebarOpen = useWorkspaceStore.getState().setMobileSidebarOpen;
      const spy = vi.fn(setMobileSidebarOpen);
      act(() => {
        useWorkspaceStore.setState({ setMobileSidebarOpen: spy, mobileSidebarOpen: true });
      });

      const pinnedLink = await screen.findByRole("link", {
        name: /Open pinned direct session detail check session/i,
      });

      // Fire the click sequence directly on the <Link> element, not the row
      // — in production the full-bleed `.wt-row__stretch-link` overlay is the
      // actual DOM element a real mouse click hits (z-index 1 above normal
      // flow content), and the row only sees the events via bubbling/capture.
      // userEvent.dblClick dispatches the full click/click/dblclick sequence
      // with correct `event.detail` values (1, then 2), unlike two separate
      // fireEvent.click calls.
      await user.dblClick(pinnedLink);

      // The FIRST click (detail 1) is a legitimate plain click and is
      // expected to fire the Link's onClick once. Without the fix, the
      // SECOND click (detail 2) — which is really the first half of a
      // double-click gesture — would fire it a second time; with the fix,
      // the row's onClickCapture intercepts (preventDefault/stopPropagation)
      // any click with detail > 1 before it reaches the Link's onClick.
      expect(spy).toHaveBeenCalledTimes(1);
      // The dblclick still bubbles from the Link up to the row and opens
      // the rename input as normal.
      expect(await screen.findByLabelText("Rename")).toBeInTheDocument();
    });
  });
});

// --- Phase 3b: global Workspaces section (agent-interaction-workspaces/
// 04-workspaces, Decision 6) ---
describe("LeftSidebar - global Workspaces section", () => {
  const api = createMockApi();

  const workspaceDocs = {
    "doc-other-wt": {
      id: "doc-other-wt",
      name: "Created elsewhere",
      contextKey: "wt-2", // NOT the active worktree
      mode: "free" as const,
      tiles: [],
      tree: null,
      freeRects: {},
    },
    "doc-no-wt": {
      id: "doc-no-wt",
      name: "Created with nothing active",
      contextKey: "", // simulates a doc saved with no active worktree at creation time
      mode: "free" as const,
      tiles: [],
      tree: null,
      freeRects: {},
    },
  };

  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.persist.clearStorage?.();
    useWorkspaceStore.setState({
      activeProjectId: "proj-a",
      activeWorktreeId: "wt-1", // active worktree differs from BOTH docs' contextKey
      activeSessionId: "sess-main",
      sessionStates: {},
      lastSessionByWorktree: {},
      diffScopeByWorktree: {},
      hideInactiveWorktrees: false,
      workspaceDocs,
    });
    useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
  });

  it("3b.T1 — lists a saved workspace regardless of which worktree (or none) created it or is active", async () => {
    render(
      <MemoryRouter>
        <Harness api={api}>
          <LeftSidebar api={api} />
        </Harness>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText("Created elsewhere")).toBeInTheDocument();
      expect(screen.getByText("Created with nothing active")).toBeInTheDocument();
    });
  });

  it("still lists both workspaces with NO active worktree at all (dashboard)", async () => {
    useWorkspaceStore.setState({ activeWorktreeId: null });
    render(
      <MemoryRouter>
        <Harness api={api}>
          <LeftSidebar api={api} />
        </Harness>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText("Created elsewhere")).toBeInTheDocument();
      expect(screen.getByText("Created with nothing active")).toBeInTheDocument();
    });
  });

  it("3b.T2 — clicking a workspace row navigates to /workspaces/<id> without mutating activeWorktreeId", async () => {
    const user = userEvent.setup();
    // A sibling location-reporter inside the same Router context observes the
    // navigation (useNavigate mutates Router-internal history; there's no
    // other Router-agnostic way to assert the URL actually changed).
    function LocationProbe() {
      const location = useLocation();
      return <div data-testid="location-probe">{location.pathname}</div>;
    }
    render(
      <MemoryRouter initialEntries={["/worktree/wt-1"]}>
        <Harness api={api}>
          <LeftSidebar api={api} />
        </Harness>
        <LocationProbe />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("location-probe").textContent).toBe("/worktree/wt-1");

    const row = await screen.findByText("Created elsewhere");
    await user.click(row);

    expect(screen.getByTestId("location-probe").textContent).toBe("/workspaces/doc-other-wt");
    // setActiveWorkspace (the old per-worktree pointer mechanism) must NOT be
    // invoked by this click anymore — Decision 4 moved this to routing.
    expect(useWorkspaceStore.getState().activeWorktreeId).toBe("wt-1");
    expect(useWorkspaceStore.getState().layoutByWorktree["wt-1"]?.activeWorkspaceId ?? null).toBeNull();
  });
});
