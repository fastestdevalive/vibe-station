import { createElement, useEffect } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi, type MockApi } from "@/api/mock";
import { api } from "@/api";
import type { Session } from "@/api/types";
import { Workspace } from "./Workspace";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";

// Workspace mounts the full app shell (Layout, TopBar, LeftSidebar, the
// terminal/chrome panes, ...). Stub out the libraries that need real DOM/canvas
// layout (which jsdom can't provide) so the drafting-gate assertions below can
// focus on what this file actually changes.
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    buffer = { active: { viewportY: 0, length: 0 } };
    open() {}
    focus() {}
    write() {}
    reset() {}
    refresh() {}
    loadAddon() {}
    dispose() {}
    onData() {
      return { dispose: () => {} };
    }
    onResize() {
      return { dispose: () => {} };
    }
    onScroll() {
      return { dispose: () => {} };
    }
    attachCustomKeyEventHandler() {}
    clearTextureAtlas = () => {};
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {},
}));
vi.mock("react-resizable-panels", () => ({
  PanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PanelResizeHandle: () => <div />,
}));

// The daemon-side `api` singleton (Workspace reads it, and `useServerSync`
// subscribes to its WS events) is replaced with the in-memory mock so the
// `session:state` event below can be emitted live via `__test.emit`.
vi.mock("@/api", () => ({ api: createMockApi(), createMockApi }));

// Phase 4 remount instrumentation (4.T1): wrap ToolPanel and TerminalPane in a
// thin counting wrapper (rendering the real component) so a test can assert the
// shared `tools:<projectId>` pane and the terminal dock's TerminalPane do NOT
// remount across a Project↔agent tab switch. Wrapping preserves behavior, so
// the rest of the suite is unaffected — only the mount counter changes.
let toolPanelMounts = 0;
// TerminalPane is rendered BOTH by the terminal dock (keyed by the active
// terminal session) AND internally by every AgentPaneSlot (one per agent tab,
// which legitimately remounts on a tab switch). To isolate the terminal dock's
// instance we key mounts by sessionId.
const terminalPaneMounts: Record<string, number> = {};
vi.mock("@/components/layout/ToolPanel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/layout/ToolPanel")>();
  const Real = actual.ToolPanel;
  return {
    ...actual,
    // Count actual MOUNTS (a [] effect runs once per component instance and
    // re-runs only after an unmount+remount), not re-renders — so a prop-only
    // re-render (new `renderPane` closure etc.) does not inflate the count.
    ToolPanel: (props: React.ComponentProps<typeof Real>) => {
      useEffect(() => {
        toolPanelMounts++;
      }, []);
      return createElement(Real, props);
    },
  };
});
vi.mock("@/components/layout/TerminalPane", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/layout/TerminalPane")>();
  const Real = actual.TerminalPane;
  return {
    ...actual,
    TerminalPane: (props: React.ComponentProps<typeof Real>) => {
      const sid = props.sessionId ?? "__null__";
      useEffect(() => {
        terminalPaneMounts[sid] = (terminalPaneMounts[sid] ?? 0) + 1;
      }, []);
      return createElement(Real, props);
    },
  };
});

const DRAFT_ID = "sess-agent2";

/** Mark the mock fixture's wt-1 agent session as drafting in the store. */
function makeDrafting() {
  useServerStore.setState({
    sessions: useServerStore.getState().sessions.map((s) =>
      s.id === DRAFT_ID ? { ...s, state: "drafting", lifecycleState: "drafting" } : s,
    ),
  });
  useWorkspaceStore.setState({ activeWorktreeId: "wt-1", activeSessionId: DRAFT_ID });
}

describe("Workspace drafting gate", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      activeWorktreeId: "wt-1",
      activeSessionId: null,
    });
  });

  it("2.T2 — a session genuinely still drafting (state: 'drafting') renders DraftComposer", async () => {
    render(
      <MemoryRouter initialEntries={["/worktree/wt-1/sess-agent2"]}>
        <Workspace />
      </MemoryRouter>,
    );

    // Let useServerSync's initial fetch settle and the URL read-effect pick a session.
    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeSessionId).toBeTruthy();
    });
    act(() => makeDrafting());

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "New agent" })).toBeInTheDocument();
    });
  });

  it("2.T1 — a promoted session (state patched to 'not_started' via session:state while lifecycleState stays stale 'drafting') renders the real agent pane, not DraftComposer", async () => {
    render(
      <MemoryRouter initialEntries={["/worktree/wt-1/sess-agent2"]}>
        <Workspace />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeSessionId).toBeTruthy();
    });
    act(() => makeDrafting());

    // Initially still drafting -> DraftComposer.
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "New agent" })).toBeInTheDocument();
    });

    // The live `session:state` WS handler patches ONLY `.state` (useServerSync),
    // leaving `.lifecycleState` stale at "drafting" — the exact real-bug shape.
    await act(async () => {
      (api as MockApi).__test.emit({ type: "session:state", sessionId: DRAFT_ID, state: "not_started" });
    });

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "New agent" })).not.toBeInTheDocument();
    });

    // The store now reflects the promotion: `state` live-updated, `lifecycleState` stale.
    const sess: Session | undefined = useServerStore
      .getState()
      .sessions.find((s) => s.id === DRAFT_ID);
    expect(sess?.state).toBe("not_started");
    expect(sess?.lifecycleState).toBe("drafting");
  });
});

// --- Phase 1 (project-home-workspace): routing foundation integration tests ---

/** Build a direct-agent Session fixture (worktreeId null, type agent). */
function directAgent(id: string, projectId: string, state: Session["state"] = "idle"): Session {
  return {
    id,
    worktreeId: null,
    projectId,
    modeId: "mode-1",
    type: "agent",
    isMain: false,
    state,
    lifecycleState: state,
    tmuxName: id,
    createdAt: new Date(0).toISOString(),
    sortOrder: 1,
  };
}

type Nav = (path: string) => void;

/** Renders Workspace under a MemoryRouter + the same Routes shape App.tsx uses
 *  (so `useParams` resolves for every path Workspace reads), exposing a live
 *  `navigate` handle and the current pathname. */
function renderProjectWorkspace(
  initialEntries: string[],
  navRef: { current: Nav | null },
  locRef?: { current: string | null },
) {
  function Harness() {
    const nav = useNavigate();
    const location = useLocation();
    navRef.current = nav;
    if (locRef) locRef.current = location.pathname;
    return <Workspace />;
  }
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/" element={<Harness />} />
        <Route path="/project/:projectId" element={<Harness />} />
        <Route path="/project/:projectId/:sessionId" element={<Harness />} />
        <Route path="/worktree" element={<Harness />} />
        <Route path="/worktree/:wtId" element={<Harness />} />
        <Route path="/worktree/:wtId/:sessionId" element={<Harness />} />
        <Route path="/session/:directSessionId" element={<Harness />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Workspace project workspace (Phase 1 routing)", () => {
  beforeEach(() => {
    // Reset both stores so each test starts from a clean slate. Clearing the
    // server store (with `loaded: false`) forces useServerSync's mount fetch
    // (fed by `seedDirectAgents`'s listSessions spy) to be the sole source of
    // sessions — otherwise a leftover `loaded:true` + sessions from a prior
    // test makes the URL-sync hook apply before the current test's directs
    // land, seeding the open-tab set from stale data.
    useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
    useWorkspaceStore.setState({
      activeProjectId: null,
      activeWorktreeId: null,
      activeDirectContextId: null,
      activeSessionId: null,
      openDirectAgentTabsByProject: {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Seed direct agents into the mock's `listSessions` response so the initial
   *  bundle fetch (and any refetch) includes them. Call BEFORE rendering. */
  async function seedDirectAgents(directs: Session[]): Promise<void> {
    const base = await api.listSessions();
    vi.spyOn(api, "listSessions").mockResolvedValue([...base, ...directs]);
  }

  it("1.T2 — setting activeSession from the Project tab settles the URL at /project/p1/s2 without a loop", async () => {
    await seedDirectAgents([directAgent("s1", "proj-a"), directAgent("s2", "proj-a")]);
    const nav: { current: Nav | null } = { current: null };
    const loc: { current: string | null } = { current: null };
    renderProjectWorkspace(["/project/proj-a"], nav, loc);

    // Wait for bundle to load and the hook to apply the project context.
    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeDirectContextId).toBe("proj-a");
    });

    // Simulate clicking an agent tab: activate session s2 directly.
    act(() => {
      useWorkspaceStore.getState().openProjectAgentTab("proj-a", "s2");
      useWorkspaceStore.getState().setActiveSession("s2");
    });

    // The URL must settle at the session path and the active session must not
    // be clobbered back to null (no navigate-back-then-forward loop).
    await waitFor(() => {
      expect(loc.current).toBe("/project/proj-a/s2");
    });
    expect(useWorkspaceStore.getState().activeSessionId).toBe("s2");
  });

  it("1.T3 — navigating /project/A/s1 → /project/B settles the URL and clears the session", async () => {
    await seedDirectAgents([directAgent("s1", "proj-a")]);
    const nav: { current: Nav | null } = { current: null };
    renderProjectWorkspace(["/project/proj-a/s1"], nav);

    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeSessionId).toBe("s1");
    });

    act(() => {
      nav.current?.("/project/proj-b");
    });

    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeDirectContextId).toBe("proj-b");
    });
    expect(useWorkspaceStore.getState().activeSessionId).toBeNull();
    expect(useWorkspaceStore.getState().activeWorktreeId).toBeNull();
  });

  it("1.T4 — entering /project/p1 from one of its own worktrees clears activeWorktreeId even when activeProjectId already matches", async () => {
    await seedDirectAgents([directAgent("s1", "proj-a")]);
    // Start already "in" proj-a via its worktree, with activeProjectId already proj-a.
    useWorkspaceStore.setState({ activeProjectId: "proj-a", activeWorktreeId: "wt-1", activeSessionId: "sess-main" });
    const nav: { current: Nav | null } = { current: null };
    renderProjectWorkspace(["/worktree/wt-1/sess-main"], nav);

    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeWorktreeId).toBe("wt-1");
    });
    expect(useWorkspaceStore.getState().activeProjectId).toBe("proj-a");

    // Navigate to the project's own home — activeProjectId already proj-a, but
    // the stale worktree context must still be cleared.
    act(() => {
      nav.current?.("/project/proj-a");
    });

    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeWorktreeId).toBeNull();
    });
    expect(useWorkspaceStore.getState().activeProjectId).toBe("proj-a");
  });

  it("1.T5 — New-direct-agent sequence on /project/p1 settles the URL at /project/p1/<newId> without dropping the new active session", async () => {
    await seedDirectAgents([directAgent("s1", "proj-a")]);
    const nav: { current: Nav | null } = { current: null };
    const loc: { current: string | null } = { current: null };
    renderProjectWorkspace(["/project/proj-a"], nav, loc);

    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeDirectContextId).toBe("proj-a");
    });

    // The "New direct agent" sequence: register the new session in the server
    // store, add it to the open set, and activate it — in one batch, no URL
    // navigation yet (CUJ 2).
    const newSess = directAgent("s-new", "proj-a", "working");
    act(() => {
      useServerStore.getState().applySessionCreated(newSess);
      useWorkspaceStore.getState().openProjectAgentTab("proj-a", "s-new");
      useWorkspaceStore.getState().setActiveSession("s-new");
    });

    // The URL must settle on the new session and keep it active.
    await waitFor(() => {
      expect(loc.current).toBe("/project/proj-a/s-new");
    });
    expect(useWorkspaceStore.getState().activeSessionId).toBe("s-new");
  });

  it("1.T6 — CUJ 1b: /project/p1 → /worktree/w1 → /project/p1 leaves activeDirectContextId set and activeWorktreeId null", async () => {
    await seedDirectAgents([directAgent("s1", "proj-a")]);
    const nav: { current: Nav | null } = { current: null };
    renderProjectWorkspace(["/project/proj-a"], nav);

    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeDirectContextId).toBe("proj-a");
    });

    // Go to a worktree (the project hook's `enabled` flips false → clears ref).
    act(() => {
      nav.current?.("/worktree/wt-1");
    });
    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeWorktreeId).toBe("wt-1");
    });

    // Back to the project home — must restore the project context, no stale wt.
    act(() => {
      nav.current?.("/project/proj-a");
    });
    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeDirectContextId).toBe("proj-a");
    });
    expect(useWorkspaceStore.getState().activeWorktreeId).toBeNull();
  });

  it("1.T7 — an unrelated session's session:state WS event does not change activeSessionId/activeProjectId in /project/p1/s1", async () => {
    await seedDirectAgents([directAgent("s1", "proj-a")]);
    renderProjectWorkspace(["/project/proj-a/s1"], { current: null });

    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeSessionId).toBe("s1");
    });
    expect(useWorkspaceStore.getState().activeProjectId).toBe("proj-a");

    // Emit a state change for a session in a DIFFERENT project (proj-b's wt-3 main).
    await act(async () => {
      (api as MockApi).__test.emit({ type: "session:state", sessionId: "sess-wt3-main", state: "working" });
    });

    expect(useWorkspaceStore.getState().activeSessionId).toBe("s1");
    expect(useWorkspaceStore.getState().activeProjectId).toBe("proj-a");
  });

  it("1.T8 — regression: /worktree/:wtId/:sessionId title and activation behavior is unchanged", async () => {
    renderProjectWorkspace(["/worktree/wt-1/sess-main"], { current: null });

    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeSessionId).toBe("sess-main");
    });
    expect(useWorkspaceStore.getState().activeWorktreeId).toBe("wt-1");
    expect(document.title).toBe("wt-1 — Vibe Station");
  });

  it("1.T9 — a project with 2 pre-existing direct agents, entered via /project/p1/s1, seeds BOTH into the open-tab set", async () => {
    await seedDirectAgents([directAgent("s1", "proj-a"), directAgent("s2", "proj-a")]);
    renderProjectWorkspace(["/project/proj-a/s1"], { current: null });

    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeSessionId).toBe("s1");
    });

    const open = useWorkspaceStore.getState().openDirectAgentTabsByProject["proj-a"];
    expect(open).toContain("s1");
    expect(open).toContain("s2");
  });
});

// ─── Phase 4 (project-home-workspace): tab strip, shared tools pane, /session redirect ───

describe("Workspace project workspace (Phase 4)", () => {
  beforeEach(() => {
    toolPanelMounts = 0;
    for (const k of Object.keys(terminalPaneMounts)) delete terminalPaneMounts[k];
    useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
    useWorkspaceStore.setState({
      activeProjectId: null,
      activeWorktreeId: null,
      activeDirectContextId: null,
      activeSessionId: null,
      activeTerminalSessionId: null,
      openDirectAgentTabsByProject: {},
      openFileTabsByWorktree: {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seedDirectAgents(directs: Session[]): Promise<void> {
    const base = await api.listSessions();
    vi.spyOn(api, "listSessions").mockResolvedValue([...base, ...directs]);
  }

  it("4.T6 — /session/s1 (direct agent) redirects to /project/proj-a/s1", async () => {
    await seedDirectAgents([directAgent("s1", "proj-a")]);
    const loc: { current: string | null } = { current: null };
    renderProjectWorkspace(["/session/s1"], { current: null }, loc);
    await waitFor(() => {
      expect(loc.current).toBe("/project/proj-a/s1");
    });
  });

  it("4.T7 — /session/sess-main (worktree-attached) redirects to /, not into the project workspace", async () => {
    const loc: { current: string | null } = { current: null };
    renderProjectWorkspace(["/session/sess-main"], { current: null }, loc);
    await waitFor(() => {
      expect(loc.current).toBe("/");
    });
  });

  it("4.T8 — /session/does-not-exist redirects to /", async () => {
    const loc: { current: string | null } = { current: null };
    renderProjectWorkspace(["/session/does-not-exist"], { current: null }, loc);
    await waitFor(() => {
      expect(loc.current).toBe("/");
    });
  });

  it("item 3 Fix C — a drafting direct-agent session in project scope renders DraftComposer, not the agent pane", async () => {
    const draft: Session = {
      ...directAgent("draft-1", "proj-a", "drafting"),
      draftConfig: { entryPoint: "tab", channel: "json" },
    };
    await seedDirectAgents([draft]);
    renderProjectWorkspace(["/project/proj-a/draft-1"], { current: null });

    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeSessionId).toBe("draft-1");
    });
    // Same heading DraftComposer renders for a worktree-scope draft (2.T2
    // above) — confirms Workspace.tsx's project-pane drafting branch mirrors
    // the worktree branch correctly.
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "New agent" })).toBeInTheDocument();
    });
  });

  it("4.T10 — regression: /worktree/:wtId/:sessionId PaneHostLayer/tab behavior is unaffected", async () => {
    renderProjectWorkspace(["/worktree/wt-1/sess-main"], { current: null });
    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeSessionId).toBe("sess-main");
    });
    expect(useWorkspaceStore.getState().activeWorktreeId).toBe("wt-1");
  });

  it("4.T11 — the pinned Project tab is a real, first, non-closeable TabsStrip tab; clicking it clears the session and navigates to /project/:id", async () => {
    const user = userEvent.setup();
    await seedDirectAgents([directAgent("s1", "proj-a")]);
    const nav: { current: Nav | null } = { current: null };
    const loc: { current: string | null } = { current: null };
    renderProjectWorkspace(["/project/proj-a/s1"], nav, loc);

    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeSessionId).toBe("s1");
    });

    // The pinned "Overview" tab (plan-04 naming decision, was "Project") is a
    // real role="tab" element in the strip, ordered before the agent-session
    // tab, with no close control (R16 / Resolved design question #3 —
    // pinned/un-closeable).
    const tabs = screen.getAllByRole("tab");
    const projectTab = tabs[0]!;
    expect(projectTab).toHaveTextContent("Overview");
    expect(within(projectTab).queryByRole("button", { name: /close|terminate/i })).not.toBeInTheDocument();
    expect(projectTab).toHaveAttribute("aria-selected", "false");

    // Clicking it sets activeSessionId = null (the pinned home) and navigates.
    await user.click(projectTab);
    await waitFor(() => {
      expect(loc.current).toBe("/project/proj-a");
    });
    expect(useWorkspaceStore.getState().activeSessionId).toBeNull();
    expect(projectTab).toHaveAttribute("aria-selected", "true");

    // The project home content (ProjectHomeTab) is shown underneath the strip.
    expect(screen.getByRole("heading", { name: "Proj A" })).toBeInTheDocument();
  });

  it("4.T12 — a project with 2 never-opened direct agents seeds both as open tabs on first visit", async () => {
    await seedDirectAgents([directAgent("s1", "proj-a"), directAgent("s2", "proj-a")]);
    renderProjectWorkspace(["/project/proj-a"], { current: null });

    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeDirectContextId).toBe("proj-a");
    });
    const open = useWorkspaceStore.getState().openDirectAgentTabsByProject["proj-a"];
    expect(open).toContain("s1");
    expect(open).toContain("s2");
  });

  it("4.T13 — CUJ 4: clicking 'New worktree' from the project lands on the new worktree URL, not bare /worktree", async () => {
    const nav: { current: Nav | null } = { current: null };
    const loc: { current: string | null } = { current: null };
    // Render at a worktree first so the worktree URL-sync's one-shot read is
    // consumed this page load.
    renderProjectWorkspace(["/worktree/wt-1"], nav, loc);
    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeWorktreeId).toBe("wt-1");
    });

    act(() => {
      nav.current?.("/project/proj-a");
    });
    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeDirectContextId).toBe("proj-a");
    });

    const btn = await screen.findByRole("button", { name: /New worktree/i });
    await act(async () => {
      btn.click();
      await new Promise((r) => setTimeout(r, 0));
    });

    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeWorktreeId).toBeTruthy();
    });
    const newId = useWorkspaceStore.getState().activeWorktreeId;
    expect(loc.current).toBe(`/worktree/${newId}`);
  });

  it("4.T1 — switching Project → agent → Project does NOT remount the shared tools pane or the terminal dock", async () => {
    await seedDirectAgents([directAgent("s1", "proj-a"), directAgent("s2", "proj-a")]);
    // Give the project a terminal so the dock mounts a real TerminalPane.
    const term = await api.createDirectSession({
      target: "direct",
      projectId: "proj-a",
      type: "terminal",
      useTmux: true,
    });
    useServerStore.getState().applySessionCreated(term);
    useWorkspaceStore.setState({ activeTerminalSessionId: term.id });

    renderProjectWorkspace(["/project/proj-a"], { current: null });
    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeDirectContextId).toBe("proj-a");
    });

    // Baseline: the tools pane and terminal dock have mounted.
    expect(toolPanelMounts).toBeGreaterThan(0);
    expect(terminalPaneMounts[term.id] ?? 0).toBe(1);
    const dockBaseline = terminalPaneMounts[term.id] ?? 0;
    toolPanelMounts = 0;

    // Project → agent s1 → Project → agent s2.
    act(() => {
      useWorkspaceStore.getState().setActiveSession("s1");
    });
    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeSessionId).toBe("s1");
    });
    act(() => {
      useWorkspaceStore.getState().setActiveSession(null);
    });
    act(() => {
      useWorkspaceStore.getState().setActiveSession("s2");
    });
    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeSessionId).toBe("s2");
    });

    // The shared `tools:<projectId>` pane and the terminal dock's TerminalPane
    // must NOT have remounted across the switches (AGENTS.md invariant).
    expect(toolPanelMounts).toBe(0);
    expect(terminalPaneMounts[term.id] ?? 0).toBe(dockBaseline);
  });

  it("4.T2 — the shared tools pane stays a single instance and open-file state is keyed by project across tab switches", async () => {
    await seedDirectAgents([directAgent("s1", "proj-a"), directAgent("s2", "proj-a")]);
    renderProjectWorkspace(["/project/proj-a"], { current: null });
    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeDirectContextId).toBe("proj-a");
    });

    // Simulate a file opened into the shared project-scoped tools pane.
    useWorkspaceStore.getState().openFileTabNew("proj-a", "src/shared.ts");
    act(() => {
      useWorkspaceStore.getState().setActiveSession("s1");
    });
    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeSessionId).toBe("s1");
    });
    toolPanelMounts = 0;
    act(() => {
      useWorkspaceStore.getState().setActiveSession("s2");
    });
    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeSessionId).toBe("s2");
    });

    // Same shared tools pane (no second instance) and the open file state for
    // the project survives the tab switch.
    expect(toolPanelMounts).toBe(0);
    expect(useWorkspaceStore.getState().openFileTabsByWorktree["proj-a"]).toContain("src/shared.ts");
  });
});

describe("Workspace project workspace (Phase 5 sidebar wiring)", () => {
  beforeEach(() => {
    useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
    useWorkspaceStore.setState({
      activeProjectId: null,
      activeWorktreeId: null,
      activeDirectContextId: null,
      activeSessionId: null,
      openDirectAgentTabsByProject: {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("5.T3 — clicking a worktree row from inside the project workspace navigates to /worktree/:id", async () => {
    const user = userEvent.setup();
    const loc: { current: string | null } = { current: null };
    renderProjectWorkspace(["/project/proj-a"], { current: null }, loc);

    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeDirectContextId).toBe("proj-a");
    });
    expect(loc.current).toBe("/project/proj-a");

    // The sidebar's worktree row (left sidebar renders inside Workspace's Layout)
    // navigates the project workspace out to the worktree route.
    const worktreeLink = await screen.findByRole("link", { name: /Open worktree wt-1/i });
    await user.click(worktreeLink);

    await waitFor(() => {
      expect(loc.current).toBe("/worktree/wt-1");
    });
    expect(useWorkspaceStore.getState().activeWorktreeId).toBe("wt-1");
  });
});
