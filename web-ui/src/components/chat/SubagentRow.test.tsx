import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SubagentRow, openSubagentSession } from "./SubagentRow";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore, DEFAULT_WORKTREE_LAYOUT } from "@/hooks/useStore";
import type { Session } from "@/api/types";

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    worktreeId: "wt-1",
    projectId: "proj-1",
    modeId: "m1",
    type: "agent",
    isMain: false,
    state: "working",
    lifecycleState: "working",
    tmuxName: `tmux-${overrides.id}`,
    createdAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function seedSessions(sessions: Session[]): void {
  useServerStore.getState().replaceAll({ projects: [], worktrees: [], sessions });
}

beforeEach(() => {
  useServerStore.setState({ projects: [], worktrees: [], sessions: [], loaded: false });
  useWorkspaceStore.setState({ sessionStates: {}, layoutByWorktree: {} });
});

describe("SubagentRow — child rows (3.T1, 3.T1b, 3.T2, 3.T3)", () => {
  it("3.T1 — renders nothing when the parent has no children", () => {
    const parent = makeSession({ id: "p1" });
    seedSessions([parent]);
    const { container } = render(<SubagentRow session={parent} onOpen={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("3.T1 — one row per child", () => {
    const parent = makeSession({ id: "p1" });
    const c1 = makeSession({ id: "c1", parentSessionId: "p1", name: "child-one" });
    const c2 = makeSession({ id: "c2", parentSessionId: "p1", name: "child-two" });
    seedSessions([parent, c1, c2]);
    render(<SubagentRow session={parent} onOpen={vi.fn()} />);
    expect(screen.getByText("child-one")).toBeInTheDocument();
    expect(screen.getByText("child-two")).toBeInTheDocument();
  });

  it("3.T1b — a child in state 'done' still renders, with a done dot", () => {
    const parent = makeSession({ id: "p1" });
    const done = makeSession({ id: "c1", parentSessionId: "p1", name: "finished-child", state: "done" });
    seedSessions([parent, done]);
    render(<SubagentRow session={parent} onOpen={vi.fn()} />);
    const row = screen.getByText("finished-child").closest("button")!;
    expect(row.querySelector(".status-dot--done")).toBeTruthy();
  });

  it("3.T2 — a reset child shows once, as its successor; an archived-but-not-superseded child still shows, styled archived", () => {
    const parent = makeSession({ id: "p1" });
    const oldChild = makeSession({ id: "c1", parentSessionId: "p1", name: "old-child", supersededBy: "c2" });
    const newChild = makeSession({ id: "c2", parentSessionId: "p1", name: "new-child" });
    const archivedChild = makeSession({
      id: "c3",
      parentSessionId: "p1",
      name: "archived-child",
      archivedAt: "2024-01-02T00:00:00.000Z",
    });
    seedSessions([parent, oldChild, newChild, archivedChild]);
    render(<SubagentRow session={parent} onOpen={vi.fn()} />);
    expect(screen.queryByText("old-child")).not.toBeInTheDocument();
    expect(screen.getByText("new-child")).toBeInTheDocument();
    const archivedRow = screen.getByText("archived-child").closest("button")!;
    expect(archivedRow.className).toContain("chat-subagent-row__item--archived");
  });

  it("3.T3 — after a parent reset, children carrying the predecessor id still render", () => {
    const oldParent = makeSession({ id: "p1", supersededBy: "p2" });
    const newParent = makeSession({ id: "p2" });
    const child = makeSession({ id: "c1", parentSessionId: "p1", name: "still-here" });
    seedSessions([oldParent, newParent, child]);
    render(<SubagentRow session={newParent} onOpen={vi.fn()} />);
    expect(screen.getByText("still-here")).toBeInTheDocument();
  });
});

describe("SubagentRow — parent link (3.T6, 3.T7)", () => {
  it("3.T6 — a session with parentSessionId set renders exactly one '↑ Parent' row; a root session renders none", () => {
    const parent = makeSession({ id: "p1", name: "the-parent" });
    const child = makeSession({ id: "c1", parentSessionId: "p1" });
    seedSessions([parent, child]);
    render(<SubagentRow session={child} onOpen={vi.fn()} />);
    const parentRows = screen.getAllByText(/Parent ·/);
    expect(parentRows).toHaveLength(1);
    expect(screen.getByText("Parent · the-parent")).toBeInTheDocument();

    const { container } = render(<SubagentRow session={parent} onOpen={vi.fn()} />);
    expect(container.querySelector(".chat-subagent-row__item--parent")).toBeNull();
  });

  it("3.T7 — a reset parent resolves through supersededBy to the live successor; a deleted parent renders nothing", () => {
    const oldParent = makeSession({ id: "p1", supersededBy: "p2" });
    const newParent = makeSession({ id: "p2", name: "resolved-parent" });
    const child = makeSession({ id: "c1", parentSessionId: "p1" });
    seedSessions([oldParent, newParent, child]);
    render(<SubagentRow session={child} onOpen={vi.fn()} />);
    expect(screen.getByText("Parent · resolved-parent")).toBeInTheDocument();

    // Deleted parent: not present in the sessions list at all.
    const orphan = makeSession({ id: "c2", parentSessionId: "sess-gone" });
    seedSessions([orphan]);
    const { container } = render(<SubagentRow session={orphan} onOpen={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("SubagentRow — tap behavior (3.T5, 3.T8)", () => {
  it("3.T5/3.T8 — tapping a row calls onOpen with the target session", async () => {
    const user = userEvent.setup();
    const parent = makeSession({ id: "p1", name: "parent-sess" });
    const child = makeSession({ id: "c1", parentSessionId: "p1", name: "child-sess" });
    seedSessions([parent, child]);
    const onOpen = vi.fn();
    render(<SubagentRow session={child} onOpen={onOpen} />);

    await user.click(screen.getByText("Parent · parent-sess"));
    expect(onOpen).toHaveBeenCalledWith(parent);
  });
});

describe("SubagentRow — live WS update (3.T4)", () => {
  it("a session:created carrying parentSessionId adds a row with no refetch", () => {
    const parent = makeSession({ id: "p1" });
    seedSessions([parent]);
    render(<SubagentRow session={parent} onOpen={vi.fn()} />);
    expect(screen.queryByText("new-arrival")).not.toBeInTheDocument();

    // Mirrors what useServerSync's `session:created` handler does — a
    // targeted store patch, never a refetch.
    act(() => {
      useServerStore.getState().applySessionCreated(
        makeSession({ id: "c1", parentSessionId: "p1", name: "new-arrival" }),
      );
    });

    expect(screen.getByText("new-arrival")).toBeInTheDocument();
  });
});

describe("row wording (Subagents caption, waiting-for-agent phrasing)", () => {
  it("labels the chips with a 'Subagents:' caption, and omits it when there are none", () => {
    const parent = makeSession({ id: "p1" });
    const child = makeSession({ id: "c1", parentSessionId: "p1", name: "kid" });
    seedSessions([parent, child]);
    const { rerender } = render(<SubagentRow session={parent} onOpen={vi.fn()} />);
    expect(screen.getByText("Subagents:")).toBeInTheDocument();

    seedSessions([parent]);
    rerender(<SubagentRow session={parent} onOpen={vi.fn()} />);
    expect(screen.queryByText("Subagents:")).toBeNull();
  });

  it("a waiting subagent reads 'waiting for agent', never 'waiting for human'", () => {
    // It is blocked on the agent that spawned it, not on the person reading
    // the row — "waiting for human" would send them after their own agent's job.
    const parent = makeSession({ id: "p1" });
    const child = makeSession({ id: "c1", parentSessionId: "p1", name: "kid" });
    seedSessions([parent, child]);
    useWorkspaceStore.setState({ sessionStates: { c1: "waiting_for_human" }, layoutByWorktree: {} });
    render(<SubagentRow session={parent} onOpen={vi.fn()} />);
    const btn = screen.getByTitle(/kid/);
    expect(btn.getAttribute("title")).toContain("waiting for agent");
    expect(btn.getAttribute("title")).not.toContain("human");
  });
});

describe("openSubagentSession — classic vs workspace mode, cross-worktree guard (Decision 6, Requirement 7)", () => {
  const store = (over: Record<string, unknown> = {}) => ({
    layoutByWorktree: {},
    workspaceDocs: {},
    insertTileIntoWorkspaceDoc: vi.fn(),
    insertTileIntoScratchCanvas: vi.fn(),
    setActiveSession: vi.fn(),
    setActiveTerminalSession: vi.fn(),
    ...over,
  });

  it("classic mode: calls setActiveSession with the child id", () => {
    const from = makeSession({ id: "p1", worktreeId: "wt-1" });
    const target = makeSession({ id: "c1", worktreeId: "wt-1" });
    const st = store();
    openSubagentSession(target, from, st);
    expect(st.setActiveSession).toHaveBeenCalledWith("c1");
  });

  it("workspace mode: inserts a tile AND activates the session", () => {
    // The insert is idempotent and useServerSync already auto-tiles a spawned
    // child, so without the activation the tap would be a silent no-op in the
    // common case (parent already tiled).
    const from = makeSession({ id: "p1", worktreeId: "wt-1" });
    const target = makeSession({ id: "c1", worktreeId: "wt-1", type: "agent" });
    const st = store({ layoutByWorktree: { "wt-1": { ...DEFAULT_WORKTREE_LAYOUT, layoutMode: "workspace" } } });
    openSubagentSession(target, from, st);
    expect(st.insertTileIntoScratchCanvas).toHaveBeenCalledWith("wt-1", "agent", "c1", "wt-1");
    expect(st.setActiveSession).toHaveBeenCalledWith("c1");
  });

  it("a terminal-type subagent activates the TERMINAL slot, never the agent slot", () => {
    // `vst session create --type=terminal` also sets parentSessionId, so a
    // terminal child can appear as a row; pointing the agent pane at it would
    // render a terminal session through `agent:<id>`.
    const from = makeSession({ id: "p1", worktreeId: "wt-1" });
    const target = makeSession({ id: "t1", worktreeId: "wt-1", type: "terminal" });
    const st = store();
    openSubagentSession(target, from, st);
    expect(st.setActiveTerminalSession).toHaveBeenCalledWith("t1");
    expect(st.setActiveSession).not.toHaveBeenCalled();
  });

  it("a cross-worktree child does nothing (never switches worktree)", () => {
    const from = makeSession({ id: "p1", worktreeId: "wt-1" });
    const target = makeSession({ id: "c1", worktreeId: "wt-2" });
    const st = store();
    openSubagentSession(target, from, st);
    expect(st.setActiveSession).not.toHaveBeenCalled();
    expect(st.setActiveTerminalSession).not.toHaveBeenCalled();
    expect(st.insertTileIntoScratchCanvas).not.toHaveBeenCalled();
  });
});
