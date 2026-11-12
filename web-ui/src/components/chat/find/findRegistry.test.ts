import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { registerFindPane, updateFindPaneFocus, useActiveFindPane } from "./findRegistry";

describe("findRegistry", () => {
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => {
    cleanups.splice(0).forEach((c) => c());
    vi.useRealTimers();
  });

  function register(paneId: string, sessionId: string, at: number) {
    const open = vi.fn();
    vi.setSystemTime(at);
    cleanups.push(registerFindPane({ paneId, sessionId, open, lastFocusedAt: at }));
    return open;
  }

  it("two panes on one session: focusing either makes it the active find pane", () => {
    const openA = register("pane-a", "s1", 1_000);
    const openB = register("pane-b", "s1", 2_000);
    const { result } = renderHook(() => useActiveFindPane());
    expect(result.current?.open).toBe(openB);

    act(() => {
      vi.setSystemTime(3_000);
      updateFindPaneFocus("pane-a");
    });
    expect(result.current?.open).toBe(openA);

    act(() => {
      vi.setSystemTime(4_000);
      updateFindPaneFocus("pane-b");
    });
    expect(result.current?.open).toBe(openB);
  });

  it("unregistering one pane leaves the other pane of the same session registered", () => {
    const openA = register("pane-a", "s1", 1_000);
    register("pane-b", "s1", 2_000);
    const { result } = renderHook(() => useActiveFindPane());

    act(() => {
      cleanups.pop()!();
    });
    expect(result.current?.open).toBe(openA);
  });

  it("an unknown pane id changes nothing", () => {
    const openA = register("pane-a", "s1", 1_000);
    const { result } = renderHook(() => useActiveFindPane());
    act(() => updateFindPaneFocus("s1"));
    expect(result.current?.open).toBe(openA);
  });
});
