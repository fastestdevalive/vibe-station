import { createElement } from "react";
import { render, renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Session } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useProjectWorkspaceUrlSync } from "./useProjectWorkspaceUrlSync";

function makeSession(overrides: Partial<Session>): Session {
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

function makeProject(overrides: Partial<Project>): Project {
  return {
    id: "p1",
    name: "Project One",
    path: "/tmp/p1",
    prefix: "p1",
    isGit: true,
    defaultBranch: "main",
    createdAt: new Date(0).toISOString(),
    hidden: false,
    lspEnabled: false,
    ...overrides,
  };
}

function TestHarness({
  sessions,
  projects,
  enabled = true,
}: {
  sessions: Session[];
  projects: Project[];
  enabled?: boolean;
}) {
  useProjectWorkspaceUrlSync(enabled, true, sessions, projects);
  return null;
}

/** Wrap children in a MemoryRouter + Route so `useParams` resolves the path params. */
function wrapperFor(path: string) {
  return ({ children }: { children: React.ReactNode }) =>
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(
        Routes,
        null,
        createElement(Route, { path: "/project/:projectId/:sessionId", element: children }),
        createElement(Route, { path: "/project/:projectId", element: children }),
      ),
    );
}

describe("useProjectWorkspaceUrlSync", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      activeProjectId: null,
      activeWorktreeId: null,
      activeDirectContextId: null,
      activeSessionId: null,
      openDirectAgentTabsByProject: {},
    });
  });

  it("1.T1 — applies project + session from URL via the expected store call sequence", async () => {
    const sessions = [makeSession({})];
    const projects = [makeProject({})];

    const selectProjectSpy = vi.spyOn(useWorkspaceStore.getState(), "selectProject");
    const setActiveDirectContextSpy = vi.spyOn(useWorkspaceStore.getState(), "setActiveDirectContext");
    const setActiveSessionSpy = vi.spyOn(useWorkspaceStore.getState(), "setActiveSession");
    const openProjectAgentTabSpy = vi.spyOn(useWorkspaceStore.getState(), "openProjectAgentTab");
    const seedSpy = vi.spyOn(useWorkspaceStore.getState(), "seedProjectAgentTabsIfEmpty");

    renderHook(() => TestHarness({ sessions, projects }), { wrapper: wrapperFor("/project/p1/s1") });

    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeDirectContextId).toBe("p1");
    });

    expect(selectProjectSpy).toHaveBeenCalledWith("p1");
    expect(setActiveDirectContextSpy).toHaveBeenCalledWith("p1");
    expect(seedSpy).toHaveBeenCalledWith("p1", sessions);
    expect(setActiveSessionSpy).toHaveBeenCalledWith("s1");
    expect(openProjectAgentTabSpy).toHaveBeenCalledWith("p1", "s1");

    selectProjectSpy.mockRestore();
    setActiveDirectContextSpy.mockRestore();
    setActiveSessionSpy.mockRestore();
    openProjectAgentTabSpy.mockRestore();
    seedSpy.mockRestore();
  });

  it("ignores a sessionId that is not a direct agent of this project", async () => {
    // s1 belongs to a different project.
    const sessions = [makeSession({ projectId: "other" })];
    const projects = [makeProject({})];

    const setActiveSessionSpy = vi.spyOn(useWorkspaceStore.getState(), "setActiveSession");

    renderHook(() => TestHarness({ sessions, projects }), { wrapper: wrapperFor("/project/p1/s1") });

    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeDirectContextId).toBe("p1");
    });

    // The invalid sid is treated as absent → Project tab active (null).
    expect(setActiveSessionSpy).toHaveBeenCalledWith(null);

    setActiveSessionSpy.mockRestore();
  });

  it("clears a stale activeWorktreeId even when activeProjectId already matches", async () => {
    // Store already thinks project p1 is active, but with a stale worktree context.
    useWorkspaceStore.setState({
      activeProjectId: "p1",
      activeWorktreeId: "wt-1",
      activeDirectContextId: null,
      activeSessionId: "ws1",
    });

    const sessions: Session[] = [];
    const projects = [makeProject({})];

    renderHook(() => TestHarness({ sessions, projects }), { wrapper: wrapperFor("/project/p1") });

    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeWorktreeId).toBeNull();
    });
    expect(useWorkspaceStore.getState().activeDirectContextId).toBe("p1");
    expect(useWorkspaceStore.getState().activeProjectId).toBe("p1");
  });

  it("navigating to an unknown/hidden project redirects to / and does NOT bounce back to the previous project", async () => {
    // Store still points at project p1 (the "previous" project).
    useWorkspaceStore.setState({
      activeProjectId: "p1",
      activeWorktreeId: null,
      activeDirectContextId: "p1",
      activeSessionId: null,
      openDirectAgentTabsByProject: {},
    });
    // Only p1 exists — "nope" is unknown/hidden.
    const projects = [makeProject({})];

    let currentPath = "";
    const Probe = () => {
      currentPath = useLocation().pathname;
      return null;
    };

    render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/project/nope"] },
        createElement(
          Routes,
          null,
          createElement(
            Route,
            {
              path: "/project/:projectId",
              element: createElement(
                "div",
                null,
                createElement(Probe),
                createElement(TestHarness, { sessions: [], projects }),
              ),
            },
          ),
          createElement(Route, { path: "/", element: createElement(Probe) }),
        ),
      ),
    );

    // Regression: the read effect redirects to "/" for the unknown project, but
    // a same-tick write effect reading the still-stale store (activeDirectContextId
    // === "p1") used to navigate straight back to /project/p1 — last write wins.
    // The skip flag makes the write effect bail that tick, so we end at "/".
    await waitFor(() => {
      expect(currentPath).toBe("/");
    });

    // Give any spurious bounce a chance to happen; we must STAY on "/".
    await new Promise((r) => setTimeout(r, 50));
    expect(currentPath).toBe("/");
  });
});
