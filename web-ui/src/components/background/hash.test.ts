import { describe, expect, it } from "vitest";
import { fnv1a32, stableWallpaperIndex } from "./hash";

describe("hash (mobile Wallpaper.kt parity)", () => {
  it("fnv1a32 known vectors", () => {
    expect(fnv1a32("")).toBe(2166136261);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });

  it("fnv1a32 hashes UTF-8 bytes (non-ASCII keys)", () => {
    // Same bytes as the Kotlin `s.encodeToByteArray()` path.
    expect(fnv1a32("é")).toBe(fnv1a32("\u00e9"));
    expect(fnv1a32("é")).not.toBe(fnv1a32("e"));
  });

  it("stableWallpaperIndex is in range and stable", () => {
    for (const key of ["app", "w1", "project-p1", "quote:new", "quote:d1"]) {
      const first = stableWallpaperIndex(key, 31);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThan(31);
      expect(stableWallpaperIndex(key, 31)).toBe(first);
    }
    expect(stableWallpaperIndex("w1", 1)).toBe(0);
  });

  it("throws on size 0", () => {
    expect(() => stableWallpaperIndex("w1", 0)).toThrow();
    expect(() => stableWallpaperIndex("w1", -1)).toThrow();
  });
});
