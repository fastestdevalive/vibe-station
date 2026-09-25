import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import type { Project, PrStatus, Session, Worktree } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useModesStore } from "@/store/modesStore";
import { ProjectHomeTab, type ProjectHomeTabProps } from "./ProjectHomeTab";
import { resolveDefaultModeId } from "@/lib/defaultMode";

vi.mock("@/lib/defaultMode", () => ({
  resolveDefaultModeId: vi.fn(),
}));

const mockResolveDefaultModeId = resolveDefaultModeId as unknown as ReturnType<typeof vi.fn>;

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Project One",
    path: "/home/dev/p1",
    prefix: "p1",
    isGit: true,
    defaultBranch: "main",
    createdAt: new Date(0).toISOString(),
    hidden: false,
    lspEnabled: false,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    worktreeId: null,
    projectId: "p1",
    modeId: "mode-1",
    type: "agent",
    isMain: false,
    state: "idle",
    lifecycleState: "idle",
    tmuxName: "s1",
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: "wt-1",
    projectId: "p1",
    branch: "wt-1",
    baseBranch: "main",
    baseSha: "abc",
    createdAt: new Date(0).toISOString(),
    pinnedAt: null,
    hiddenAt: null,
    mainSessionId: "wt-1-m",
    lspEnabled: false,
    ...overrides,
  };
}

function renderTab(props: Partial<ProjectHomeTabProps> = {}) {
  const api = createMockApi();
  const onOpenAgent = vi.fn();
  const { rerender } = render(
    <ProjectHomeTab
      api={api}
      project={makeProject()}
      sessions={[]}
      worktrees={[]}
      onOpenAgent={onOpenAgent}
      {...props}
    />,
  );
  // Re-render with the project currently held in the server store — mimics
  // Workspace re-deriving `project` from the store after applyProjectUpdated.
  const rerenderProjectFromStore = (projectId = makeProject().id) => {
    const stored = useServerStore.getState().projects.find((p) => p.id === projectId);
    if (!stored) throw new Error(`no stored project ${projectId}`);
    rerender(
      <ProjectHomeTab api={api} project={stored} sessions={[]} worktrees={[]} onOpenAgent={onOpenAgent} />,
    );
  };
  return { api, onOpenAgent, rerender, rerenderProjectFromStore };
}

const NEW_WORKTREE = "New worktree";
const NEW_DIRECT = "New direct agent";describe("ProjectHomeTab — Phase 2 (git status, quick actions, empty state)", () => {
  beforeEach(() => {
    // Seed the store's project so applyProjectUpdated (git-init) has a record to
    // update — Workspace re-derives `project` from this store.
    useServerStore.setState({ projects: [makeProject()], worktrees: [], sessions: [], loaded: false });
    useModesStore.getState()._reset();
    mockResolveDefaultModeId.mockReset();
    mockResolveDefaultModeId.mockResolvedValue("mode-1");
  });

  it("2.T2 — non-git project renders warning, enabled git init, disabled New worktree", () => {
    renderTab({ project: makeProject({ isGit: false, defaultBranch: undefined }) });
    expect(screen.getByText("⚠ Not a git repo")).toBeTruthy();
    const gitInit = screen.getByRole("button", { name: "Run git init" });
    expect((gitInit as HTMLButtonElement).disabled).toBe(false);
    const newWorktree = screen.getByRole("button", { name: NEW_WORKTREE });
    expect((newWorktree as HTMLButtonElement).disabled).toBe(true);
    expect(newWorktree.getAttribute("title")).toBe("Run git init first");
  });

  it("2.T3 — git init success flips the header and enables New worktree", async () => {
    const { api, rerender, rerenderProjectFromStore } = renderTab({ project: makeProject({ isGit: false, defaultBranch: undefined }) });
    const spy = vi.spyOn(api, "gitInitProject").mockResolvedValue({ ok: true, isGit: true, defaultBranch: "main" });

    await userEvent.click(screen.getByRole("button", { name: "Run git init" }));

    expect(spy).toHaveBeenCalledWith("p1");
    // Workspace re-derives `project` from the store after applyProjectUpdated —
    // ProjectHomeTab derives its git status purely from the `project` prop.
    await waitFor(() => {
      expect(useServerStore.getState().projects.find((p) => p.id === "p1")?.isGit).toBe(true);
    });
    rerenderProjectFromStore("p1");
    await waitFor(() => expect(screen.getByText("✓ main")).toBeTruthy());
    expect(screen.queryByText("⚠ Not a git repo")).toBeNull();
    const newWorktree = screen.getByRole("button", { name: NEW_WORKTREE });
    expect((newWorktree as HTMLButtonElement).disabled).toBe(false);
    spy.mockRestore();
  });

  it("regression — re-rendering with a different project shows that project's git status, not stale state", async () => {
    // Regression for the Overview-tab state leak (fixed by keying ProjectHomeTab
    // by project.id in Workspace.tsx + removing the local gitStatus override).
    // Even WITHOUT the key (i.e. the same mounted instance re-rendered with a
    // different project prop — the worst case that leaked), the git status must
    // derive purely from the current `project`, not from stale local state left
    // over from a previous git-init on another project.
    const { api, rerender } = renderTab({ project: makeProject({ id: "pA", isGit: false, defaultBranch: undefined }) });
    const spy = vi.spyOn(api, "gitInitProject").mockResolvedValue({ ok: true, isGit: true, defaultBranch: "main" });

    // git-init project A; Workspace re-derives `project` from the store.
    await userEvent.click(screen.getByRole("button", { name: "Run git init" }));
    rerender(
      <ProjectHomeTab
        api={api}
        project={makeProject({ id: "pA", isGit: true, defaultBranch: "main" })}
        sessions={[]}
        worktrees={[]}
        onOpenAgent={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText("✓ main")).toBeTruthy());

    // Switch to project B (non-git) — same tree position, no remount.
    rerender(
      <ProjectHomeTab
        api={api}
        project={makeProject({ id: "pB", isGit: false, defaultBranch: undefined })}
        sessions={[]}
        worktrees={[]}
        onOpenAgent={vi.fn()}
      />,
    );

    // Must show B's status, not A's stale "✓ main".
    expect(screen.getByText("⚠ Not a git repo")).toBeTruthy();
    expect(screen.queryByText("✓ main")).toBeNull();
    const newWorktree = screen.getByRole("button", { name: NEW_WORKTREE });
    expect((newWorktree as HTMLButtonElement).disabled).toBe(true);
    spy.mockRestore();
  });

  it("2.T4 — git-init rejection shows inline error, retry still works", async () => {
    const { api, rerender, rerenderProjectFromStore } = renderTab({ project: makeProject({ isGit: false, defaultBranch: undefined }) });
    const spy = vi
      .spyOn(api, "gitInitProject")
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ ok: true, isGit: true, defaultBranch: "main" });

    await userEvent.click(screen.getByRole("button", { name: "Run git init" }));

    await waitFor(() =>
      expect(screen.getByText(/Could not initialize git/)).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "Run git init" })).toBeTruthy();

    // Retry succeeds.
    await userEvent.click(screen.getByRole("button", { name: "Run git init" }));
    await waitFor(() => {
      expect(useServerStore.getState().projects.find((p) => p.id === "p1")?.isGit).toBe(true);
    });
    rerenderProjectFromStore("p1");
    await waitFor(() => expect(screen.getByText("✓ main")).toBeTruthy());
    spy.mockRestore();
  });

  it("2.T5 (revised, item 3 DECIDED) — New direct agent opens a DRAFT tab, never creates a live session", async () => {
    const { api } = renderTab();
    const draft = makeSession({ id: "sess-new", state: "drafting", draftConfig: { entryPoint: "tab", channel: "json" } });
    const draftSpy = vi.spyOn(api, "createDraftSession").mockResolvedValue(draft);
    const directSpy = vi.spyOn(api, "createDirectSession");
    const setActiveSpy = vi.spyOn(useWorkspaceStore.getState(), "setActiveSession");
    const openTabSpy = vi.spyOn(useWorkspaceStore.getState(), "openProjectAgentTab");

    await userEvent.click(screen.getByRole("button", { name: NEW_DIRECT }));

    await waitFor(() => expect(setActiveSpy).toHaveBeenCalledWith("sess-new"));
    expect(draftSpy).toHaveBeenCalledWith({
      target: "direct",
      projectId: "p1",
      type: "agent",
      draftConfig: { entryPoint: "tab", channel: "json" },
    });
    expect(directSpy).not.toHaveBeenCalled();
    expect(openTabSpy).toHaveBeenCalledWith("p1", "sess-new");

    draftSpy.mockRestore();
    directSpy.mockRestore();
    setActiveSpy.mockRestore();
    openTabSpy.mockRestore();
  });

  it("2.T6 (revised) — resolveDefaultModeId null disables New worktree only; New direct agent is unaffected (DraftComposer resolves its own mode)", async () => {
    mockResolveDefaultModeId.mockResolvedValue(null);
    const { api, onOpenAgent } = renderTab();

    await userEvent.click(screen.getByRole("button", { name: NEW_WORKTREE }));

    await waitFor(() => {
      const newWorktree = screen.getByRole("button", { name: NEW_WORKTREE });
      expect((newWorktree as HTMLButtonElement).disabled).toBe(true);
      expect(newWorktree.getAttribute("title")).toBe("No agent modes configured");
    });
    expect(onOpenAgent).not.toHaveBeenCalled();

    // New direct agent no longer checks resolveDefaultModeId at all — it
    // stays enabled and opens a draft regardless of the modes store state.
    const direct = screen.getByRole("button", { name: NEW_DIRECT });
    expect((direct as HTMLButtonElement).disabled).toBe(false);
    const draftSpy = vi.spyOn(api, "createDraftSession").mockResolvedValue(
      makeSession({ id: "sess-new", state: "drafting", draftConfig: { entryPoint: "tab", channel: "json" } }),
    );
    await userEvent.click(direct);
    await waitFor(() => expect(draftSpy).toHaveBeenCalled());
    draftSpy.mockRestore();
  });

  it("2.T7 — empty project renders the two quick actions and guidance text, no bucket sections", () => {
    renderTab({ worktrees: [], sessions: [] });
    expect(screen.getByRole("button", { name: NEW_WORKTREE })).toBeTruthy();
    expect(screen.getByRole("button", { name: NEW_DIRECT })).toBeTruthy();
    expect(screen.getByText(/no worktrees or direct agents yet/i)).toBeTruthy();
  });

  it("2.T8 — New worktree applies the worktree to the store THEN calls onOpenAgent", async () => {
    const { api, onOpenAgent } = renderTab();
    const wt = makeWorktree({ id: "wt-new", mainSessionId: "wt-new-m" });
    const createSpy = vi.spyOn(api, "createWorktree").mockResolvedValue(wt);
    const applySpy = vi.spyOn(useServerStore.getState(), "applyWorktreeCreated");

    await userEvent.click(screen.getByRole("button", { name: NEW_WORKTREE }));

    await waitFor(() => expect(onOpenAgent).toHaveBeenCalled());
    expect(applySpy).toHaveBeenCalledWith(wt);
    // applyWorktreeCreated must run before onOpenAgent is invoked.
    expect(applySpy.mock.invocationCallOrder[0]!).toBeLessThan(onOpenAgent.mock.invocationCallOrder[0]!);
    expect(onOpenAgent).toHaveBeenCalledWith({ worktreeId: "wt-new", sessionId: "wt-new-m" });

    createSpy.mockRestore();
    applySpy.mockRestore();
  });
});

describe("ProjectHomeTab — Phase 3 (bucketed sections + Direct agents list)", () => {
  beforeEach(() => {
    useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
    useWorkspaceStore.setState({ sessionStates: {} });
    useModesStore.getState()._reset();
    mockResolveDefaultModeId.mockReset();
    mockResolveDefaultModeId.mockResolvedValue("mode-1");
  });

  // ProjectHomeTab's bucket sections read from the central stores (via the
  // extracted useSessionBuckets hook), NOT from its `sessions`/`worktrees`
  // props (which only drive the Direct-agents list and the empty state). So
  // these tests seed the server store to match what the props describe.
  function seedServer({
    sessions,
    worktrees,
  }: {
    sessions: Session[];
    worktrees: Worktree[];
  }) {
    useServerStore.setState({
      projects: [makeProject()],
      worktrees,
      sessions,
      loaded: true,
    });
  }

  it("3.T3 — a direct agent with a live sessionStates override renders the working dot", () => {
    // session.state is stale (idle) but the live sessionStates map says working.
    const direct = makeSession({ id: "d1", name: "Direct One", state: "idle", lifecycleState: "idle" });
    useWorkspaceStore.setState({ sessionStates: { d1: "working" } });

    renderTab({ sessions: [direct] });

    const section = screen.getByText("Direct agents").closest("section");
    expect(section).not.toBeNull();
    const dot = within(section!).getByLabelText("status: working");
    expect(dot).toBeInTheDocument();
    expect(screen.getByText("Direct One")).toBeInTheDocument();
  });

  it("3.T4 — a waiting_for_human worktree session renders under Needs you; a direct agent with the same status under Direct agents", () => {
    const wt = makeWorktree({ id: "wt-1" });
    const wtSess = makeSession({
      id: "wt-sess",
      name: "Worktree Agent",
      worktreeId: "wt-1",
      state: "waiting_for_human",
      lifecycleState: "waiting_for_human",
    });
    const direct = makeSession({
      id: "d1",
      name: "Direct One",
      state: "waiting_for_human",
      lifecycleState: "waiting_for_human",
    });
    seedServer({ sessions: [wtSess], worktrees: [wt] });

    renderTab({ sessions: [direct], worktrees: [wt] });

    const needsYou = screen.getByText("needs you").closest("section");
    expect(needsYou).not.toBeNull();
    expect(within(needsYou!).getByText("Worktree Agent")).toBeInTheDocument();
    // The direct agent must NOT appear under "needs you".
    expect(within(needsYou!).queryByText("Direct One")).toBeNull();

    const directSection = screen.getByText("Direct agents").closest("section");
    expect(directSection).not.toBeNull();
    expect(within(directSection!).getByText("Direct One")).toBeInTheDocument();
  });

  it("3.T5 — a worktree session on a branch with an open PR renders under pr created", () => {
    const wt = makeWorktree({ id: "wt-1", branch: "wt-1" });
    const pr: PrStatus = { state: "open", checkedAt: new Date(0).toISOString(), prBranch: "wt-1" };
    const wtMain = makeSession({
      id: "wt-main",
      name: "PR Agent",
      worktreeId: "wt-1",
      isMain: true,
      state: "idle",
      lifecycleState: "idle",
      pr,
    });
    seedServer({ sessions: [wtMain], worktrees: [wt] });

    renderTab({ sessions: [], worktrees: [wt] });

    const prSection = screen.getByText("pr created").closest("section");
    expect(prSection).not.toBeNull();
    expect(within(prSection!).getByText("PR Agent")).toBeInTheDocument();
  });

  it("3.4 — hides the Direct agents header entirely when there are no direct agents", () => {
    const wt = makeWorktree({ id: "wt-1" });
    const wtSess = makeSession({
      id: "wt-sess",
      name: "Worktree Agent",
      worktreeId: "wt-1",
      state: "idle",
      lifecycleState: "idle",
    });
    seedServer({ sessions: [wtSess], worktrees: [wt] });

    renderTab({ sessions: [], worktrees: [wt] });

    expect(screen.queryByText("Direct agents")).toBeNull();
  });

  it("excludes drafting direct sessions from the Direct agents list and from the empty state (regression)", () => {
    // A drafting (direct) session is not a live agent — the sidebar and
    // seedProjectAgentTabsIfEmpty both treat drafts separately. It must not
    // appear in the "Direct agents" list, nor make `isEmpty` false.
    const draft = makeSession({
      id: "draft-d1",
      name: null,
      state: "drafting",
      lifecycleState: "drafting",
      draftConfig: { entryPoint: "tab", channel: "json" },
    });

    renderTab({ sessions: [draft], worktrees: [] });

    expect(screen.queryByText("Direct agents")).toBeNull();
    // Only a draft → still the empty state.
    expect(screen.getByText(/no worktrees or direct agents yet/i)).toBeTruthy();
  });

  it("item 1 — clicking a worktree bucket row calls onOpenAgent with { worktreeId, sessionId }", async () => {
    const wt = makeWorktree({ id: "wt-1" });
    const wtSess = makeSession({
      id: "wt-sess",
      name: "Worktree Agent",
      worktreeId: "wt-1",
      state: "idle",
      lifecycleState: "idle",
    });
    seedServer({ sessions: [wtSess], worktrees: [wt] });

    const { onOpenAgent } = renderTab({ sessions: [], worktrees: [wt] });

    await userEvent.click(screen.getByRole("button", { name: /Worktree Agent/ }));
    expect(onOpenAgent).toHaveBeenCalledWith({ worktreeId: "wt-1", sessionId: "wt-sess" });
  });

  it("item 1 — clicking a direct-agent row adds it to the open-tab set and activates it", async () => {
    const direct = makeSession({ id: "d1", name: "Direct One" });
    const openTabSpy = vi.spyOn(useWorkspaceStore.getState(), "openProjectAgentTab");
    const setActiveSpy = vi.spyOn(useWorkspaceStore.getState(), "setActiveSession");

    renderTab({ sessions: [direct] });

    await userEvent.click(screen.getByRole("button", { name: /Direct One/ }));
    expect(openTabSpy).toHaveBeenCalledWith("p1", "d1");
    expect(setActiveSpy).toHaveBeenCalledWith("d1");

    openTabSpy.mockRestore();
    setActiveSpy.mockRestore();
  });

  it("item 2 — a bucket row shows the owning worktree's label as a chip before the session name", () => {
    const wtNamed = makeWorktree({ id: "wt-1", name: "Fix login", branch: "feat/x" });
    const wtUnnamed = makeWorktree({ id: "wt-2", name: null, branch: "feat/y" });
    const sessNamed = makeSession({ id: "s-named", name: "Agent A", worktreeId: "wt-1", state: "idle", lifecycleState: "idle" });
    const sessUnnamed = makeSession({ id: "s-unnamed", name: "Agent B", worktreeId: "wt-2", state: "idle", lifecycleState: "idle" });
    seedServer({ sessions: [sessNamed, sessUnnamed], worktrees: [wtNamed, wtUnnamed] });

    renderTab({ sessions: [], worktrees: [wtNamed, wtUnnamed] });

    expect(screen.getByText("Fix login")).toBeInTheDocument();
    expect(screen.getByText("feat/y")).toBeInTheDocument();
  });
});
