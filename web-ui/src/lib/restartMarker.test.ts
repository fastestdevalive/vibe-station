import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { consumeRecentRestart, markRestartReload } from "./restartMarker";

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("restartMarker", () => {
  it("a fresh marker is consumed once; a stale one is not reported but is still cleared", () => {
    sessionStorage.setItem("vst:restartedAt", String(Date.now() - 30_000));
    expect(consumeRecentRestart(120_000)).toBe(true);
    expect(consumeRecentRestart(120_000)).toBe(false);

    sessionStorage.setItem("vst:restartedAt", String(Date.now() - 300_000));
    expect(consumeRecentRestart(120_000)).toBe(false);
    expect(sessionStorage.getItem("vst:restartedAt")).toBeNull();
  });

  it("never throws when sessionStorage does, and still reloads", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    expect(() => markRestartReload()).not.toThrow();
    expect(reload).toHaveBeenCalled();
    expect(consumeRecentRestart(1000)).toBe(false);
    vi.unstubAllGlobals();
  });
});
