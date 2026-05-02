import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTheme } from "./useTheme";

describe("useTheme", () => {
  it("defaults to dark + mono", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
    expect(result.current.font).toBe("mono");
  });

  it("ignores invalid stored theme / font", () => {
    localStorage.setItem("viberun:theme", "");
    localStorage.setItem("viberun:font", "comic-sans");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
    expect(result.current.font).toBe("mono");
  });

  it("toggleTheme flips theme and writes to <html>", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("toggleFont flips font and updates --font-family", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggleFont());
    expect(result.current.font).toBe("sans");
    expect(document.documentElement.style.getPropertyValue("--font-family")).toContain(
      "var(--font-sans)",
    );
  });

  it("persists choices to localStorage", () => {
    const { result } = renderHook(() => useTheme());
    act(() => {
      result.current.toggleTheme();
      result.current.toggleFont();
    });
    expect(localStorage.getItem("viberun:theme")).toBe("light");
    expect(localStorage.getItem("viberun:font")).toBe("sans");
  });
});
