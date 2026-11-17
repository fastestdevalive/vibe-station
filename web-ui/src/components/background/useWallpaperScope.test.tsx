import type { ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { __resetBackgroundStoreForTests, getBackgroundStore } from "./backgroundStore";
import { useWallpaperScope } from "./useWallpaperScope";

function session(partial: Partial<Session> & { id: string }): Session {
  return {
    worktreeId: null,
    projectId: null,
    modeId: null,
    type: "agent",
    isMain: false,
    state: "idle",
    lifecycleState: "idle",
    tmuxName: `tmux-${partial.id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  } as Session;
}

function wrapper(entry: string) {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter>
  );
}

function scopeAt(entry: string) {
  return renderHook(() => useWallpaperScope(), { wrapper: wrapper(entry) }).result.current;
}

beforeEach(() => {
  __resetBackgroundStoreForTests();
  useServerStore.setState({
    sessions: [
      session({ id: "s1", projectId: "p1" }),
      session({ id: "d1", projectId: "p1" }),
      session({ id: "d2", projectId: "p1", worktreeId: "w1" }),
    ],
  });
});

afterEach(() => {
  __resetBackgroundStoreForTests();
  useServerStore.setState({ sessions: [] });
  vi.restoreAllMocks();
});

describe("useWallpaperScope route table", () => {
  it.each([
    ["/", { t: "app" }, "session"],
    ["/settings/x", { t: "app" }, "session"],
    ["/worktree/w1/s1", { t: "scope", scope: "worktree:w1" }, "session"],
    ["/project/p1", { t: "scope", scope: "project:p1" }, "session"],
    ["/project/p1/s1", { t: "scope", scope: "project:p1" }, "session"],
    ["/session/s1", { t: "scope", scope: "project:p1" }, "session"],
    ["/workspaces/x", { t: "app" }, "session"],
  ])("%s", (entry, kind, view) => {
    const scope = scopeAt(entry);
    expect(scope.kind).toEqual(kind);
    expect(scope.view).toBe(view);
    expect(scope.draftId).toBeUndefined();
  });

  it("/worktree/:wtId is a session view once the worktree has a session (main session URL has no id)", () => {
    useServerStore.setState({ sessions: [session({ id: "s0", worktreeId: "w1", isMain: true })] });
    const scope = scopeAt("/worktree/w1");
    expect(scope.kind).toEqual({ t: "scope", scope: "worktree:w1" });
    expect(scope.view).toBe("session");
  });

  it("/project/:projectId is a session view even when the project has no direct session (its agents live in worktrees)", () => {
    useServerStore.setState({ sessions: [session({ id: "d2", projectId: "p1", worktreeId: "w1" })] });
    const scope = scopeAt("/project/p1");
    expect(scope.kind).toEqual({ t: "scope", scope: "project:p1" });
    expect(scope.view).toBe("session");
  });

  it("/worktree/:wtId is a session view even before it has a session", () => {
    useServerStore.setState({ sessions: [session({ id: "s1", projectId: "p1" })] });
    const scope = scopeAt("/worktree/w1");
    expect(scope.kind).toEqual({ t: "scope", scope: "worktree:w1" });
    expect(scope.view).toBe("session");
  });

  it("/draft/new is a brand-new draft (no worktree scope)", () => {
    const scope = scopeAt("/draft/new");
    expect(scope.kind).toEqual({ t: "draft", ownId: null });
    expect(scope.draftId).toBe("new");
    expect(scope.view).toBe("empty");
  });

  it("/draft/:id for a draft outside any worktree claims its own wallpaper", () => {
    const scope = scopeAt("/draft/d1");
    expect(scope.kind).toEqual({ t: "draft", ownId: null });
    expect(scope.draftId).toBe("d1");
    expect(scope.view).toBe("empty");
  });

  it("/draft/:id for a tab draft follows its worktree", () => {
    const scope = scopeAt("/draft/d2");
    expect(scope.kind).toEqual({ t: "draft", ownId: null, tabScope: "worktree:w1" });
    expect(scope.draftId).toBe("d2");
  });

  it("reads the stored own ids without rewriting them", () => {
    const ids = ["wp-001", "wp-002", "wp-003"];
    const own = getBackgroundStore().draftWallpaperFor("new", ids);
    const scope = scopeAt("/draft/new");
    expect(scope.kind).toEqual({ t: "draft", ownId: own });
  });

  it("a direct session with no project falls back to the app background", () => {
    useServerStore.setState({ sessions: [session({ id: "orphan" })] });
    expect(scopeAt("/session/orphan").kind).toEqual({ t: "app" });
  });

  it("an unknown session id falls back to the app background", () => {
    expect(scopeAt("/session/missing").kind).toEqual({ t: "app" });
  });

  it("does not write the store during render", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    scopeAt("/worktree/w1/s1");
    expect(setItem).not.toHaveBeenCalled();
  });
});
