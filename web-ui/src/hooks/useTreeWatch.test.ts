import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { useTreeWatch } from "./useSubscription";

describe("useTreeWatch", () => {
  it("sends tree watch on mount and unwatch on unmount", async () => {
    const api = createMockApi();
    const send = vi.spyOn(api, "send");
    const { unmount } = renderHook(() => useTreeWatch(api, "wt-1"));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: "tree:watch",
        context: { kind: "worktree", id: "wt-1" },
        worktreeId: "wt-1",
      }),
    );
    unmount();
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: "tree:unwatch",
        context: { kind: "worktree", id: "wt-1" },
        worktreeId: "wt-1",
      }),
    );
  });

  // Direct sessions can now watch their tree — this was skipped before.
  it("watches project scope with no worktreeId alias", async () => {
    const api = createMockApi();
    const send = vi.spyOn(api, "send");
    renderHook(() => useTreeWatch(api, "proj-a", "project"));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: "tree:watch",
        context: { kind: "project", id: "proj-a" },
      }),
    );
  });

  it("bumps lastChanged on tree changed", () => {
    const api = createMockApi();
    const { result } = renderHook(() => useTreeWatch(api, "wt-1"));
    const before = result.current.lastChanged;
    act(() => {
      api.__test.emit({
        type: "tree:changed",
        context: { kind: "worktree", id: "wt-1" },
        worktreeId: "wt-1",
        path: "src",
        kind: "added",
      });
    });
    expect(result.current.lastChanged).toBeGreaterThan(before);
  });

  it("bumps lastChanged on a project-scoped tree event", () => {
    const api = createMockApi();
    const { result } = renderHook(() => useTreeWatch(api, "proj-a", "project"));
    const before = result.current.lastChanged;
    act(() => {
      api.__test.emit({
        type: "tree:changed",
        context: { kind: "project", id: "proj-a" },
        path: "docs",
        kind: "added",
      });
    });
    expect(result.current.lastChanged).toBeGreaterThan(before);
  });
});
