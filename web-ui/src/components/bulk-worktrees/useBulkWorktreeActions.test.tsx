import type { ReactNode } from "react";
import { act, renderHook, screen, waitFor } from "@testing-library/react";
import { BrowserRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Worktree } from "@/api/types";
import { createMockApi } from "@/api/mock";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useBulkWorktrees } from "./useBulkWorktrees";
import { useBulkWorktreeActions } from "./useBulkWorktreeActions";

function worktree(id: string): Worktree {
  return {
    id,
    projectId: "proj-a",
    branch: id,
    baseBranch: "main",
    baseSha: "sha",
    createdAt: "2026-01-01T00:00:00.000Z",
    pinnedAt: null,
    hiddenAt: null,
    lspEnabled: false,
  };
}

function seedWorktrees(...ids: string[]) {
  useServerStore.setState({
    projects: [],
    worktrees: ids.map(worktree),
    sessions: [],
    loaded: true,
  });
}

function PathSpy() {
  const location = useLocation();
  return <div data-testid="path">{location.pathname}</div>;
}

/** BrowserRouter (not MemoryRouter) because Decision 8's guard reads the real
 *  `window.location.pathname`; jsdom's history is seeded per test below. */
function wrapper({ children }: { children: ReactNode }) {
  return (
    <BrowserRouter>
      {children}
      <PathSpy />
    </BrowserRouter>
  );
}

function currentStatuses(): string[] {
  return useBulkWorktrees.getState().job?.items.map((item) => item.status) ?? [];
}

beforeEach(() => {
  window.history.replaceState({}, "", "/worktree/wt-1");
  useBulkWorktrees.setState({ mode: null, selected: new Set(), job: null });
  seedWorktrees();
  useWorkspaceStore.setState({
    activeProjectId: null,
    activeWorktreeId: null,
    activeSessionId: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useBulkWorktreeActions", () => {
  it("delete calls api.deleteWorktree once per id and marks every item done", async () => {
    const api = createMockApi();
    const deleteSpy = vi.spyOn(api, "deleteWorktree");
    seedWorktrees("wt-1", "wt-2");
    const { result } = renderHook(() => useBulkWorktreeActions(api), { wrapper });

    act(() => {
      result.current.start("delete", ["wt-1", "wt-2"]);
    });
    await waitFor(() => expect(useBulkWorktrees.getState().job?.finished).toBe(true));

    expect(deleteSpy).toHaveBeenCalledTimes(2);
    expect(deleteSpy.mock.calls.map((call) => call[0])).toEqual(["wt-1", "wt-2"]);
    expect(currentStatuses()).toEqual(["done", "done"]);
  });

  it("archive calls api.hideWorktree and exits select mode", async () => {
    const api = createMockApi();
    const hideSpy = vi.spyOn(api, "hideWorktree");
    seedWorktrees("wt-1", "wt-2");
    useBulkWorktrees.getState().enter("archive");
    const { result } = renderHook(() => useBulkWorktreeActions(api), { wrapper });

    act(() => {
      result.current.start("archive", ["wt-1", "wt-2"]);
    });
    await waitFor(() => expect(useBulkWorktrees.getState().job?.finished).toBe(true));

    expect(hideSpy).toHaveBeenCalledTimes(2);
    expect(useBulkWorktrees.getState().job?.action).toBe("archive");
    expect(currentStatuses()).toEqual(["done", "done"]);
    expect(useBulkWorktrees.getState().mode).toBeNull();
  });

  it("deleting the open worktree clears the workspace selection and returns to the dashboard", async () => {
    const api = createMockApi();
    seedWorktrees("wt-1");
    useWorkspaceStore.setState({ activeProjectId: "proj-a", activeWorktreeId: "wt-1" });
    const { result } = renderHook(() => useBulkWorktreeActions(api), { wrapper });

    act(() => {
      result.current.start("delete", ["wt-1"]);
    });
    await waitFor(() => expect(useBulkWorktrees.getState().job?.finished).toBe(true));

    expect(useWorkspaceStore.getState().activeWorktreeId).toBeNull();
    expect(screen.getByTestId("path").textContent).toBe("/");
  });

  it("still returns to the dashboard when the url sync already cleared the open worktree", async () => {
    const api = createMockApi();
    seedWorktrees("wt-1");
    useWorkspaceStore.setState({ activeProjectId: "proj-a", activeWorktreeId: "wt-1" });
    const { result } = renderHook(() => useBulkWorktreeActions(api), { wrapper });
    // The server drops the worktree and useWorkspaceUrlSync rewrites the url
    // to a bare /worktree before the runner's onItemDone fires.
    vi.spyOn(api, "deleteWorktree").mockImplementationOnce(async () => {
      useWorkspaceStore.setState({ activeWorktreeId: null });
      window.history.replaceState(null, "", "/worktree");
      return { ok: true } as const;
    });

    act(() => {
      result.current.start("delete", ["wt-1"]);
    });
    await waitFor(() => expect(useBulkWorktrees.getState().job?.finished).toBe(true));

    expect(screen.getByTestId("path").textContent).toBe("/");
  });

  it("archiving the open worktree does not navigate", async () => {
    const api = createMockApi();
    seedWorktrees("wt-1");
    useWorkspaceStore.setState({ activeProjectId: "proj-a", activeWorktreeId: "wt-1" });
    const { result } = renderHook(() => useBulkWorktreeActions(api), { wrapper });

    act(() => {
      result.current.start("archive", ["wt-1"]);
    });
    await waitFor(() => expect(useBulkWorktrees.getState().job?.finished).toBe(true));

    expect(useWorkspaceStore.getState().activeWorktreeId).toBe("wt-1");
    expect(screen.getByTestId("path").textContent).toBe("/worktree/wt-1");
  });

  it("drops ids that are no longer in the server store", async () => {
    const api = createMockApi();
    const deleteSpy = vi.spyOn(api, "deleteWorktree");
    seedWorktrees("wt-1");
    const { result } = renderHook(() => useBulkWorktreeActions(api), { wrapper });

    act(() => {
      result.current.start("delete", ["wt-1", "ghost"]);
    });
    await waitFor(() => expect(useBulkWorktrees.getState().job?.finished).toBe(true));

    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy.mock.calls[0]?.[0]).toBe("wt-1");
    expect(useBulkWorktrees.getState().job?.items.map((item) => item.id)).toEqual(["wt-1"]);
  });

  it("dismiss clears the finished job", async () => {
    const api = createMockApi();
    const { result } = renderHook(() => useBulkWorktreeActions(api), { wrapper });

    useBulkWorktrees.getState().setJob({
      id: 1,
      action: "delete",
      items: [],
      finished: true,
      cancelRequested: false,
    });
    act(() => {
      result.current.dismiss();
    });

    expect(useBulkWorktrees.getState().job).toBeNull();
  });
});
