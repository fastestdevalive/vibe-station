import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { useFileWatch } from "./useSubscription";

describe("useFileWatch", () => {
  it("sends file watch on mount and unwatch on unmount", async () => {
    const api = createMockApi();
    const send = vi.spyOn(api, "send");
    const { unmount } = renderHook(() => useFileWatch(api, "wt-1", "README.md"));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: "file:watch",
        context: { kind: "worktree", id: "wt-1" },
        // Legacy alias still sent for worktree scope so an older daemon copes.
        worktreeId: "wt-1",
        path: "README.md",
      }),
    );
    unmount();
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: "file:unwatch",
        context: { kind: "worktree", id: "wt-1" },
        worktreeId: "wt-1",
        path: "README.md",
      }),
    );
  });

  /**
   * Project (direct-session) scope used to be skipped entirely — the daemon
   * couldn't express a non-worktree watch, so the open file and file tree of a
   * direct session never live-updated.
   */
  it("watches project scope too, with no worktreeId alias", async () => {
    const api = createMockApi();
    const send = vi.spyOn(api, "send");
    renderHook(() => useFileWatch(api, "proj-a", "docs/plan.md", "project"));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: "file:watch",
        context: { kind: "project", id: "proj-a" },
        path: "docs/plan.md",
      }),
    );
  });

  it("bumps lastChanged on matching file events", () => {
    const api = createMockApi();
    const { result } = renderHook(() => useFileWatch(api, "wt-1", "README.md"));
    const before = result.current.lastChanged;
    act(() => {
      api.__test.emit({
        type: "file:changed",
        context: { kind: "worktree", id: "wt-1" },
        worktreeId: "wt-1",
        path: "README.md",
      });
    });
    expect(result.current.lastChanged).toBeGreaterThan(before);
  });

  it("bumps lastChanged on a project-scoped event", () => {
    const api = createMockApi();
    const { result } = renderHook(() => useFileWatch(api, "proj-a", "docs/plan.md", "project"));
    const before = result.current.lastChanged;
    act(() => {
      api.__test.emit({
        type: "file:changed",
        context: { kind: "project", id: "proj-a" },
        path: "docs/plan.md",
      });
    });
    expect(result.current.lastChanged).toBeGreaterThan(before);
  });

  it("ignores a worktree event with the same id when watching project scope", () => {
    const api = createMockApi();
    const { result } = renderHook(() => useFileWatch(api, "shared-id", "f.md", "project"));
    const before = result.current.lastChanged;
    act(() => {
      api.__test.emit({
        type: "file:changed",
        context: { kind: "worktree", id: "shared-id" },
        worktreeId: "shared-id",
        path: "f.md",
      });
    });
    expect(result.current.lastChanged).toBe(before);
  });

  /** Back-compat: a daemon predating `context` emits worktreeId only. */
  it("still matches a legacy event that carries only worktreeId", () => {
    const api = createMockApi();
    const { result } = renderHook(() => useFileWatch(api, "wt-1", "README.md"));
    const before = result.current.lastChanged;
    act(() => {
      api.__test.emit({ type: "file:changed", worktreeId: "wt-1", path: "README.md" });
    });
    expect(result.current.lastChanged).toBeGreaterThan(before);
  });
});
