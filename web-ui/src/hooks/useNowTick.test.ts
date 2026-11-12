import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useNowTick } from "./useNowTick";

describe("useNowTick", () => {
  let hidden = false;
  const START = new Date(2026, 10, 12, 15, 0).getTime();

  beforeEach(() => {
    hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(document, "hidden");
  });

  it("ticks once a minute while visible", () => {
    const { result, unmount } = renderHook(() => useNowTick());
    expect(result.current).toBe(START);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe(START + 60_000);
    unmount();
  });

  it("skips ticks while the tab is hidden and refreshes on becoming visible", () => {
    const { result, unmount } = renderHook(() => useNowTick());
    hidden = true;
    act(() => {
      vi.advanceTimersByTime(3 * 60_000);
    });
    expect(result.current).toBe(START);

    hidden = false;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current).toBe(START + 3 * 60_000);
    unmount();
  });

  it("stops its timer and visibility listener with zero subscribers", () => {
    const remove = vi.spyOn(document, "removeEventListener");
    const a = renderHook(() => useNowTick());
    const b = renderHook(() => useNowTick());
    expect(vi.getTimerCount()).toBe(1);
    a.unmount();
    expect(vi.getTimerCount()).toBe(1);
    b.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    remove.mockRestore();
  });
});
