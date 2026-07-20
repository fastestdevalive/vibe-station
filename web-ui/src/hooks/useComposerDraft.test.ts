import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { loadDraft, useComposerDraft } from "./useComposerDraft";

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useComposerDraft (RA1)", () => {
  it("debounces writes — only the last value lands after the delay", () => {
    const { result } = renderHook(() => useComposerDraft("s1"));

    act(() => result.current.save("a"));
    act(() => result.current.save("ab"));
    act(() => result.current.save("abc"));
    // Nothing written yet — still within the debounce window.
    expect(loadDraft("s1")).toBe("");

    act(() => vi.advanceTimersByTime(400));
    expect(loadDraft("s1")).toBe("abc");
  });

  it("empty/whitespace text removes the key", () => {
    localStorage.setItem("vst-chat-draft-s1", "old");
    const { result } = renderHook(() => useComposerDraft("s1"));

    act(() => result.current.save("   "));
    act(() => vi.advanceTimersByTime(400));
    expect(localStorage.getItem("vst-chat-draft-s1")).toBeNull();
  });

  it("clear cancels a pending write and removes the key", () => {
    localStorage.setItem("vst-chat-draft-s1", "stored");
    const { result } = renderHook(() => useComposerDraft("s1"));

    act(() => result.current.save("typing"));
    act(() => result.current.clear());
    // Advancing past the debounce must NOT resurrect the cancelled write.
    act(() => vi.advanceTimersByTime(400));
    expect(localStorage.getItem("vst-chat-draft-s1")).toBeNull();
  });

  it("flushes a pending write synchronously on unmount", () => {
    const { result, unmount } = renderHook(() => useComposerDraft("s1"));

    act(() => result.current.save("unsaved"));
    expect(loadDraft("s1")).toBe("");
    unmount();
    expect(loadDraft("s1")).toBe("unsaved");
  });
});
