import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { useTreeWatch, WATCH_COALESCE_MS } from "./useSubscription";

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

  it("coalesces a burst of tree changed events into one leading and one trailing bump", () => {
    // The daemon sends one `tree:changed` per changed path; each bump refetches
    // file body, diff, gutter, tree and changed paths in every consumer.
    vi.useFakeTimers();
    try {
      const api = createMockApi();
      const seen = new Set<number>();
      const { result } = renderHook(() => {
        const r = useTreeWatch(api, "wt-1");
        seen.add(r.lastChanged);
        return r;
      });
      const emit = () =>
        act(() => {
          api.__test.emit({ type: "tree:changed", worktreeId: "wt-1", path: "", kind: "added" });
        });
      for (let i = 0; i < 200; i++) {
        emit();
        act(() => {
          vi.advanceTimersByTime(1);
        });
      }
      // 200 events over 200 ms: the initial 0, the leading bump, nothing else yet.
      expect(seen.size).toBe(2);
      const leading = result.current.lastChanged;
      act(() => {
        vi.advanceTimersByTime(WATCH_COALESCE_MS);
      });
      expect(result.current.lastChanged).toBeGreaterThan(leading);
      expect(seen.size).toBe(3);
      // Quiet again: the next event bumps immediately.
      act(() => {
        vi.advanceTimersByTime(WATCH_COALESCE_MS);
      });
      const before = result.current.lastChanged;
      emit();
      expect(result.current.lastChanged).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends tree watch with scope=project for project scope", async () => {
    const api = createMockApi();
    const send = vi.spyOn(api, "send");
    const { unmount } = renderHook(() => useTreeWatch(api, "proj1", "project"));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({ type: "tree:watch", worktreeId: "proj1", scope: "project" }),
    );
    unmount();
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({ type: "tree:unwatch", worktreeId: "proj1", scope: "project" }),
    );
  });
});
