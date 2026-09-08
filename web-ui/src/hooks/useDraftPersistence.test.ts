import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { loadDraft, useDraftPersistence } from "./useDraftPersistence";

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useDraftPersistence", () => {
  it("debounces writes — only the last value lands after 400ms", () => {
    const { result } = renderHook(() => useDraftPersistence("k1"));

    act(() => result.current.save("a"));
    act(() => result.current.save("ab"));
    act(() => result.current.save("abc"));
    expect(loadDraft("k1")).toBe("");

    act(() => vi.advanceTimersByTime(400));
    expect(loadDraft("k1")).toBe("abc");
  });

  it("empty text removes the key", () => {
    localStorage.setItem("k1", "old");
    const { result } = renderHook(() => useDraftPersistence("k1"));

    act(() => result.current.save("   "));
    act(() => vi.advanceTimersByTime(400));
    expect(localStorage.getItem("k1")).toBeNull();
  });

  it("clear removes the key immediately and cancels a pending write", () => {
    localStorage.setItem("k1", "stored");
    const { result } = renderHook(() => useDraftPersistence("k1"));

    act(() => result.current.save("typing"));
    act(() => result.current.clear());
    expect(localStorage.getItem("k1")).toBeNull();

    act(() => vi.advanceTimersByTime(400));
    expect(localStorage.getItem("k1")).toBeNull();
  });

  it("flushes a pending write synchronously on unmount", () => {
    const { result, unmount } = renderHook(() => useDraftPersistence("k1"));

    act(() => result.current.save("unsaved"));
    expect(loadDraft("k1")).toBe("");
    unmount();
    expect(loadDraft("k1")).toBe("unsaved");
  });

  it("different keys don't collide", () => {
    const a = renderHook(() => useDraftPersistence("keyA"));
    const b = renderHook(() => useDraftPersistence("keyB"));

    act(() => a.result.current.save("A text"));
    act(() => b.result.current.save("B text"));
    act(() => vi.advanceTimersByTime(400));

    expect(loadDraft("keyA")).toBe("A text");
    expect(loadDraft("keyB")).toBe("B text");
  });
});
