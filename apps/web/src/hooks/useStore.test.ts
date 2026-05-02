import { describe, it, expect, beforeEach } from "vitest";
import type { Session } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";

const P1 = "project-1";
const W1 = "wt-1";
const W2 = "wt-2";

const mockSessions = (worktreeId: string): Session[] => [
  {
    id: `${worktreeId}-main`,
    worktreeId,
    modeId: null,
    type: "terminal",
    state: "working",
    lifecycleState: "working",
    label: "main",
    slot: "m",
    tmuxName: "main",
    createdAt: new Date().toISOString(),
  },
  {
    id: `${worktreeId}-alt`,
    worktreeId,
    modeId: null,
    type: "terminal",
    state: "idle",
    lifecycleState: "idle",
    label: "alt",
    slot: "a",
    tmuxName: "alt",
    createdAt: new Date().toISOString(),
  },
];

describe("useWorkspaceStore - setActiveWorktree", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.persist.clearStorage?.();
    useWorkspaceStore.setState({
      activeProjectId: null,
      activeWorktreeId: null,
      activeSessionId: null,
      lastSessionByWorktree: {},
    });
  });

  it("picks main slot when sessions are provided", () => {
    const sessions = mockSessions(W1);
    useWorkspaceStore.getState().setActiveWorktree(P1, W1, sessions);
    const state = useWorkspaceStore.getState();
    expect(state.activeProjectId).toBe(P1);
    expect(state.activeWorktreeId).toBe(W1);
    expect(state.activeSessionId).toBe(`${W1}-main`);
  });

  it("prefers lastSessionByWorktree if it's still in the session list", () => {
    const sessions = mockSessions(W1);
    useWorkspaceStore.setState({
      lastSessionByWorktree: { [W1]: `${W1}-alt` },
    });
    useWorkspaceStore.getState().setActiveWorktree(P1, W1, sessions);
    const state = useWorkspaceStore.getState();
    expect(state.activeSessionId).toBe(`${W1}-alt`);
  });

  it("falls back to main slot if lastSessionByWorktree is not in the list", () => {
    const sessions = mockSessions(W1);
    useWorkspaceStore.setState({
      lastSessionByWorktree: { [W1]: "nonexistent" },
    });
    useWorkspaceStore.getState().setActiveWorktree(P1, W1, sessions);
    const state = useWorkspaceStore.getState();
    expect(state.activeSessionId).toBe(`${W1}-main`);
  });

  it("picks first session if no main slot exists", () => {
    const allSessions = mockSessions(W1);
    const sessions: Session[] = [allSessions[1]!]; // only the alt session
    useWorkspaceStore.getState().setActiveWorktree(P1, W1, sessions);
    const state = useWorkspaceStore.getState();
    expect(state.activeSessionId).toBe(`${W1}-alt`);
  });

  it("sets activeSessionId to null if no sessions provided", () => {
    useWorkspaceStore.getState().setActiveWorktree(P1, W1, []);
    const state = useWorkspaceStore.getState();
    expect(state.activeWorktreeId).toBe(W1);
    expect(state.activeSessionId).toBeNull();
  });

  it("is idempotent on re-tap with active session", () => {
    const sessions = mockSessions(W1);
    useWorkspaceStore.setState({
      activeProjectId: P1,
      activeWorktreeId: W1,
      activeSessionId: `${W1}-main`,
    });
    const beforeState = useWorkspaceStore.getState();
    useWorkspaceStore.getState().setActiveWorktree(P1, W1, sessions);
    const afterState = useWorkspaceStore.getState();
    expect(beforeState).toBe(afterState);
  });

  it("activates session when switching from null to non-null", () => {
    const sessions = mockSessions(W1);
    useWorkspaceStore.setState({
      activeWorktreeId: W1,
      activeSessionId: null,
    });
    useWorkspaceStore.getState().setActiveWorktree(P1, W1, sessions);
    const state = useWorkspaceStore.getState();
    expect(state.activeSessionId).toBe(`${W1}-main`);
  });

  it("changes worktree even if session is active in previous worktree", () => {
    const sessionsW1 = mockSessions(W1);
    const sessionsW2 = mockSessions(W2);
    useWorkspaceStore.setState({
      activeProjectId: P1,
      activeWorktreeId: W1,
      activeSessionId: `${W1}-main`,
    });
    useWorkspaceStore.getState().setActiveWorktree(P1, W2, sessionsW2);
    const state = useWorkspaceStore.getState();
    expect(state.activeWorktreeId).toBe(W2);
    expect(state.activeSessionId).toBe(`${W2}-main`);
  });

  it("clears activeFilePath when switching worktree", () => {
    const sessions = mockSessions(W1);
    useWorkspaceStore.setState({
      activeFilePath: "/some/file.ts",
    });
    useWorkspaceStore.getState().setActiveWorktree(P1, W1, sessions);
    const state = useWorkspaceStore.getState();
    expect(state.activeFilePath).toBeNull();
  });
});
