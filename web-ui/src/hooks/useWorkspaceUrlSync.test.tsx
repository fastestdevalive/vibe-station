import { createElement, useState } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import type { Session, Worktree } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useWorkspaceUrlSync } from "./useWorkspaceUrlSync";

const P1 = "project-1";
const W1 = "wt-1";

const mockSession = (id: string, isMain = true, overrides: Partial<Session> = {}): Session => ({
  id,
  worktreeId: W1,
  projectId: P1,
  modeId: null,
  type: "terminal",
  state: "working",
  lifecycleState: "working",
  isMain,
  tmuxName: id,
  createdAt: new Date().toISOString(),
  ...overrides,
});

const mockWorktree = (id = W1): Worktree => ({
  id,
  projectId: P1,
  branch: "main",
  baseBranch: "main",
  createdAt: new Date().toISOString(),
  pinnedAt: null,
  hiddenAt: null,
  lspEnabled: false,
});

const navigateRef: { current: ((p: string) => void) | null } = { current: null };
const setSessionsRef: {
  current: ((sessions: Session[]) => void) | null;
} = { current: null };

/** Stateful harness — lets a test swap the `sessions` prop (simulating WS
 *  churn) and navigate (simulating a sidebar click) after mount. */
function StatefulHarness({ initialSessions }: { initialSessions: Session[] }) {
  const [sessions, setSessions] = useState(initialSessions);
  navigateRef.current = useNavigate();
  setSessionsRef.current = setSessions;
  useWorkspaceUrlSync(true, [mockWorktree()], sessions);
  return null;
}

function renderAt(path: string, initialSessions: Session[]) {
  return render(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(
        Routes,
        null,
        createElement(Route, { path: "/worktree/:wtId/:sessionId", element: createElement(StatefulHarness, { initialSessions }) }),
        createElement(Route, { path: "/worktree/:wtId", element: createElement(StatefulHarness, { initialSessions }) }),
      ),
    ),
  );
}

function navigate(path: string) {
  act(() => navigateRef.current?.(path));
}

function setSessions(sessions: Session[]) {
  act(() => setSessionsRef.current?.(sessions));
}

describe("useWorkspaceUrlSync", () => {
  beforeEach(() => {
    navigateRef.current = null;
    setSessionsRef.current = null;
    useWorkspaceStore.setState({
      activeProjectId: null,
      activeWorktreeId: null,
      activeSessionId: null,
      activeTerminalSessionId: null,
      lastSessionByWorktree: {},
      lastTerminalByWorktree: {},
      sessionStates: {},
    });
  });

  describe("read effect — pickWorktreeAgent (Phase 1)", () => {
    it("1.2a — a stale superseded last-used id falls back to the live main agent", async () => {
      const sessions = [
        mockSession("sess-main", true, { type: "agent" }),
        mockSession("sess-stale", false, { type: "agent", supersededBy: "sess-main" }),
      ];
      // Long-idle client persisted a last-used id that is now superseded.
      useWorkspaceStore.setState({ lastSessionByWorktree: { [W1]: "sess-stale" } });

      renderAt(`/worktree/${W1}`, sessions);

      await waitFor(() => {
        expect(useWorkspaceStore.getState().activeWorktreeId).toBe(W1);
      });
      expect(useWorkspaceStore.getState().activeSessionId).toBe("sess-main");
    });

    it("1.2b — an explicit superseded sessionId in the URL falls back to the live main agent", async () => {
      const sessions = [
        mockSession("sess-main", true, { type: "agent" }),
        mockSession("sess-stale", false, { type: "agent", supersededBy: "sess-main" }),
      ];

      renderAt(`/worktree/${W1}/sess-stale`, sessions);

      await waitFor(() => {
        expect(useWorkspaceStore.getState().activeWorktreeId).toBe(W1);
      });
      // Superseded explicit id is not tab-visible → pickWorktreeAgent falls to main.
      expect(useWorkspaceStore.getState().activeSessionId).toBe("sess-main");
    });

    it("1.2c — an explicit visible sessionId is selected", async () => {
      const sessions = [
        mockSession("sess-main", true, { type: "agent" }),
        mockSession("sess-alt", false, { type: "agent" }),
      ];

      renderAt(`/worktree/${W1}/sess-alt`, sessions);

      await waitFor(() => {
        expect(useWorkspaceStore.getState().activeSessionId).toBe("sess-alt");
      });
    });

    it("1.2d — pinned-row click: an exited (still tabbed) last-used agent, even already active in the store, loses to the live main agent", async () => {
      const sessions = [
        mockSession("sess-main", true, { type: "agent" }),
        mockSession("sess-exited", false, { type: "agent", state: "exited" }),
      ];
      // setActiveWorktree's idempotent early return can leave a stale active id;
      // the URL read effect's first apply must still resolve to the live main.
      useWorkspaceStore.setState({
        activeWorktreeId: W1,
        activeSessionId: "sess-exited",
        lastSessionByWorktree: { [W1]: "sess-exited" },
      });

      renderAt(`/worktree/${W1}`, sessions);

      await waitFor(() => {
        expect(useWorkspaceStore.getState().activeSessionId).toBe("sess-main");
      });
    });

    it("1.T2a — Decision 9: a later param change to a superseded id keeps it selected (sidebar click not bounced)", async () => {
      const sessions = [
        mockSession("sess-main", true, { type: "agent" }),
        mockSession("sess-stale", false, { type: "agent", supersededBy: "sess-main" }),
      ];

      // First apply: mount on a valid visible agent.
      renderAt(`/worktree/${W1}/sess-main`, sessions);
      await waitFor(() => {
        expect(useWorkspaceStore.getState().activeSessionId).toBe("sess-main");
      });

      // Sidebar click navigates to the superseded row as a LATER param change.
      navigate(`/worktree/${W1}/sess-stale`);

      await waitFor(() => {
        expect(useWorkspaceStore.getState().activeSessionId).toBe("sess-stale");
      });
    });
  });

  describe("guard effect — edge-triggered re-selection (Phase 1)", () => {
    it("1.4a — active agent deleted live → falls back to the main agent", async () => {
      const sessionsWithAgent = [
        mockSession("sess-main", true, { type: "agent" }),
        mockSession("sess-agent2", false, { type: "agent" }),
      ];
      const sessionsAfterDelete = [mockSession("sess-main", true, { type: "agent" })];

      renderAt(`/worktree/${W1}/sess-agent2`, sessionsWithAgent);

      // Agent2 is selected and observed as visible.
      await waitFor(() => {
        expect(useWorkspaceStore.getState().activeSessionId).toBe("sess-agent2");
      });

      // The active agent is deleted (removed from the list) live.
      setSessions(sessionsAfterDelete);

      await waitFor(() => {
        expect(useWorkspaceStore.getState().activeSessionId).toBe("sess-main");
      });
    });

    it("1.4b — active agent superseded live → follows the replacement chain", async () => {
      const sessionsBefore = [
        mockSession("sess-main", true, { type: "agent" }),
        mockSession("sess-agent2", false, { type: "agent" }),
      ];
      const sessionsAfter = [
        mockSession("sess-main", true, { type: "agent" }),
        mockSession("sess-agent2", false, { type: "agent", supersededBy: "sess-agent2-new" }),
        mockSession("sess-agent2-new", false, { type: "agent", sortOrder: 3 }),
      ];

      renderAt(`/worktree/${W1}/sess-agent2`, sessionsBefore);

      await waitFor(() => {
        expect(useWorkspaceStore.getState().activeSessionId).toBe("sess-agent2");
      });

      // The active agent is superseded by a replacement.
      setSessions(sessionsAfter);

      await waitFor(() => {
        expect(useWorkspaceStore.getState().activeSessionId).toBe("sess-agent2-new");
      });
    });

    it("1.4c — Decision 5: an id never seen visible is left untouched by the guard", async () => {
      const sessions = [
        mockSession("sess-main", true, { type: "agent" }),
        mockSession("sess-stale", false, { type: "agent", supersededBy: "sess-main" }),
      ];

      renderAt(`/worktree/${W1}/sess-main`, sessions);

      await waitFor(() => {
        expect(useWorkspaceStore.getState().activeSessionId).toBe("sess-main");
      });

      // Sidebar click selects a superseded row (never observed as visible) —
      // the read effect keeps it (Decision 9), so activeSessionId is the stale id.
      act(() => useWorkspaceStore.getState().setActiveSession("sess-stale"));
      await waitFor(() => {
        expect(useWorkspaceStore.getState().activeSessionId).toBe("sess-stale");
      });

      // A later sessions change triggers the guard re-run; the stale id was
      // never seen visible, so it must NOT be bounced.
      setSessions([...sessions, mockSession("sess-new", false, { type: "agent", sortOrder: 5 })]);

      await new Promise((r) => setTimeout(r, 30));
      expect(useWorkspaceStore.getState().activeSessionId).toBe("sess-stale");
    });
  });
});
