import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApiInstance } from "@/api";
import { useDirSuggestions } from "./useDirSuggestions";

function fakeApi(fsComplete: (path: string) => Promise<unknown>): ApiInstance {
  return { fsComplete } as unknown as ApiInstance;
}

describe("useDirSuggestions", () => {
  it("settled_false_until_first_response_and_after_reset", async () => {
    const api = fakeApi(async () => ({ base: "/", entries: [{ name: "a", path: "/a" }], truncated: false }));
    const { result } = renderHook(() => useDirSuggestions(api));
    expect(result.current.settled).toBe(false);
    await act(async () => {
      await result.current.fetchSuggestions("/");
    });
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.suggestions).toHaveLength(1);
    await act(async () => {
      result.current.reset();
    });
    expect(result.current.settled).toBe(false);
  });

  it("listedFor_tracks_the_fetched_path_and_clears_on_reset", async () => {
    const api = fakeApi(async () => ({ base: "/", entries: [], truncated: false }));
    const { result } = renderHook(() => useDirSuggestions(api));
    expect(result.current.listedFor).toBeNull();
    await act(async () => {
      await result.current.fetchSuggestions("~/code/f");
    });
    expect(result.current.listedFor).toBe("~/code/f");
    await act(async () => {
      result.current.reset();
    });
    expect(result.current.listedFor).toBeNull();
  });

  it("stale_response_is_discarded", async () => {
    let resolveSlow: (v: unknown) => void = () => {};
    const api = fakeApi((path) =>
      path === "/slow"
        ? new Promise((r) => {
            resolveSlow = r;
          })
        : Promise.resolve({ base: "/", entries: [{ name: "fast", path: "/fast" }], truncated: false }),
    );
    const { result } = renderHook(() => useDirSuggestions(api));
    await act(async () => {
      void result.current.fetchSuggestions("/slow");
    });
    await act(async () => {
      await result.current.fetchSuggestions("/fast");
    });
    await act(async () => {
      resolveSlow({ base: "/", entries: [{ name: "slow", path: "/slow" }], truncated: false });
    });
    expect(result.current.suggestions.map((s) => s.name)).toEqual(["fast"]);
  });

  it("error_sets_message_and_settles", async () => {
    const api = fakeApi(async () => {
      throw new Error("boom");
    });
    const { result } = renderHook(() => useDirSuggestions(api));
    await act(async () => {
      await result.current.fetchSuggestions("/x");
    });
    expect(result.current.error).toBe("Failed to fetch directory suggestions");
    expect(result.current.settled).toBe(true);
    expect(result.current.suggestions).toEqual([]);
  });

  it("debounces scheduled fetches by default", async () => {
    vi.useFakeTimers();
    try {
      const fsComplete = vi.fn(async () => ({ base: "/", entries: [], truncated: false }));
      const { result } = renderHook(() => useDirSuggestions(fakeApi(fsComplete)));
      await act(async () => {
        result.current.scheduleFetch("/a/");
      });
      expect(fsComplete).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(150);
      });
      expect(fsComplete).toHaveBeenCalledWith("/a/");
    } finally {
      vi.useRealTimers();
    }
  });
});
