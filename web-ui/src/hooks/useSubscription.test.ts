import { renderHook, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createMockApi } from "@/api/mock";
import { useSubscription, useSessionOutput } from "./useSubscription";
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
