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
    projectId: P1,
    modeId: null,
    type: "agent",
    state: "working",
    lifecycleState: "working",
    isMain: true,
    tmuxName: "main",
    createdAt: new Date().toISOString(),
  },
  {
    id: `${worktreeId}-alt`,
    worktreeId,
    projectId: P1,
    modeId: null,
    type: "agent",
    state: "idle",
    lifecycleState: "idle",
    isMain: false,
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

/**
 * A direct session has no worktree — activeWorktreeId is always null and the
 * context key is the project id (layoutKey = activeWorktreeId ?? activeDirectContextId).
 * setActiveFile used to key on activeWorktreeId directly, so a direct session's
 * open file was never remembered and could never be restored.
 */
describe("useWorkspaceStore - file memory per context", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.persist.clearStorage?.();
    useWorkspaceStore.setState({
      activeProjectId: null,
      activeWorktreeId: null,
      activeDirectContextId: null,
      activeSessionId: null,
      activeFilePath: null,
      lastFileByWorktree: {},
    });
  });

  it("remembers a direct session's open file under the project key", () => {
    useWorkspaceStore.getState().setActiveDirectContext(P1);
    useWorkspaceStore.getState().setActiveFile("/docs/plan.md");

    expect(useWorkspaceStore.getState().lastFileByWorktree[P1]).toBe("/docs/plan.md");
  });

  it("restores a direct session's last file on re-entering the context", () => {
    useWorkspaceStore.getState().setActiveDirectContext(P1);
    useWorkspaceStore.getState().setActiveFile("/docs/plan.md");

    // Leave the direct context, then come back.
    useWorkspaceStore.getState().setActiveDirectContext(null);
    useWorkspaceStore.setState({ activeFilePath: null });
    useWorkspaceStore.getState().setActiveDirectContext(P1);

    expect(useWorkspaceStore.getState().activeFilePath).toBe("/docs/plan.md");
  });

  it("still keys worktree sessions by worktree id", () => {
    useWorkspaceStore.setState({ activeWorktreeId: W1, activeDirectContextId: null });
    useWorkspaceStore.getState().setActiveFile("/src/index.ts");

    expect(useWorkspaceStore.getState().lastFileByWorktree[W1]).toBe("/src/index.ts");
  });

  it("keeps worktree and direct file memory in separate keys", () => {
    useWorkspaceStore.setState({ activeWorktreeId: W1, activeDirectContextId: null });
    useWorkspaceStore.getState().setActiveFile("/src/index.ts");

    useWorkspaceStore.setState({ activeWorktreeId: null });
    useWorkspaceStore.getState().setActiveDirectContext(P1);
    useWorkspaceStore.getState().setActiveFile("/docs/plan.md");

    const { lastFileByWorktree } = useWorkspaceStore.getState();
    expect(lastFileByWorktree[W1]).toBe("/src/index.ts");
    expect(lastFileByWorktree[P1]).toBe("/docs/plan.md");
  });

  it("does not record a file when there is no active context", () => {
    useWorkspaceStore.getState().setActiveFile("/orphan.ts");
    expect(useWorkspaceStore.getState().lastFileByWorktree).toEqual({});
    expect(useWorkspaceStore.getState().activeFilePath).toBe("/orphan.ts");
  });
});
