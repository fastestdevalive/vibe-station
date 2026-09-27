import { act, renderHook } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useVirtualKeyboardVisible } from "./useVirtualKeyboardVisible";

function mockTouchDevice(touch: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("coarse") ? touch : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

const BASE_HEIGHT = 800;
function withVisualViewport(initialHeight: number) {
  const listeners: Array<() => void> = [];
  const vp = {
    height: initialHeight,
    addEventListener: (_type: string, cb: () => void) => listeners.push(cb),
    removeEventListener: () => {},
  };
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: vp,
  });
  return {
    setHeight(h: number) {
      vp.height = h;
      listeners.forEach((cb) => cb());
    },
    restore() {
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        value: undefined,
      });
    },
  };
}

describe("useVirtualKeyboardVisible", () => {
  beforeEach(() => {
    mockTouchDevice(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is false on a desktop device even when the viewport shrinks", () => {
    mockTouchDevice(false);
    const vp = withVisualViewport(BASE_HEIGHT);
    const { result } = renderHook(() => useVirtualKeyboardVisible());
    act(() => vp.setHeight(BASE_HEIGHT - 400));
    expect(result.current).toBe(false);
    vp.restore();
  });

  it("becomes true on a touch device when the viewport shrinks past the keyboard threshold", () => {
    const vp = withVisualViewport(BASE_HEIGHT);
    const { result } = renderHook(() => useVirtualKeyboardVisible());
    expect(result.current).toBe(false);
    act(() => vp.setHeight(BASE_HEIGHT - 350));
    expect(result.current).toBe(true);
    vp.restore();
  });

  it("stays false on a touch device for a small viewport shrink (browser chrome)", () => {
    const vp = withVisualViewport(BASE_HEIGHT);
    const { result } = renderHook(() => useVirtualKeyboardVisible());
    act(() => vp.setHeight(BASE_HEIGHT - 50));
    expect(result.current).toBe(false);
    vp.restore();
  });
});
