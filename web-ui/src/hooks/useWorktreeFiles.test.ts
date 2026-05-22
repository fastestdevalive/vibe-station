import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { useWorktreeFiles, _clearWorktreeFilesCacheForTest } from "./useWorktreeFiles";

describe("useWorktreeFiles", () => {
  beforeEach(() => {
    _clearWorktreeFilesCacheForTest();
  });

  it("fetches file list on mount and exposes it", async () => {
    const api = createMockApi();
    const { result } = renderHook(() => useWorktreeFiles(api, "wt-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.files.length).toBeGreaterThan(0);
    expect(result.current.error).toBeNull();
  });

  it("returns cached list immediately on second mount (no flicker)", async () => {
    const api = createMockApi();
    const fileList = vi.spyOn(api, "fileList");

    // First mount populates the cache.
    const first = renderHook(() => useWorktreeFiles(api, "wt-1"));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    first.unmount();
    expect(fileList).toHaveBeenCalledTimes(1);

    // Second mount: returns cached list synchronously, no fresh fetch.
    const second = renderHook(() => useWorktreeFiles(api, "wt-1"));
    expect(second.result.current.loading).toBe(false);
    expect(second.result.current.files.length).toBeGreaterThan(0);
    // No second call should have been made (cache was fresh, not stale).
    expect(fileList).toHaveBeenCalledTimes(1);
  });

  it("refetches in background on tree:changed (stale-while-revalidate)", async () => {
    const api = createMockApi();
    const fileList = vi.spyOn(api, "fileList");

    const { result } = renderHook(() => useWorktreeFiles(api, "wt-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fileList).toHaveBeenCalledTimes(1);
    const filesBefore = result.current.files;

    act(() => {
      api.__test.emit({
        type: "tree:changed",
        worktreeId: "wt-1",
        path: "src",
        kind: "added",
      });
    });

    // Background refetch should fire — but the user still sees the old
    // list during the refetch (stale-while-revalidate).
    await waitFor(() => expect(fileList).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(result.current.files).toEqual(filesBefore);
  });

  it("coalesces bursts of tree:changed events into a single refetch", async () => {
    const api = createMockApi();
    const fileList = vi.spyOn(api, "fileList");

    const { result } = renderHook(() => useWorktreeFiles(api, "wt-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fileList).toHaveBeenCalledTimes(1);

    // Emit a flurry of 20 changes in the same tick — the storm we see on
    // watch startup or during bulk agent writes.
    act(() => {
      for (let i = 0; i < 20; i++) {
        api.__test.emit({
          type: "tree:changed",
          worktreeId: "wt-1",
          path: `src/file${i}.ts`,
          kind: "added",
        });
      }
    });

    // Even after the debounce settles, only one extra refetch should fire.
    await waitFor(() => expect(fileList).toHaveBeenCalledTimes(2), { timeout: 2000 });
    // Wait a bit more to be sure no late refetches sneak in.
    await new Promise((r) => setTimeout(r, 600));
    expect(fileList).toHaveBeenCalledTimes(2);
  });

  it("returns empty state when worktreeId is null", () => {
    const api = createMockApi();
    const { result } = renderHook(() => useWorktreeFiles(api, null));
    expect(result.current.loading).toBe(false);
    expect(result.current.files).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("surfaces errors", async () => {
    const api = createMockApi();
    vi.spyOn(api, "fileList").mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useWorktreeFiles(api, "wt-1"));
    await waitFor(() => expect(result.current.error).toBe("boom"));
    expect(result.current.loading).toBe(false);
  });
});
