import { afterEach, describe, expect, it, vi } from "vitest";
import { RENDER_VERSION } from "../textureCatalog";
import { bakeKey, type BakeKeyParts } from "./bakeKey";

const base: BakeKeyParts = {
  id: "wp-007",
  sha: null,
  texture: "dither",
  appearance: "dark",
  width: 1280,
  height: 800,
};

afterEach(() => {
  vi.doUnmock("../textureCatalog");
  vi.resetModules();
});

describe("bakeKey", () => {
  it("halftone key ignores appearance", () => {
    const dark = bakeKey({ ...base, texture: "halftone", appearance: "dark" });
    const light = bakeKey({ ...base, texture: "halftone", appearance: "light" });

    expect(dark).toBe(light);
  });

  it("other textures include appearance", () => {
    const dark = bakeKey({ ...base, appearance: "dark" });
    const light = bakeKey({ ...base, appearance: "light" });

    expect(dark).not.toBe(light);
    expect(dark).toContain("|dark|");
    expect(light).toContain("|light|");
  });

  it("key changes with RENDER_VERSION", async () => {
    const before = bakeKey(base);

    vi.resetModules();
    vi.doMock("../textureCatalog", () => ({ RENDER_VERSION: RENDER_VERSION + 1 }));
    const { bakeKey: bumped } = await import("./bakeKey");
    const after = bumped(base);

    expect(after).not.toBe(before);
    expect(after.endsWith(`|${RENDER_VERSION + 1}`)).toBe(true);
  });

  it("has no intensity slot: one bake serves every slider value", () => {
    // Intensity is the baked layer's opacity (WallpaperEffect), so the key is
    // exactly five parts and the last one is the render version.
    const parts = bakeKey(base).split("|");

    expect(parts).toHaveLength(5);
    expect(parts[4]).toBe(String(RENDER_VERSION));
  });

  it("uses the catalog sha when known and the id otherwise", () => {
    expect(bakeKey({ ...base, sha: "abc123" }).startsWith("abc123|")).toBe(true);
    expect(bakeKey({ ...base, sha: null }).startsWith("wp-007|")).toBe(true);
  });
});
