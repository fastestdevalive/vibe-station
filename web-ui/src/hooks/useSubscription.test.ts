import { renderHook, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createMockApi } from "@/api/mock";
import { useSubscription, useSessionOutput, useWorktreeDiffStats } from "./useSubscription";
import { useWorkspaceStore } from "./useStore";

describe("useSubscription", () => {
  it("calls subscribe and cleanup on unmount", async () => {
    const api = createMockApi();
    const unsub = vi.spyOn(api, "subscribe");
    const { unmount } = renderHook(() => useSubscription(["sess-main"], api));
    await waitFor(() => expect(unsub).toHaveBeenCalledWith(["sess-main"]));
    unmount();
    expect(unsub).toHaveBeenCalled();
  });
});

/**
 * The Resume banner is driven by this hook's sessionState. It used to be set by
 * regex-matching session:error messages, which latched "exited" onto healthy
 * sessions — "Session not found" (direct sessions were invisible to the WS
 * lookup) and a non-zero `tmux attach-session` exit both matched while the
 * agent was alive. The daemon now classifies errors via `reason`; only "gone"
 * means exited.
 */
describe("useSessionOutput — exit inference", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ sessionStates: { "sess-1": "idle" } });
  });

  it('flips to exited on session:error with reason "gone"', async () => {
    const api = createMockApi();
    const { result } = renderHook(() => useSessionOutput(api, "sess-1"));

    act(() => {
      api.__test.emit({
        type: "session:error",
        sessionId: "sess-1",
        reason: "gone",
        message: "Session 'sess-1' not found",
      });
    });

    await waitFor(() => expect(result.current.sessionState).toBe("exited"));
  });

  it('ignores reason "transient" even when the message says "exited"', async () => {
    const api = createMockApi();
    const { result } = renderHook(() => useSessionOutput(api, "sess-1"));

    act(() => {
      api.__test.emit({
        type: "session:error",
        sessionId: "sess-1",
        reason: "transient",
        // Wording the old regex matched on — must not flip state now.
        message: "tmux attach-session exited with code 1",
      });
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.sessionState).not.toBe("exited");
  });

  it("ignores an unclassified session:error (no reason)", async () => {
    const api = createMockApi();
    const { result } = renderHook(() => useSessionOutput(api, "sess-1"));

    act(() => {
      api.__test.emit({
        type: "session:error",
        sessionId: "sess-1",
        message: "Session 'sess-1' not found",
      });
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.sessionState).not.toBe("exited");
  });

  it('does not flip a session that is still spawning ("not_started")', async () => {
    useWorkspaceStore.setState({ sessionStates: { "sess-1": "not_started" } });
    const api = createMockApi();
    const { result } = renderHook(() => useSessionOutput(api, "sess-1"));

    act(() => {
      api.__test.emit({
        type: "session:error",
        sessionId: "sess-1",
        reason: "gone",
        message: "Session 'sess-1' not running",
      });
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.sessionState).not.toBe("exited");
  });
});

describe("useWorktreeDiffStats — batched poll (11.T1, Decision 11)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("batches one getDiffStat call per id per interval tick", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "getDiffStat").mockResolvedValue({ insertions: 3, deletions: 1 });

    const { result } = renderHook(() => useWorktreeDiffStats(api, ["wt-1", "wt-2"]));
    await act(async () => {
      await Promise.resolve();
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith("wt-1");
    expect(spy).toHaveBeenCalledWith("wt-2");
    expect(result.current["wt-1"]).toEqual({ insertions: 3, deletions: 1 });

    // Next tick (30s) — exactly one more call per id, not one per row/render.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("returns null for an id whose fetch is still in flight", async () => {
    const api = createMockApi();
    let resolveFetch: (v: { insertions: number; deletions: number }) => void = () => {};
    vi.spyOn(api, "getDiffStat").mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const { result } = renderHook(() => useWorktreeDiffStats(api, ["wt-1"]));
    expect(result.current["wt-1"]).toBeNull();

    await act(async () => {
      resolveFetch({ insertions: 2, deletions: 0 });
      await Promise.resolve();
    });
    expect(result.current["wt-1"]).toEqual({ insertions: 2, deletions: 0 });
  });

  it("returns null for an id whose fetch failed", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getDiffStat").mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => useWorktreeDiffStats(api, ["wt-1"]));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current["wt-1"]).toBeNull();
  });
});
