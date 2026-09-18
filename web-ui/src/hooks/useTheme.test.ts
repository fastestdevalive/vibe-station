import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { createMockApi, type MockApi } from "@/api/mock";
import { useTheme, __resetThemeSyncForTests } from "./useTheme";
import { useThemeStore } from "./useThemeStore";

/**
 * `useTheme` reads the singleton `api` from `@/api`. Mock that module so each
 * test controls its own `MockApi` instance (getSettings return, updateSettings
 * spy, and WS emits) via a module-level `testApi` the getter hands back.
 */
let testApi: MockApi;

vi.mock("@/api", () => ({
  get api() {
    return testApi;
  },
  createMockApi,
}));

beforeEach(() => {
  __resetThemeSyncForTests();
  testApi = createMockApi();
});

describe("useTheme", () => {
  it("defaults to dark appearance + mono font before the server resolves", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
    expect(result.current.themeId).toBe("vibestation-dark");
    expect(result.current.font).toBe("mono");
  });

  it("seeds from GET /settings and writes BOTH data-theme and data-appearance (server value wins)", async () => {
    testApi.__test.setSettings({ themeId: "nord" });
    const { result } = renderHook(() => useTheme());

    await waitFor(() => {
      expect(useThemeStore.getState().themeId).toBe("nord");
    });

    expect(result.current.theme).toBe("dark");
    expect(result.current.themeId).toBe("nord");
    expect(document.documentElement.dataset.theme).toBe("nord");
    expect(document.documentElement.dataset.appearance).toBe("dark");
  });

  it("a light theme maps appearance to 'light' on both attributes", async () => {
    testApi.__test.setSettings({ themeId: "github-light" });
    renderHook(() => useTheme());

    await waitFor(() => {
      expect(useThemeStore.getState().themeId).toBe("github-light");
    });

    expect(document.documentElement.dataset.theme).toBe("github-light");
    expect(document.documentElement.dataset.appearance).toBe("light");
  });

  it("setTheme optimistically updates the store, PATCHes, and writes localStorage on success", async () => {
    const updateSpy = vi.spyOn(testApi, "updateSettings");
    const { result } = renderHook(() => useTheme());

    await act(async () => {
      result.current.setTheme("monokai");
      await Promise.resolve();
    });

    expect(useThemeStore.getState().themeId).toBe("monokai");
    expect(updateSpy).toHaveBeenCalledWith({ themeId: "monokai" });
    expect(document.documentElement.dataset.theme).toBe("monokai");
    expect(document.documentElement.dataset.appearance).toBe("dark");
    expect(localStorage.getItem("vibestation:theme")).toBe("monokai");
  });

  it("toggleTheme switches directly between vibestation-dark and vibestation-light", async () => {
    const { result } = renderHook(() => useTheme());

    await act(async () => {
      result.current.toggleTheme();
      await Promise.resolve();
    });
    expect(result.current.themeId).toBe("vibestation-light");
    expect(document.documentElement.dataset.appearance).toBe("light");

    await act(async () => {
      result.current.toggleTheme();
      await Promise.resolve();
    });
    expect(result.current.themeId).toBe("vibestation-dark");
    expect(document.documentElement.dataset.appearance).toBe("dark");
  });

  it("a settings:updated WS event fans the new theme out to a second mounted context without remount", async () => {
    // Two mounted consumers of the shared store (simulating two contexts/tabs
    // in the same page). Both must reflect a WS-driven theme change live.
    const { result: ctxA } = renderHook(() => useTheme());
    const { result: ctxB } = renderHook(() => useTheme());

    await waitFor(() => expect(ctxA.current.themeId).toBe("vibestation-dark"));
    expect(ctxB.current.themeId).toBe("vibestation-dark");

    act(() => {
      testApi.__test.emit({ type: "settings:updated", themeId: "nord" });
    });

    expect(ctxA.current.themeId).toBe("nord");
    expect(ctxB.current.themeId).toBe("nord");
    expect(document.documentElement.dataset.theme).toBe("nord");
    expect(document.documentElement.dataset.appearance).toBe("dark");
  });
});

describe("useTheme — legacy localStorage migration (3.T4)", () => {
  it("PATCHes the migrated legacy value when GET /settings returns no themeId", async () => {
    localStorage.setItem("vibestation:theme", "light");
    const updateSpy = vi.spyOn(testApi, "updateSettings");

    renderHook(() => useTheme());

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith({ themeId: "vibestation-light" });
    });
    await waitFor(() => {
      expect(useThemeStore.getState().themeId).toBe("vibestation-light");
    });
    expect(document.documentElement.dataset.theme).toBe("vibestation-light");
    expect(document.documentElement.dataset.appearance).toBe("light");
    expect(localStorage.getItem("vibestation:theme")).toBe("vibestation-light");
  });

  it("does NOT migrate when GET /settings already has a themeId (server wins)", async () => {
    localStorage.setItem("vibestation:theme", "dark");
    testApi.__test.setSettings({ themeId: "nord" });
    const updateSpy = vi.spyOn(testApi, "updateSettings");

    renderHook(() => useTheme());

    await waitFor(() => {
      expect(useThemeStore.getState().themeId).toBe("nord");
    });
    expect(updateSpy).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.theme).toBe("nord");
  });

  it("ignores an invalid stored theme / font", async () => {
    localStorage.setItem("vibestation:theme", "comic-sans");
    localStorage.setItem("vibestation:font", "comic-sans");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
    expect(result.current.font).toBe("mono");
  });
});
