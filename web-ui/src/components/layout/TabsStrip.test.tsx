import { createElement, StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DragEndEvent } from "@dnd-kit/core";
import { createMockApi } from "@/api/mock";
import { TabsStrip } from "./TabsStrip";
import { DEFAULT_WORKTREE_LAYOUT, useWorkspaceStore } from "@/hooks/useStore";
import { useServerStore } from "@/hooks/useServerStore";
import type { Session } from "@/api/types";

/**
 * Capture the `onDragEnd` callback TabsStrip hands to dnd-kit's DndContext,
 * without stubbing dnd-kit's actual behavior (real component still renders,
 * so `useSortable`'s context requirement inside SortableTab keeps working).
 * Lets 2.T1 exercise the EXACT reorder logic dnd-kit would invoke on a real
 * drag, without needing to simulate pointer events / layout in jsdom (dnd-kit's
 * collision detection depends on real element rects, which jsdom doesn't lay out).
 */
/**
 * jsdom in this project's test environment has no native `PointerEvent`
 * constructor (verified: `typeof globalThis.PointerEvent === "undefined"`),
 * so `fireEvent.pointerDown/Move/Up` fall back to a bare `Event` with none of
 * `clientX`/`clientY`/`pointerType` set — useless for exercising the
 * long-press handlers. Dispatch a real `MouseEvent` (jsdom supports its
 * `clientX`/`clientY` natively) under the `pointerdown`/`pointermove`/etc.
 * type instead, with `pointerType` patched on as a plain property — React's
 * event delegation matches purely on `event.type`, so this reaches the same
 * `onPointerDown`/`onPointerMove` handlers a real PointerEvent would.
 */
function firePointer(
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  node: Element,
  opts: { clientX: number; clientY: number; pointerType?: string },
) {
  const event = new MouseEvent(type, {
    clientX: opts.clientX,
    clientY: opts.clientY,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "pointerType", {
    value: opts.pointerType ?? "touch",
    configurable: true,
  });
  fireEvent(node, event);
}

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

  it("A2.T2 — main tab has no close control when it is the only agent session (wt-2, sole session)", async () => {
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-2" kind="agent" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /^main\b/i })).toBeInTheDocument();
    });
    const mainTab = screen.getByRole("tab", { name: /^main\b/i });
    expect(mainTab.querySelector('[aria-label^="Terminate"]')).toBeNull();
  });

  it("A2.T1 — main tab shows a closeable '×' when a sibling agent session exists (wt-1)", async () => {
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /^main\b/i })).toBeInTheDocument();
    });
    const mainTab = screen.getByRole("tab", { name: /^main\b/i });
    expect(mainTab.querySelector('[aria-label^="Terminate"]')).not.toBeNull();
  });

  it("non-main tab exposes close via aria-label", async () => {
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Terminate agent-2/i })).toBeInTheDocument();
    });
  });

  it("clicking close opens confirm dialog", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: /Terminate agent-2/i });
    await user.click(screen.getByRole("button", { name: /Terminate agent-2/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("A2.T3 — confirm dialog for a main-session terminate names the predicted promoted sibling", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /^main\b/i })).toBeInTheDocument();
    });
    const mainTab = screen.getByRole("tab", { name: /^main\b/i });
    const closeButton = mainTab.querySelector('[aria-label^="Terminate"]') as HTMLElement;
    expect(closeButton).not.toBeNull();
    await user.click(closeButton);
    const dialog = screen.getByRole("dialog");
    // wt-1's only other non-archived agent session is "agent-2"
    // (sortOrder 2, the lowest among eligible siblings) — same rule the
    // daemon uses for authoritative selection (Decision 1).
    expect(within(dialog).getByText(/agent-2.*will become the new main session/i)).toBeInTheDocument();
  });

  it("4.T1 — a terminate target with live subagents shows their names and the 'Detach subagents & terminate' label", async () => {
    const subagent: Session = {
      id: "sess-subagent-1",
      worktreeId: "wt-2",
      projectId: "proj-a",
      modeId: "mode-1",
      type: "agent",
      name: "review-the-plan",
      isMain: false,
      state: "working",
      lifecycleState: "working",
      tmuxName: "sess-subagent-1",
      createdAt: new Date().toISOString(),
      parentSessionId: "sess-agent2",
    };
    useServerStore.setState({ sessions: [subagent] });

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: /Terminate agent-2/i });
    await user.click(screen.getByRole("button", { name: /Terminate agent-2/i }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/review-the-plan/)).toBeInTheDocument();
    expect(within(dialog).getByText(/keep running/i)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Detach subagents & terminate" })).toBeInTheDocument();

    useServerStore.setState({ sessions: [] });
  });

  it("4.T2 — confirming detaches only the parent; the subagent remains in the store", async () => {
    const subagent: Session = {
      id: "sess-subagent-2",
      worktreeId: "wt-2",
      projectId: "proj-a",
      modeId: "mode-1",
      type: "agent",
      name: "keeps-running",
      isMain: false,
      state: "working",
      lifecycleState: "working",
      tmuxName: "sess-subagent-2",
      createdAt: new Date().toISOString(),
      parentSessionId: "sess-agent2",
    };
    useServerStore.setState({ sessions: [subagent] });
    // mockResolvedValue (not a pass-through spy): `api` is a module-level
    // singleton shared by every test in this file, and the mock's real
    // terminateSession permanently removes the session from its fixture
    // data — a real call here would silently break every later test that
    // still expects "agent-2" to exist.
    const terminateSpy = vi.spyOn(api, "terminateSession").mockResolvedValue({ ok: true });

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: /Terminate agent-2/i });
    await user.click(screen.getByRole("button", { name: /Terminate agent-2/i }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Detach subagents & terminate" }),
    );

    await waitFor(() => {
      expect(terminateSpy).toHaveBeenCalledWith("sess-agent2");
    });
    expect(terminateSpy).toHaveBeenCalledTimes(1);
    // The subagent itself is never targeted — detach is free (Decision 5).
    expect(terminateSpy).not.toHaveBeenCalledWith("sess-subagent-2");
    expect(useServerStore.getState().sessions.some((s) => s.id === "sess-subagent-2")).toBe(true);

    useServerStore.setState({ sessions: [] });
    terminateSpy.mockRestore();
  });

  it("4.T3 — a terminate target with no subagents shows today's dialog, label, and delete behavior unchanged (regression)", async () => {
    useServerStore.setState({ sessions: [] });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TabsStrip api={api} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: /Terminate agent-2/i });
    await user.click(screen.getByRole("button", { name: /Terminate agent-2/i }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByText(/keep running/i)).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Terminate" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Detach subagents & terminate" })).not.toBeInTheDocument();
  });

  it("M4 — a session:updated{isMain:true} WS event propagates through TabsStrip's local reconciliation (A2.3) and is read by dependent UI (A2.5's dialog naming)", async () => {
    // Direct test of the isMain patch added at TabsStrip.tsx's own
    // `session:updated` handler (`:415-432`) — NOT routed through the global
    // `useServerSync`/`useServerStore` (A2.2, covered separately), since this
    // component reads its OWN local `sessions` state for `closeable` and the
    // confirm-dialog message. Reassigns "main" to "agent-2" purely via WS
    // events (isMain flips on both, no session added/removed) and confirms
    // the dialog naming (which reads `s.isMain` from local state) reflects
    // the swap — proving the patch actually took effect, not just that no
    // error was thrown. (Note: this cannot exercise a "closeable → not
    // closeable" transition purely from an isMain flip while holding
    // membership fixed — `closeable` is `!s.isMain || siblingCount > 1`, so a
    // main tab is only ever non-closeable when it's the SOLE session, a case
    // already covered by A2.T2; the isMain field itself doesn't gate
    // closeability when a sibling exists, in either direction.)
    const user = userEvent.setup();
    const localApi = createMockApi();
    render(
      <MemoryRouter>
        <TabsStrip api={localApi} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    await screen.findByRole("tab", { name: /^main\b/i });
    await screen.findByRole("tab", { name: /agent-2/i });

    await act(async () => {
      localApi.__test.emit({ type: "session:updated", sessionId: "sess-main", isMain: false });
      localApi.__test.emit({ type: "session:updated", sessionId: "sess-agent2", isMain: true });
    });

    // "agent-2" is now the main session — click ITS terminate control and
    // confirm the predicted promotion candidate is sess-main (sortOrder 1,
    // the only other eligible non-archived agent sibling). sess-main has no
    // explicit `name`, and `sessionLabel()` only falls back to "main" while
    // `isMain` is true — since our event just flipped it to `false`, its
    // computed label is now "Agent" (the type-based default), which is
    // itself further proof the isMain patch took effect on THIS session too
    // (not just sess-agent2).
    const agentTwoTab = screen.getByRole("tab", { name: /agent-2/i });
    const closeButton = agentTwoTab.querySelector('[aria-label^="Terminate"]') as HTMLElement;
    expect(closeButton).not.toBeNull();
    await user.click(closeButton);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Agent.*will become the new main session/i)).toBeInTheDocument();
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
      expect(screen.getByRole("tab", { name: /^main\b/i })).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: /Terminate Terminal 1/i }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /^Terminate$/i }),
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
    await screen.findByRole("tab", { name: /^main\b/i });
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
    await screen.findByRole("tab", { name: /^main\b/i });
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
    await screen.findByRole("tab", { name: /^main\b/i });
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

  // ─── Tab menu: right-click + long-press, no 3-dot trigger (Phase 2) ─────

  it("2.T1 — no 3-dot trigger element and no 'Session actions for' button exist", async () => {
    const localApi = createMockApi();
    render(
      <MemoryRouter>
        <TabsStrip api={localApi} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    await screen.findByRole("tab", { name: /^main\b/i });
    expect(document.querySelector("[data-tab-menu-trigger]")).toBeNull();
    expect(screen.queryByRole("button", { name: /Session actions for/i })).toBeNull();
  });

  it("2.T2 — the tab button contains no descendant role=button other than the close control", async () => {
    const localApi = createMockApi();
    render(
      <MemoryRouter>
        <TabsStrip api={localApi} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    const tab = await screen.findByRole("tab", { name: /agent-2/i });
    const nestedButtons = within(tab).queryAllByRole("button");
    expect(nestedButtons).toHaveLength(1);
    expect(nestedButtons[0]).toHaveAttribute("aria-label", "Terminate agent-2");
  });

  it("2.T2b — right-clicking the SAME tab twice in a row throws no error (impure-updater crash regression)", async () => {
    const localApi = createMockApi();
    const onError = vi.fn();
    window.addEventListener("error", onError);
    try {
      // StrictMode is essential here, not decorative: React intentionally
      // invokes a `setState(prev => ...)` updater function TWICE in dev
      // StrictMode to surface impure updaters — this is exactly the
      // mechanism behind the real crash's stack trace (`basicStateReducer` /
      // `updateReducerImpl` inside a render pass, not the click handler
      // itself). Verified locally: with the OLD buggy code (computing
      // `e.currentTarget.getBoundingClientRect()` inside the updater), this
      // exact test throws "Cannot read properties of null (reading
      // 'getBoundingClientRect')" from inside `basicStateReducer` on a
      // SINGLE contextmenu event once wrapped in StrictMode — without
      // StrictMode, RTL's synchronous flush never replays the updater, so
      // the bug is invisible. Right-clicking twice (open, then toggle
      // closed) additionally exercises the toggle-closed branch of the
      // updater on a second, independent event.
      render(
        <StrictMode>
          <MemoryRouter>
            <TabsStrip api={localApi} worktreeId="wt-1" kind="agent" />
          </MemoryRouter>
        </StrictMode>,
      );
      const tab = await screen.findByRole("tab", { name: /agent-2/i });

      expect(() => {
        fireEvent.contextMenu(tab, { clientX: 50, clientY: 20 });
      }).not.toThrow();
      expect(await screen.findByRole("menu", { name: /session actions/i })).toBeInTheDocument();

      expect(() => {
        fireEvent.contextMenu(tab, { clientX: 50, clientY: 20 });
      }).not.toThrow();
      await waitFor(() => {
        expect(screen.queryByRole("menu", { name: /session actions/i })).not.toBeInTheDocument();
      });

      expect(onError).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("error", onError);
    }
  });

  it("2.T5 — long-press (touch pointerdown held 500ms) opens the reset menu", async () => {
    const localApi = createMockApi();
    render(
      <MemoryRouter>
        <TabsStrip api={localApi} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    const tab = await screen.findByRole("tab", { name: /agent-2/i });
    vi.useFakeTimers();
    try {
      firePointer("pointerdown", tab, { clientX: 50, clientY: 20 });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(screen.getByRole("menuitem", { name: /^Reset$/i })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("2.T6 — long-press cancelled by pointer movement past the slop does not open the menu", async () => {
    const localApi = createMockApi();
    render(
      <MemoryRouter>
        <TabsStrip api={localApi} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    const tab = await screen.findByRole("tab", { name: /agent-2/i });
    vi.useFakeTimers();
    try {
      firePointer("pointerdown", tab, { clientX: 50, clientY: 20 });
      firePointer("pointermove", tab, { clientX: 90, clientY: 20 });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(screen.queryByRole("menuitem", { name: /^Reset$/i })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("2.T7 — a long-press-opened menu survives the trailing pointerup + click (regression: menu no longer self-closes)", async () => {
    // Reproduces the reported bug exactly: on a real touch device, the finger
    // lifting right after the long-press timer fires dispatches a `pointerup`
    // then a trailing `click` on the tab. The outside-click-to-close effect
    // (installed via its own `setTimeout(..., 0)` once the menu opens) sees
    // that click's target is not inside `[data-tab-menu-panel]` and used to
    // call `setResetMenu(null)` — closing the menu the SAME gesture just
    // opened, before the user could ever use it. `markDrag()` (called from
    // the long-press timer's callback, not from `onPointerUp`) now suppresses
    // that trailing click.
    const localApi = createMockApi();
    render(
      <MemoryRouter>
        <TabsStrip api={localApi} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    const tab = await screen.findByRole("tab", { name: /agent-2/i });
    vi.useFakeTimers();
    try {
      firePointer("pointerdown", tab, { clientX: 50, clientY: 20 });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      // Flush the outside-click effect's own `setTimeout(..., 0)` so its
      // document-level `click` listener is actually installed — matching the
      // reviewer's jsdom probe ("advance timers past the effect's 0ms
      // setTimeout") before the trailing click is dispatched.
      act(() => {
        vi.advanceTimersByTime(0);
      });
      expect(screen.getByRole("menuitem", { name: /^Reset$/i })).toBeInTheDocument();

      firePointer("pointerup", tab, { clientX: 50, clientY: 20 });
      fireEvent.click(tab);

      expect(screen.getByRole("menuitem", { name: /^Reset$/i })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("2.T8 — a native contextmenu event arriving just after a long-press-opened menu does not close it (Android echo variant)", async () => {
    // Some Android/Chrome builds fire their OWN native `contextmenu` at their
    // own long-press threshold, independent of our pointerdown timer. If that
    // lands shortly after our timer already opened the menu via
    // `setResetMenu`, the naive toggle in `onContextMenu` (`prev?.session.id
    // === s.id ? null : ...`) would see the menu already open for this
    // session and close it — same symptom as 2.T7, different trigger. Guarded
    // by `lastMenuOpenedAt` + `MENU_REOPEN_GUARD_MS`.
    const localApi = createMockApi();
    render(
      <MemoryRouter>
        <TabsStrip api={localApi} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    const tab = await screen.findByRole("tab", { name: /agent-2/i });
    vi.useFakeTimers();
    try {
      firePointer("pointerdown", tab, { clientX: 50, clientY: 20 });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(screen.getByRole("menuitem", { name: /^Reset$/i })).toBeInTheDocument();

      // The browser's own long-press detector fires its native `contextmenu`
      // a short moment later — well within the guard window.
      act(() => {
        vi.advanceTimersByTime(50);
      });
      fireEvent.contextMenu(tab, { clientX: 50, clientY: 20 });

      expect(screen.getByRole("menuitem", { name: /^Reset$/i })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
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
    fireEvent.contextMenu(tab, { clientX: 120, clientY: 40 });

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
    fireEvent.contextMenu(tab, { clientX: 120, clientY: 40 });

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
    fireEvent.contextMenu(tab, { clientX: 120, clientY: 40 });
    await user.click(await screen.findByRole("menuitem", { name: /^Reset$/i }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(resetSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("3.T3 — after a real reset, the old tab disappears entirely and the new tab appears live, no manual refresh needed", async () => {
    // present-tickmark-replacement/02-reset-relink: a reset-superseded
    // session is filtered out of the tab strip entirely (Decision 4), not
    // shown alongside its replacement as a permanent "archived" duplicate —
    // that duplicate-tab behavior was the bug this plan fixes.
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
    // session:updated (archivedAt, supersededBy) + session:created (new
    // session) over WS, mirroring what a real daemon does for
    // POST /sessions/:id/reset.
    await act(async () => {
      await localApi.resetSession("sess-agent2", { handoff: false });
    });

    // The old tab is gone (filtered by supersededBy) and the freshly spawned
    // replacement session takes its place — still exactly 2 tabs, no
    // duplicate, no manual refresh needed.
    await waitFor(() => {
      const tabs = screen.getAllByRole("tab");
      expect(tabs).toHaveLength(2);
      expect(tabs.some((t) => t.getAttribute("data-archived") === "true")).toBe(false);
    });
  });

  it("a session with supersededBy set is absent from the rendered tab list", async () => {
    const localApi = createMockApi();
    render(
      <MemoryRouter>
        <TabsStrip api={localApi} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    await screen.findByRole("tab", { name: /agent-2/i });
    expect(screen.getAllByRole("tab")).toHaveLength(2);

    await act(async () => {
      localApi.__test.emit({
        type: "session:updated",
        sessionId: "sess-agent2",
        archivedAt: new Date().toISOString(),
        supersededBy: "sess-agent2-new",
      });
    });

    await waitFor(() => {
      expect(screen.queryByRole("tab", { name: /agent-2/i })).not.toBeInTheDocument();
    });
  });

  it("when the active tab's session receives a session:updated event with supersededBy, the active tab switches to that id", async () => {
    const localApi = createMockApi();
    render(
      <MemoryRouter>
        <TabsStrip api={localApi} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    const agent2Tab = await screen.findByRole("tab", { name: /agent-2/i });
    await act(async () => {
      fireEvent.click(agent2Tab);
    });
    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeSessionId).toBe("sess-agent2");
    });

    await act(async () => {
      localApi.__test.emit({
        type: "session:updated",
        sessionId: "sess-agent2",
        archivedAt: new Date().toISOString(),
        supersededBy: "sess-agent2-new",
      });
    });

    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeSessionId).toBe("sess-agent2-new");
    });
  });

  it("reflects a rename in real time from session:updated's name field, without a refetch", async () => {
    // Regression: renaming a session via PATCH .../rename (e.g. through the
    // `/vst session rename` CLI/skill command, not just the inline UI editor)
    // was not reflected in the tab bar until a manual page refresh. At the
    // time, the tab rendered a separate server-computed `label` field, and
    // the `session:updated` broadcast only ever carried `name` — so the
    // client patched a field nothing read for display. `label` has since
    // been removed entirely: every renderer computes the display string from
    // `name` via `sessionLabel()`, so patching `name` alone is now always
    // sufficient. This asserts the tab text updates from the WS event ALONE,
    // with no `listSessions` call in between.
    const localApi = createMockApi();
    const listSpy = vi.spyOn(localApi, "listSessions");
    render(
      <MemoryRouter>
        <TabsStrip api={localApi} worktreeId="wt-1" kind="agent" />
      </MemoryRouter>,
    );
    await screen.findByRole("tab", { name: /agent-2/i });
    listSpy.mockClear();

    await act(async () => {
      localApi.__test.emit({
        type: "session:updated",
        sessionId: "sess-agent2",
        name: "renamed-elsewhere",
      });
    });

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /renamed-elsewhere/i })).toBeInTheDocument();
    });
    expect(listSpy).not.toHaveBeenCalled();
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
      isMain: false,
      sortOrder: Date.now(),
    };
    await act(async () => {
      localApi.__test.emit({
        type: "session:created",
        sessionId: newSession.id,
        worktreeId: newSession.worktreeId,
        sessionType: newSession.type,
        snapshot: newSession,
      });
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
