import { createElement } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DragEndEvent } from "@dnd-kit/core";
import { createMockApi } from "@/api/mock";
import { TabsStrip } from "./TabsStrip";
import { DEFAULT_WORKTREE_LAYOUT, useWorkspaceStore } from "@/hooks/useStore";

/**
 * Capture the `onDragEnd` callback TabsStrip hands to dnd-kit's DndContext,
 * without stubbing dnd-kit's actual behavior (real component still renders,
 * so `useSortable`'s context requirement inside SortableTab keeps working).
 * Lets 2.T1 exercise the EXACT reorder logic dnd-kit would invoke on a real
 * drag, without needing to simulate pointer events / layout in jsdom (dnd-kit's
 * collision detection depends on real element rects, which jsdom doesn't lay out).
 */
let capturedOnDragEnd: ((e: DragEndEvent) => void) | null = null;
let capturedOnDragStart: (() => void) | null = null;
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: Parameters<typeof actual.DndContext>[0]) => {
      capturedOnDragEnd = props.onDragEnd ?? null;
      capturedOnDragStart = (props.onDragStart as (() => void) | undefined) ?? null;
      return createElement(actual.DndContext, props);
    },
  };
});

describe("TabsStrip", () => {
  const api = createMockApi();

  beforeEach(() => {
    capturedOnDragEnd = null;
    capturedOnDragStart = null;
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeSessionId: "sess-main",
      activeTerminalSessionId: null,
      sessionStates: {},
      layoutByWorktree: {
        "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, terminalDockVisible: true },
        "wt-2": { ...DEFAULT_WORKTREE_LAYOUT, terminalDockVisible: true },
      },
    });
  });

  it("main tab has no close control", async () => {
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /^main$/i })).toBeInTheDocument();
    });
    const mainTab = screen.getByRole("tab", { name: /^main$/i });
    expect(mainTab.querySelector('[aria-label^="Close"]')).toBeNull();
  });

  it("non-main tab exposes close via aria-label", async () => {
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Close agent-2/i })).toBeInTheDocument();
    });
  });

  it("clicking close opens confirm dialog", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: /Close agent-2/i });
    await user.click(screen.getByRole("button", { name: /Close agent-2/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("click + opens NewTab dialog", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("button", { name: /New agent/i }));
    expect(screen.getByRole("dialog", { name: /New agent/i })).toBeInTheDocument();
  });

  it("agent strip has no dock-close control", async () => {
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /^main$/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /Close terminal dock/i })).toBeNull();
  });

  it("terminal strip close button hides the dock", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({ activeWorktreeId: "wt-1" });
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-1" kind="terminal" />
      </MemoryRouter>,
    );
    const closeBtn = await screen.findByRole("button", { name: /Close terminal dock/i });
    await user.click(closeBtn);
    expect(useWorkspaceStore.getState().layoutByWorktree["wt-1"]?.terminalDockVisible).toBe(false);
  });

  it("auto-creates a terminal when dock opens empty", async () => {
    const createSpy = vi.spyOn(api, "createSession");
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-2",
      activeTerminalSessionId: null,
    });
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-2" kind="terminal" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
    });
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: "wt-2",
        type: "terminal",
        useTmux: true,
      }),
    );
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Terminal/i })).toBeInTheDocument();
    });
  });

  it("does not auto-create when terminals already exist", async () => {
    const createSpy = vi.spyOn(api, "createSession");
    createSpy.mockClear();
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-1" kind="terminal" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /term-1/i })).toBeInTheDocument();
    });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("auto-creates again for a second empty worktree after switching", async () => {
    const createSpy = vi.spyOn(api, "createSession");
    createSpy.mockClear();
    const { rerender } = render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-empty-a" kind="terminal" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
    });
    // Switching worktrees keeps the same TabsStrip instance mounted (no key),
    // so the once-per-mount guard must be scoped to the context, not the mount.
    rerender(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-empty-b" kind="terminal" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(2);
    });
    expect(createSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ worktreeId: "wt-empty-b", type: "terminal", useTmux: true }),
    );
  });

  it("does not re-create when the last terminal is closed while the dock stays open", async () => {
    const user = userEvent.setup();
    const createSpy = vi.spyOn(api, "createSession");
    createSpy.mockClear();
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-empty-close" kind="terminal" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
    });
    const tab = await screen.findByRole("tab", { name: /Terminal 1/i });

    // Closing the last tab must leave the dock empty — auto-create is a
    // dock-open behaviour, not an "always keep one terminal alive" rule.
    await user.click(screen.getByRole("button", { name: /Close Terminal 1/i }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /^Close$/i }),
    );
    await waitFor(() => {
      expect(tab).not.toBeInTheDocument();
    });
    expect(screen.getByText(/No terminals/i)).toBeInTheDocument();
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("retries auto-create on a later dock open when the previous create left no session", async () => {
    const createSpy = vi
      .spyOn(api, "createSession")
      .mockResolvedValue({ id: "sess-ghost" } as never);
    createSpy.mockClear();
    const { unmount } = render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-empty-ghost" kind="terminal" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(1);
    });
    // Dock closed before the created session ever showed up. Re-opening it on a
    // still-empty worktree must not be permanently wedged by a stale in-flight key.
    unmount();
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-empty-ghost" kind="terminal" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledTimes(2);
    });
    createSpy.mockRestore();
  });

  // ─── Reorder + rename: real endpoints (Part 03 Phase 2) ─────────────────

  it("2.T1 — dragging a tab calls the mocked reorderSession with the computed sortOrder", async () => {
    const reorderSpy = vi.spyOn(api, "reorderSession");
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    await screen.findByRole("tab", { name: /^main$/i });
    expect(capturedOnDragEnd).toBeTypeOf("function");

    // Mock fixtures: sess-main sortOrder=1, sess-agent2 sortOrder=2. Dragging
    // agent-2 to sit before main should give it a value just below main's.
    act(() => {
      capturedOnDragEnd!({
        active: { id: "sess-agent2" },
        over: { id: "sess-main" },
      } as unknown as DragEndEvent);
    });

    expect(reorderSpy).toHaveBeenCalledWith("sess-agent2", 0);
  });

  it("2.T1 — a no-op drop (dropped on itself) does not call reorderSession", async () => {
    const reorderSpy = vi.spyOn(api, "reorderSession");
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    await screen.findByRole("tab", { name: /^main$/i });
    act(() => {
      capturedOnDragEnd!({
        active: { id: "sess-agent2" },
        over: { id: "sess-agent2" },
      } as unknown as DragEndEvent);
    });
    expect(reorderSpy).not.toHaveBeenCalled();
  });

  // Regression: dragging a non-active tab to reorder it used to ALSO activate
  // it. dnd-kit never starts a native HTML5 drag (it only moves the tab via
  // a CSS transform), so the browser still fires a plain `click` on the tab
  // at pointerup regardless of how far the pointer traveled — and that click
  // used to call `setActiveSession` unconditionally. A real drag fires
  // `onDragStart` (set once the pointer clears `activationConstraint.distance`)
  // before `onDragEnd`/the trailing click, so this test reproduces the actual
  // event order dnd-kit produces, not just "click a tab".
  it("dragging a non-active tab to reorder it does not also activate it", async () => {
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    const agent2Tab = await screen.findByRole("tab", { name: /agent-2/i });
    expect(agent2Tab).toHaveAttribute("aria-selected", "false");
    expect(capturedOnDragStart).toBeTypeOf("function");
    expect(capturedOnDragEnd).toBeTypeOf("function");

    act(() => {
      capturedOnDragStart!();
      capturedOnDragEnd!({
        active: { id: "sess-agent2" },
        over: { id: "sess-main" },
      } as unknown as DragEndEvent);
    });
    // The browser's trailing click on the dragged tab, which fires after
    // dnd-kit's onDragEnd regardless of drag distance.
    agent2Tab.click();

    expect(useWorkspaceStore.getState().activeSessionId).toBe("sess-main");
    expect(agent2Tab).toHaveAttribute("aria-selected", "false");
  });

  it("a plain click (no preceding drag) still activates the tab", async () => {
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    const agent2Tab = await screen.findByRole("tab", { name: /agent-2/i });
    act(() => {
      agent2Tab.click();
    });
    expect(useWorkspaceStore.getState().activeSessionId).toBe("sess-agent2");
  });

  it("2.T2 — an empty inline rename calls renameSession unconditionally and the UI reflects the default label", async () => {
    const user = userEvent.setup();
    const renameSpy = vi.spyOn(api, "renameSession");
    const { container } = render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    const tab = await screen.findByRole("tab", { name: /agent-2/i });
    await user.dblClick(tab);

    const input = container.querySelector(".tab__rename-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    await user.clear(input);
    await user.keyboard("{Enter}");

    // Unconditional call — empty string is sent, not silently dropped.
    await waitFor(() => {
      expect(renameSpy).toHaveBeenCalledWith("sess-agent2", "");
    });

    // The mock's renameSession clears `name` to null and recomputes `label`
    // back to the computed default ("Agent", since this is not the main
    // session) — TabsStrip refetches after the call so the tab picks it up.
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /^Agent\b/i })).toBeInTheDocument();
    });
  });

  it("2.T4 — reordering persists and is visible from a fresh mount (different browser/profile)", async () => {
    const localApi = createMockApi();
    const first = render(
      <MemoryRouter>
        <TabsStrip api={localApi} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    await screen.findByRole("tab", { name: /^main$/i });
    act(() => {
      capturedOnDragEnd!({
        active: { id: "sess-agent2" },
        over: { id: "sess-main" },
      } as unknown as DragEndEvent);
    });

    // Wait for the (fire-and-forget) reorderSession call to resolve server-side.
    await waitFor(async () => {
      const fresh = await localApi.listSessions("wt-1");
      const agent2 = fresh.find((s) => s.id === "sess-agent2")!;
      const main = fresh.find((s) => s.id === "sess-main")!;
      expect(agent2.sortOrder!).toBeLessThan(main.sortOrder!);
    });

    // A brand-new TabsStrip mount (simulating a different browser/profile)
    // fetches fresh from the "server" and shows the persisted order.
    first.unmount();
    render(
      <MemoryRouter>
        <TabsStrip api={localApi} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    const tabs = await screen.findAllByRole("tab");
    const labels = tabs.map((t) => t.textContent ?? "");
    const agent2Index = labels.findIndex((l) => l.includes("agent-2"));
    const mainIndex = labels.findIndex((l) => l.includes("main"));
    expect(agent2Index).toBeGreaterThanOrEqual(0);
    expect(mainIndex).toBeGreaterThanOrEqual(0);
    expect(agent2Index).toBeLessThan(mainIndex);
  });

  // ─── Reset (+handoff) + archived styling (Part 03 Phase 3) ──────────────

  it("3.T1 — clicking Reset opens the ConfirmDialog and only calls resetSession after confirming", async () => {
    const localApi = createMockApi();
    const resetSpy = vi.spyOn(localApi, "resetSession");
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TabsStrip api={localApi} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    const tab = await screen.findByRole("tab", { name: /agent-2/i });
    const trigger = within(tab).getByRole("button", { name: /Session actions for agent-2/i });
    await user.click(trigger);

    const resetItem = await screen.findByRole("menuitem", { name: /^Reset$/i });
    // Selecting the menu item stages the target but must NOT call the API yet.
    await user.click(resetItem);
    expect(resetSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    const confirmBtn = screen.getByRole("button", { name: "Reset" });
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(resetSpy).toHaveBeenCalledWith("sess-agent2", { handoff: false });
    });
  });

  it("3.T1b — 'Reset with handoff' passes handoff: true", async () => {
    const localApi = createMockApi();
    const resetSpy = vi.spyOn(localApi, "resetSession");
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TabsStrip api={localApi} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    const tab = await screen.findByRole("tab", { name: /agent-2/i });
    const trigger = within(tab).getByRole("button", { name: /Session actions for agent-2/i });
    await user.click(trigger);

    const resetItem = await screen.findByRole("menuitem", { name: /reset with handoff/i });
    await user.click(resetItem);
    expect(resetSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Reset" }));

    await waitFor(() => {
      expect(resetSpy).toHaveBeenCalledWith("sess-agent2", { handoff: true });
    });
  });

  it("3.T2 — cancelling the ConfirmDialog never calls resetSession", async () => {
    const localApi = createMockApi();
    const resetSpy = vi.spyOn(localApi, "resetSession");
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TabsStrip api={localApi} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    const tab = await screen.findByRole("tab", { name: /agent-2/i });
    const trigger = within(tab).getByRole("button", { name: /Session actions for agent-2/i });
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: /^Reset$/i }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(resetSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("3.T3 — after a real reset, the old tab shows archived styling and the new tab appears live, no manual refresh needed", async () => {
    const localApi = createMockApi();
    render(
      <MemoryRouter>
        <TabsStrip api={localApi} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    await screen.findByRole("tab", { name: /agent-2/i });
    const tabsBefore = await screen.findAllByRole("tab");
    expect(tabsBefore).toHaveLength(2); // main + agent-2

    // Directly exercise the daemon call (mocked here) — the mock emits
    // session:updated (archivedAt) + session:created (new session) over WS,
    // mirroring what a real daemon does for POST /sessions/:id/reset.
    await act(async () => {
      await localApi.resetSession("sess-agent2", { handoff: false });
    });

    // Both the old tab's archived styling AND the freshly spawned replacement
    // session arrive live from the same WS round-trip — no manual refresh.
    await waitFor(() => {
      expect(screen.getAllByRole("tab")).toHaveLength(3);
    });
    const archivedTab = screen
      .getAllByRole("tab")
      .find((t) => t.getAttribute("data-archived") === "true");
    expect(archivedTab).toBeTruthy();
    expect(within(archivedTab!).getByText(/archived/i)).toBeInTheDocument();
  });

  it("keeps a session announced by session:created while the initial fetch was still in flight", async () => {
    // Regression: "sometimes a second agent session doesn't show up in the tab
    // bar". The mount effect fetched `listSessions` and REPLACED state with the
    // result. If `session:created` landed while that GET was in flight — and
    // the server snapshot it returns predates the insert — the resolve dropped
    // the new session, and nothing ever invalidated it, so the tab stayed
    // missing until an unrelated refetch.
    //
    // This is a lost update, not slowness: a slow daemon only widens the window
    // from microseconds to seconds, so no amount of latency work fixes it.
    const localApi = createMockApi();
    const staleSnapshot = await localApi.listSessions("wt-1");

    let releaseFetch: (() => void) | null = null;
    vi.spyOn(localApi, "listSessions").mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFetch = () => resolve(structuredClone(staleSnapshot));
        }),
    );

    render(
      <MemoryRouter>
        <TabsStrip api={localApi} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );

    await waitFor(() => expect(releaseFetch).not.toBeNull());

    // The daemon announces a new agent BEFORE our in-flight GET resolves.
    const newSession = {
      ...staleSnapshot.find((s) => s.type === "agent")!,
      id: "sess-raced",
      name: "Raced Agent",
      label: "Raced Agent",
      isMain: false,
      sortOrder: Date.now(),
    };
    await act(async () => {
      localApi.__test.emit({ type: "session:created", sessionId: newSession.id, snapshot: newSession });
    });

    // Now the older snapshot lands. It must not erase the raced-in session.
    await act(async () => {
      releaseFetch!();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /raced agent/i })).toBeInTheDocument();
    });
  });
});
