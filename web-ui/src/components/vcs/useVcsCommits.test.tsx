import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ApiInstance } from "@/api";
import type { CommitLogEntry } from "@/api/types";
import { resetVcsCacheForTests, useVcsCacheStore, vcsKey } from "./vcsCacheStore";
import { resetVcsRevalidationForTests, useVcsCommits } from "./useVcsCommits";

const KEY = vcsKey("worktree", "wt1");
const FULL = (n: number) => n.toString(16).padStart(40, "0");
function commit(n: number): CommitLogEntry {
  return {
    sha: FULL(n),
    shortSha: FULL(n).slice(0, 7),
    authorName: "A",
    authorEmail: "a@example.com",
    date: "2026-01-01T00:00:00Z",
    subject: `c${n}`,
    body: `c${n}`,
    insertions: 1,
    deletions: 0,
    hasBinaryChanges: false,
    isOnBranch: true,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeApi(listCommits: ApiInstance["listCommits"]) {
  const focusWorktree = vi.fn().mockResolvedValue(undefined);
  const api = { listCommits, focusWorktree } as unknown as ApiInstance;
  return { api, focusWorktree };
}

describe("useVcsCommits", () => {
  beforeEach(() => {
    resetVcsCacheForTests();
    resetVcsRevalidationForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a second mount paints cached rows synchronously (no loading flash) and then revalidates", async () => {
    useVcsCacheStore.getState().replace(KEY, [commit(1)], 50);
    const d = deferred<CommitLogEntry[]>();
    const listCommits = vi.fn().mockReturnValue(d.promise);
    const { api } = makeApi(listCommits as unknown as ApiInstance["listCommits"]);

    const { result } = renderHook(() => useVcsCommits({ api, id: "wt1", scope: "worktree" }));
    expect(result.current.status).toBe("ready");
    expect(result.current.commits.map((c) => c.sha)).toEqual([FULL(1)]);
    expect(listCommits).toHaveBeenCalledWith("wt1", 51, "worktree", undefined);

    await act(async () => {
      d.resolve([commit(1), commit(2)]);
      await d.promise;
    });
    expect(result.current.commits.map((c) => c.sha)).toEqual([FULL(1), FULL(2)]);
  });

  it("refreshing stays false for a 100 ms revalidate and becomes true after 300 ms", async () => {
    vi.useFakeTimers();
    useVcsCacheStore.getState().replace(KEY, [commit(1)], 50);
    const d = deferred<CommitLogEntry[]>();
    const { api } = makeApi(vi.fn().mockReturnValue(d.promise) as unknown as ApiInstance["listCommits"]);
    const { result } = renderHook(() => useVcsCommits({ api, id: "wt1", scope: "worktree" }));

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.refreshing).toBe(false);
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current.refreshing).toBe(true);
    await act(async () => {
      d.resolve([commit(1)]);
      await d.promise;
    });
    expect(result.current.refreshing).toBe(false);
  });

  it("a failed revalidation after success keeps the rows and exposes the error", async () => {
    useVcsCacheStore.getState().replace(KEY, [commit(1)], 50);
    const { api } = makeApi(vi.fn().mockRejectedValue(new Error("offline")) as unknown as ApiInstance["listCommits"]);
    const { result } = renderHook(() => useVcsCommits({ api, id: "wt1", scope: "worktree" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.commits).toHaveLength(1);
    expect(result.current.error).toBe("offline");
    expect(result.current.status).toBe("ready");
  });

  it("a cold failure leaves status error", async () => {
    const { api } = makeApi(vi.fn().mockRejectedValue(new Error("nope")) as unknown as ApiInstance["listCommits"]);
    const { result } = renderHook(() => useVcsCommits({ api, id: "wt1", scope: "worktree" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("nope");
  });

  it("focusWorktree runs once on the first mount per worktree, not on remount, and on every refresh()", () => {
    const { api, focusWorktree } = makeApi(
      vi.fn().mockResolvedValue([commit(1)]) as unknown as ApiInstance["listCommits"],
    );
    const first = renderHook(() => useVcsCommits({ api, id: "wt1", scope: "worktree" }));
    expect(focusWorktree).toHaveBeenCalledTimes(1);
    first.unmount();
    renderHook(() => useVcsCommits({ api, id: "wt1", scope: "worktree" }));
    expect(focusWorktree).toHaveBeenCalledTimes(1);
    const again = renderHook(() => useVcsCommits({ api, id: "wt1", scope: "worktree" }));
    act(() => again.result.current.refresh());
    expect(focusWorktree).toHaveBeenCalledTimes(2);
  });

  it("never calls focusWorktree in project scope", () => {
    const { api, focusWorktree } = makeApi(
      vi.fn().mockResolvedValue([commit(1)]) as unknown as ApiInstance["listCommits"],
    );
    const { result } = renderHook(() => useVcsCommits({ api, id: "p1", scope: "project" }));
    act(() => result.current.refresh());
    expect(focusWorktree).not.toHaveBeenCalled();
  });
});
