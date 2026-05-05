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
      expect(send).toHaveBeenCalledWith({ type: "file:watch", worktreeId: "wt-1", path: "README.md" }),
    );
    unmount();
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({ type: "file:unwatch", worktreeId: "wt-1", path: "README.md" }),
    );
  });

  it("bumps lastChanged on matching file events", () => {
    const api = createMockApi();
    const { result } = renderHook(() => useFileWatch(api, "wt-1", "README.md"));
    const before = result.current.lastChanged;
    act(() => {
      api.__test.emit({ type: "file:changed", worktreeId: "wt-1", path: "README.md" });
    });
    expect(result.current.lastChanged).toBeGreaterThan(before);
  });
});
