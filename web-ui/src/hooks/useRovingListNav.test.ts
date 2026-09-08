import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useRovingListNav, type RovingRow } from "./useRovingListNav";

const ROWS: RovingRow[] = [
  { path: "a", expandable: true },
  { path: "b" },
  { path: "c", expandable: true },
];

function key(k: string) {
  return { key: k, preventDefault: vi.fn() } as unknown as React.KeyboardEvent;
}

describe("useRovingListNav", () => {
  it("ArrowDown moves the cursor forward without wrapping past the end", () => {
    const onOpen = vi.fn();
    const { result } = renderHook(() => useRovingListNav(ROWS, { onOpen }));

    act(() => result.current.handleKeyDown(key("ArrowDown")));
    expect(result.current.cursorPath).toBe("a");

    act(() => result.current.handleKeyDown(key("ArrowDown")));
    expect(result.current.cursorPath).toBe("b");

    act(() => result.current.handleKeyDown(key("ArrowDown")));
    expect(result.current.cursorPath).toBe("c");

    // Already at the last row — stays put.
    act(() => result.current.handleKeyDown(key("ArrowDown")));
    expect(result.current.cursorPath).toBe("c");
  });

  it("ArrowUp moves the cursor backward without wrapping past the start", () => {
    const onOpen = vi.fn();
    const { result } = renderHook(() => useRovingListNav(ROWS, { onOpen }));

    act(() => result.current.setCursorPath("c"));
    act(() => result.current.handleKeyDown(key("ArrowUp")));
    expect(result.current.cursorPath).toBe("b");

    act(() => result.current.handleKeyDown(key("ArrowUp")));
    expect(result.current.cursorPath).toBe("a");

    // Already at the first row — stays put.
    act(() => result.current.handleKeyDown(key("ArrowUp")));
    expect(result.current.cursorPath).toBe("a");
  });

  it("Enter calls onOpen with the current cursor", () => {
    const onOpen = vi.fn();
    const { result } = renderHook(() => useRovingListNav(ROWS, { onOpen }));

    act(() => result.current.setCursorPath("b"));
    act(() => result.current.handleKeyDown(key("Enter")));
    expect(onOpen).toHaveBeenCalledWith("b");
  });

  it("ArrowRight/ArrowLeft call onToggle only when the row is expandable", () => {
    const onOpen = vi.fn();
    const onToggle = vi.fn();
    const { result } = renderHook(() => useRovingListNav(ROWS, { onOpen, onToggle }));

    // "b" is not expandable — no-op.
    act(() => result.current.setCursorPath("b"));
    act(() => result.current.handleKeyDown(key("ArrowRight")));
    expect(onToggle).not.toHaveBeenCalled();

    // "a" is expandable.
    act(() => result.current.setCursorPath("a"));
    act(() => result.current.handleKeyDown(key("ArrowRight")));
    expect(onToggle).toHaveBeenCalledWith("a");

    act(() => result.current.handleKeyDown(key("ArrowLeft")));
    expect(onToggle).toHaveBeenCalledWith("a");
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("row[0] is tabbable before any cursor exists; cursor row is tabbable once set", () => {
    const onOpen = vi.fn();
    const { result } = renderHook(() => useRovingListNav(ROWS, { onOpen }));

    expect(result.current.cursorPath).toBeNull();
    expect(result.current.isTabbable("a")).toBe(true);
    expect(result.current.isTabbable("b")).toBe(false);
    expect(result.current.isTabbable("c")).toBe(false);

    act(() => result.current.setCursorPath("b"));
    expect(result.current.isTabbable("a")).toBe(false);
    expect(result.current.isTabbable("b")).toBe(true);
    expect(result.current.isTabbable("c")).toBe(false);
  });

  it("Space mirrors Enter — calls onOpen with the current cursor, or row[0] when no cursor yet", () => {
    const onOpen = vi.fn();
    const { result } = renderHook(() => useRovingListNav(ROWS, { onOpen }));

    // No cursor yet — Space opens the tabbable fallback (row[0]).
    act(() => result.current.handleKeyDown(key(" ")));
    expect(onOpen).toHaveBeenCalledWith("a");

    onOpen.mockClear();
    act(() => result.current.setCursorPath("c"));
    act(() => result.current.handleKeyDown(key(" ")));
    expect(onOpen).toHaveBeenCalledWith("c");
  });
});
