import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPreloadErrorHandler } from "./preloadReload";

describe("createPreloadErrorHandler", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reloads on the first event, not again within 60 s, and again after 61 s", () => {
    const reload = vi.fn();
    const handle = createPreloadErrorHandler(reload);
    handle();
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    handle();
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(31_000);
    handle();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("treats the legacy 'true' flag as expired", () => {
    sessionStorage.setItem("vst:preloadReloaded", "true");
    const reload = vi.fn();
    createPreloadErrorHandler(reload)();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("falls back to a single in-memory reload when sessionStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const reload = vi.fn();
    const handle = createPreloadErrorHandler(reload);
    handle();
    handle();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
