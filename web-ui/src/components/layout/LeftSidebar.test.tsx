import { createElement } from "react";
import { render, screen, waitFor, fireEvent, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
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
        label: "extra",
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
          label,
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
          label: "old direct",
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
  });

  // ─── Rename (Part 03 Phase 2 — real endpoint, not local override) ───────
  describe("rename dialog", () => {
    it("2.T2 — renaming a worktree via the dialog calls the real renameWorktree endpoint", async () => {
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
      await screen.findByRole("link", { name: /Open worktree wt-1/i });

      const wtRow = screen.getByRole("link", { name: /Open worktree wt-1/i }).closest(".tree-row")!;
      const trigger = wtRow.querySelector("[data-wt-menu-trigger]")! as HTMLElement;
      await user.click(trigger);
      const renameItem = await screen.findByRole("menuitem", { name: /rename/i });
      await user.click(renameItem);

      const input = await screen.findByLabelText("New name");
      await user.clear(input);
      await user.type(input, "renamed-worktree");
      await user.click(screen.getByRole("button", { name: /^rename$/i }));

      await waitFor(() => {
        expect(renameSpy).toHaveBeenCalledWith("wt-1", "renamed-worktree");
      });
      // Store reconciles via the `worktree:updated` WS event the mock emits —
      // the new name shows up without a manual refresh.
      await waitFor(() => {
        expect(screen.getByRole("link", { name: /Open worktree renamed-worktree/i })).toBeInTheDocument();
      });
    });
  });
});
