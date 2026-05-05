import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { useTreeWatch } from "./useSubscription";

describe("useTreeWatch", () => {
  it("sends tree watch on mount and unwatch on unmount", async () => {
    const api = createMockApi();
    const send = vi.spyOn(api, "send");
    const { unmount } = renderHook(() => useTreeWatch(api, "wt-1"));
    await waitFor(() => expect(send).toHaveBeenCalledWith({ type: "tree:watch", worktreeId: "wt-1" }));
    unmount();
    await waitFor(() => expect(send).toHaveBeenCalledWith({ type: "tree:unwatch", worktreeId: "wt-1" }));
  });

  it("bumps lastChanged on tree changed", () => {
    const api = createMockApi();
    const { result } = renderHook(() => useTreeWatch(api, "wt-1"));
    const before = result.current.lastChanged;
    act(() => {
      api.__test.emit({
        type: "tree:changed",
        worktreeId: "wt-1",
        path: "src",
        kind: "added",
      });
    });
    expect(result.current.lastChanged).toBeGreaterThan(before);
  });
});
