import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { useFileSearch } from "./useFileSearch";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Advance the 60ms debounce and flush any microtasks the fired request schedules. */
async function flushDebounce(ms = 60) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useFileSearch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("4.T1: worktree scope debounces — rapid query changes fire one call with the last value", async () => {
    const api = createMockApi();
    const fileSearch = vi
      .spyOn(api, "fileSearch")
      .mockResolvedValue({ files: [], truncated: false });

    const { result, rerender } = renderHook(
      ({ q }) => useFileSearch(api, "wt-1", q, "worktree"),
      { initialProps: { q: "a" } },
    );

    rerender({ q: "ab" });
    rerender({ q: "abc" });
    await flushDebounce();

    expect(fileSearch).toHaveBeenCalledTimes(1);
    expect(fileSearch).toHaveBeenCalledWith("wt-1", "abc", 50, expect.any(AbortSignal), "worktree");
    expect(result.current.loading).toBe(false);
  });

  it("4.T2: abort-on-supersede — a late-resolving first call does not clobber the second", async () => {
    const api = createMockApi();
    const first = deferred<{ files: string[]; truncated: boolean }>();
    const second = deferred<{ files: string[]; truncated: boolean }>();
    const fileSearch = vi.spyOn(api, "fileSearch").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result, rerender } = renderHook(
      ({ q }) => useFileSearch(api, "wt-1", q, "worktree"),
      { initialProps: { q: "alpha" } },
    );

    // First query fires the first (slow) request.
    await flushDebounce();
    expect(fileSearch).toHaveBeenCalledTimes(1);

    // Second query fires the second (fast) request.
    rerender({ q: "beta" });
    await flushDebounce();
    expect(fileSearch).toHaveBeenCalledTimes(2);

    // The SECOND call resolves first.
    await act(async () => {
      second.resolve({ files: ["beta-result.ts"], truncated: false });
    });
    expect(result.current.files).toEqual(["beta-result.ts"]);
    expect(result.current.error).toBeNull();

    // The FIRST call resolves late — must not clobber the newer state.
    await act(async () => {
      first.resolve({ files: ["alpha-result.ts"], truncated: false });
    });
    expect(result.current.files).toEqual(["beta-result.ts"]);
  });

  it("4.T3: project scope calls fileSearch (..., 'project'), never fileList", async () => {
    const api = createMockApi();
    const fileSearch = vi
      .spyOn(api, "fileSearch")
      .mockResolvedValue({ files: ["src/main.rs", "src/helper/main.ts"], truncated: false });
    const fileList = vi.spyOn(api, "fileList");

    const { result } = renderHook(() => useFileSearch(api, "id", "main", "project"));
    await flushDebounce();

    expect(fileSearch).toHaveBeenCalledWith("id", "main", 50, expect.any(AbortSignal), "project");
    expect(fileList).not.toHaveBeenCalled();
    expect(result.current.files).toEqual(["src/main.rs", "src/helper/main.ts"]);
  });

  it("4.T4a: superseded-error — a late-rejecting older call does not clobber newer state", async () => {
    const api = createMockApi();
    const first = deferred<{ files: string[]; truncated: boolean }>();
    const second = deferred<{ files: string[]; truncated: boolean }>();
    vi.spyOn(api, "fileSearch").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result, rerender } = renderHook(
      ({ q }) => useFileSearch(api, "wt-1", q, "worktree"),
      { initialProps: { q: "alpha" } },
    );

    await flushDebounce();
    rerender({ q: "beta" });
    await flushDebounce();

    // Newer call succeeds first.
    await act(async () => {
      second.resolve({ files: ["beta.ts"], truncated: false });
    });
    expect(result.current.files).toEqual(["beta.ts"]);
    expect(result.current.error).toBeNull();

    // Older call rejects late — must NOT set error or clear the newer files.
    await act(async () => {
      first.reject(new Error("boom"));
    });
    expect(result.current.files).toEqual(["beta.ts"]);
    expect(result.current.error).toBeNull();
  });

  it("4.T4b: genuine-error — a non-superseded Error sets error, clears files, stops loading", async () => {
    const api = createMockApi();
    vi.spyOn(api, "fileSearch").mockRejectedValueOnce(new Error("boom"));

    const { result } = renderHook(() => useFileSearch(api, "wt-1", "q", "worktree"));
    await flushDebounce();

    expect(result.current.error).toBe("boom");
    expect(result.current.loading).toBe(false);
    expect(result.current.files).toEqual([]);
  });

  it("returns empty state and issues no request when worktreeId is null", async () => {
    const api = createMockApi();
    const fileSearch = vi.spyOn(api, "fileSearch").mockResolvedValue({ files: [], truncated: false });

    const { result } = renderHook(() => useFileSearch(api, null, "q", "worktree"));
    expect(result.current).toEqual({ files: [], truncated: false, indexing: false, slowIndexing: false, loading: false, error: null });

    await flushDebounce(200);
    expect(fileSearch).not.toHaveBeenCalled();
  });

  it("ignores AbortError as a non-error (no error set, no files cleared)", async () => {
    const api = createMockApi();
    vi.spyOn(api, "fileSearch").mockRejectedValueOnce(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    );

    const { result } = renderHook(() => useFileSearch(api, "wt-1", "q", "worktree"));
    await flushDebounce();

    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  describe("indexing polling", () => {
    it("re-queries every ~500ms while indexing, stops once done", async () => {
      const api = createMockApi();
      const fileSearch = vi
        .spyOn(api, "fileSearch")
        .mockResolvedValueOnce({ files: [], truncated: false, indexing: true })
        .mockResolvedValueOnce({ files: [], truncated: false, indexing: true })
        .mockResolvedValue({ files: ["a.ts"], truncated: false, indexing: false });

      const { result } = renderHook(() => useFileSearch(api, "wt-1", "a", "worktree"));
      await flushDebounce();
      expect(fileSearch).toHaveBeenCalledTimes(1);
      expect(result.current.indexing).toBe(true);

      await flushDebounce(500);
      expect(fileSearch).toHaveBeenCalledTimes(2);
      expect(fileSearch.mock.calls[1]![1]).toBe("a");
      await flushDebounce(500);
      expect(fileSearch).toHaveBeenCalledTimes(3);
      expect(result.current.indexing).toBe(false);
      expect(result.current.files).toEqual(["a.ts"]);

      await flushDebounce(5000);
      expect(fileSearch).toHaveBeenCalledTimes(3);
    });

    it("stops polling on unmount", async () => {
      const api = createMockApi();
      const fileSearch = vi
        .spyOn(api, "fileSearch")
        .mockResolvedValue({ files: [], truncated: false, indexing: true });
      const { unmount } = renderHook(() => useFileSearch(api, "wt-1", "a", "worktree"));
      await flushDebounce();
      expect(fileSearch).toHaveBeenCalledTimes(1);
      unmount();
      await flushDebounce(5000);
      expect(fileSearch).toHaveBeenCalledTimes(1);
    });

    it("stops polling when the query changes (new query starts its own cycle)", async () => {
      const api = createMockApi();
      const fileSearch = vi
        .spyOn(api, "fileSearch")
        .mockResolvedValue({ files: [], truncated: false, indexing: true });
      const { rerender } = renderHook(({ q }) => useFileSearch(api, "wt-1", q, "worktree"), {
        initialProps: { q: "a" },
      });
      await flushDebounce();
      rerender({ q: "b" });
      await flushDebounce();
      fileSearch.mockClear();
      await flushDebounce(500);
      expect(fileSearch.mock.calls.every((c) => c[1] === "b")).toBe(true);
      expect(fileSearch).toHaveBeenCalledTimes(1);
    });

    it("never gives up: after 30s it flags slowIndexing and polls every 2s, then clears when done", async () => {
      const api = createMockApi();
      const fileSearch = vi
        .spyOn(api, "fileSearch")
        .mockResolvedValue({ files: [], truncated: false, indexing: true });
      const { result } = renderHook(() => useFileSearch(api, "wt-1", "a", "worktree"));
      await flushDebounce(60);
      expect(result.current.slowIndexing).toBe(false);
      await flushDebounce(31_000);
      expect(result.current.indexing).toBe(true);
      expect(result.current.slowIndexing).toBe(true);
      // Slow cadence: ~2s between polls, still going well past 30s.
      fileSearch.mockClear();
      await flushDebounce(10_000);
      expect(fileSearch.mock.calls.length).toBeGreaterThanOrEqual(4);
      expect(fileSearch.mock.calls.length).toBeLessThanOrEqual(6);
      expect(result.current.indexing).toBe(true);

      fileSearch.mockResolvedValue({ files: ["a.ts"], truncated: false, indexing: false });
      await flushDebounce(2_500);
      expect(result.current.indexing).toBe(false);
      expect(result.current.slowIndexing).toBe(false);
      expect(result.current.files).toEqual(["a.ts"]);
      fileSearch.mockClear();
      await flushDebounce(10_000);
      expect(fileSearch).not.toHaveBeenCalled();
    });

    it("stops slow polling on unmount and resets slowIndexing on query change", async () => {
      const api = createMockApi();
      const fileSearch = vi
        .spyOn(api, "fileSearch")
        .mockResolvedValue({ files: [], truncated: false, indexing: true });
      const { result, rerender, unmount } = renderHook(({ q }) => useFileSearch(api, "wt-1", q, "worktree"), {
        initialProps: { q: "a" },
      });
      await flushDebounce(60);
      await flushDebounce(32_000);
      expect(result.current.slowIndexing).toBe(true);
      rerender({ q: "b" });
      await flushDebounce(100);
      expect(result.current.slowIndexing).toBe(false);
      unmount();
      fileSearch.mockClear();
      await flushDebounce(10_000);
      expect(fileSearch).not.toHaveBeenCalled();
    });
  });
});
