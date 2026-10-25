import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { Project, Session, SessionState, Worktree } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { worktreeLabel } from "@/lib/sessionLabel";
import { filterVisibleWorktrees, useVisibleWorktrees } from "./useVisibleWorktrees";

function project(id: string, name = id): Project {
  return {
    id,
    name,
    path: `/tmp/${id}`,
    prefix: id,
    isGit: true,
    defaultBranch: "main",
    createdAt: "2026-01-01T00:00:00.000Z",
    hidden: false,
    lspEnabled: false,
  };
}

function worktree(id: string, projectId: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    projectId,
    branch: id,
    baseBranch: "main",
    baseSha: "sha",
    createdAt: "2026-01-01T00:00:00.000Z",
    pinnedAt: null,
    hiddenAt: null,
    lspEnabled: false,
    ...overrides,
  };
}

function session(id: string, worktreeId: string | null, state: SessionState): Session {
  return {
    id,
    worktreeId,
    projectId: worktreeId ? "proj-a" : null,
    modeId: null,
    type: "agent",
    isMain: true,
    state,
    lifecycleState: state,
    tmuxName: id,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function seed(projects: Project[], worktrees: Worktree[], sessions: Session[]) {
  useServerStore.setState({ projects, worktrees, sessions, loaded: true });
}

beforeEach(() => {
  seed([], [], []);
  useWorkspaceStore.setState({ sessionStates: {}, hideInactiveWorktrees: false });
});

describe("useVisibleWorktrees", () => {
  it("applies hide-done, drops archived rows, and keeps exited visible", () => {
    const p = project("proj-a");
    seed(
      [p],
      [
        worktree("active", p.id),
        worktree("done", p.id),
        worktree("empty", p.id),
        worktree("exited", p.id),
        worktree("archived", p.id, { hiddenAt: "2026-01-02T00:00:00.000Z" }),
      ],
      [
        session("s-active", "active", "working"),
        session("s-done", "done", "done"),
        session("s-exited", "exited", "exited"),
      ],
    );
    useWorkspaceStore.setState({ hideInactiveWorktrees: true });

    const { result } = renderHook(() =>
      useVisibleWorktrees({
        projects: [p],
        hideInactiveWorktrees: true,
        trimmedQuery: "",
        projectDirectlyMatches: () => true,
        worktreeMatchesQuery: () => true,
      }),
    );

    expect(result.current[p.id]?.map((w) => w.id)).toEqual(["active", "exited"]);
  });

  it("applies the search predicate when the project name does not match", () => {
    const p = project("proj-a", "Proj A");
    seed(
      [p],
      [worktree("alpha-branch", p.id), worktree("beta-branch", p.id)],
      [session("s-alpha", "alpha-branch", "working"), session("s-beta", "beta-branch", "working")],
    );

    const { result } = renderHook(() =>
      useVisibleWorktrees({
        projects: [p],
        hideInactiveWorktrees: false,
        trimmedQuery: "alpha",
        projectDirectlyMatches: () => false,
        worktreeMatchesQuery: (w) => worktreeLabel(w).includes("alpha"),
      }),
    );

    expect(result.current[p.id]?.map((w) => w.id)).toEqual(["alpha-branch"]);
  });

  it("keeps every worktree of a project whose own name matches the query", () => {
    const p = project("proj-a", "Alpha");
    seed(
      [p],
      [worktree("one", p.id), worktree("two", p.id)],
      [session("s-one", "one", "working"), session("s-two", "two", "working")],
    );

    const { result } = renderHook(() =>
      useVisibleWorktrees({
        projects: [p],
        hideInactiveWorktrees: false,
        trimmedQuery: "alpha",
        projectDirectlyMatches: () => true,
        worktreeMatchesQuery: () => false,
      }),
    );

    expect(result.current[p.id]?.map((w) => w.id)).toEqual(["one", "two"]);
  });

  it("returns a list per project regardless of expansion state and never includes drafts", () => {
    const expanded = project("proj-a");
    const collapsed = project("proj-b");
    seed(
      [expanded, collapsed],
      [worktree("a1", expanded.id), worktree("b1", collapsed.id)],
      [
        session("s-a1", "a1", "working"),
        session("s-b1", "b1", "working"),
        // A worktree draft is a session, not a worktree — it can never appear here.
        session("draft-1", null, "drafting"),
      ],
    );

    const { result } = renderHook(() =>
      useVisibleWorktrees({
        projects: [expanded, collapsed],
        hideInactiveWorktrees: false,
        trimmedQuery: "",
        projectDirectlyMatches: () => true,
        worktreeMatchesQuery: () => true,
      }),
    );

    expect(result.current[expanded.id]?.map((w) => w.id)).toEqual(["a1"]);
    expect(result.current[collapsed.id]?.map((w) => w.id)).toEqual(["b1"]);
  });
});

describe("filterVisibleWorktrees", () => {
  const sessionsByWorktree: Record<string, Session[]> = {
    done: [session("s-done", "done", "done")],
    active: [session("s-active", "active", "working")],
  };
  const sessionStates: Record<string, SessionState> = {};
  const base = {
    sessionsByWorktree,
    sessionStates,
    worktreeMatchesQuery: () => true,
  };

  it("returns everything when neither hide-done nor a search is active", () => {
    const list = [worktree("done", "p"), worktree("active", "p")];
    expect(
      filterVisibleWorktrees(list, {
        ...base,
        hideInactiveWorktrees: false,
        queryActive: false,
        projectMatches: false,
      }),
    ).toEqual(list);
  });

  it("hides inactive worktrees when hide-done is on", () => {
    const list = [worktree("done", "p"), worktree("active", "p")];
    expect(
      filterVisibleWorktrees(list, {
        ...base,
        hideInactiveWorktrees: true,
        queryActive: false,
        projectMatches: false,
      }).map((w) => w.id),
    ).toEqual(["active"]);
  });
});
