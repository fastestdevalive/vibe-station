import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/errors";
import { switchErrorText, useAccountSwitch, useSwitchNotices } from "./useAccountSwitch";

const TARGET = { id: "acc_work", displayName: "Work" };
const REFUSED = "This chat was continued in both accounts, so the two copies differ and cannot be handed over. Nothing changed.";

function refusal() {
  return new ApiError(JSON.stringify({ error: REFUSED, code: "handover_failed" }), 409, "handover_failed");
}

beforeEach(() => useSwitchNotices.setState({ notices: {} }));

describe("useAccountSwitch refusal", () => {
  it.each([
    ["json", "Switch with a transcript instead", { carryOver: "transcript" }],
    ["tmux", "Switch and start a new conversation", { carryOver: "none" }],
  ] as const)("handover_failed on a %s session offers one fallback", async (channel, label, opts) => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(refusal())
      .mockResolvedValueOnce({ ok: true, archivedSessionId: "a", newSessionId: "b", carryOver: "transcript" });
    const { result } = renderHook(() => useAccountSwitch({ switchSessionAccount: fn } as never, { id: "s1", channel }));
    await act(async () => {
      await result.current.switchTo(TARGET);
    });
    expect(result.current.error).toBe(REFUSED);
    expect(result.current.fallback?.label).toBe(label);
    await act(async () => {
      result.current.fallback?.run();
    });
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(fn).toHaveBeenLastCalledWith("s1", "acc_work", opts);
    expect(result.current.fallback).toBeNull();
  });

  it("other errors offer no fallback; clearError drops it", async () => {
    const fn = vi.fn().mockRejectedValue(refusal());
    const { result } = renderHook(() => useAccountSwitch({ switchSessionAccount: fn } as never, { id: "s1", channel: "json" }));
    await act(async () => {
      await result.current.switchTo(TARGET);
    });
    expect(result.current.fallback).not.toBeNull();
    act(() => result.current.clearError());
    expect(result.current.fallback).toBeNull();
    fn.mockRejectedValue(new ApiError(JSON.stringify({ error: "x", code: "agent_busy" }), 409, "agent_busy"));
    await act(async () => {
      await result.current.switchTo(TARGET);
    });
    expect(result.current.fallback).toBeNull();
  });

  it("reset_in_progress reads as a switch", () => {
    const e = new ApiError(JSON.stringify({ error: "A reset is already in progress", code: "reset_in_progress" }), 409, "reset_in_progress");
    expect(switchErrorText(e)).toBe("A switch is already running for this agent.");
  });
});
