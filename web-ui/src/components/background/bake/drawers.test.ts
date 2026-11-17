import { describe, expect, it } from "vitest";
import { DRAWERS } from "./drawers";
import type { Drawer, DrawerOptions } from "./drawers/types";
import type { BakedTextureId } from "./protocol";
import { bakeSeed, makeRng } from "./seededRandom";

// jsdom has no ImageData; the drawers only need `{data,width,height}`, so a plain
// stand-in is enough to exercise them without canvas.
if (typeof globalThis.ImageData === "undefined") {
  class ImageDataPolyfill {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  }
  Object.defineProperty(globalThis, "ImageData", {
    writable: true,
    configurable: true,
    value: ImageDataPolyfill,
  });
}

const SIZE = 16;

function makeImage(): ImageData {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      data[i] = (x * 16) % 256;
      data[i + 1] = (y * 16) % 256;
      data[i + 2] = (x * 7 + y * 11) % 256;
      data[i + 3] = 255;
    }
  }
  return new ImageData(data, SIZE, SIZE);
}

function opts(over: Partial<DrawerOptions> = {}): DrawerOptions {
  return { intensity: 0.8, appearance: "dark", seed: 1234, ...over };
}

const ids = Object.keys(DRAWERS) as BakedTextureId[];

describe("DRAWERS", () => {
  it("covers every bakeable texture", () => {
    expect([...ids].sort()).toEqual([
      "ascii",
      "dither",
      "glitch",
      "grain",
      "halftone",
      "hex",
      "mosaic",
      "scanlines",
    ]);
  });
});

describe.each(ids)("%s", (id) => {
  const draw: Drawer = DRAWERS[id];

  it("is deterministic for the same seed", () => {
    const a = draw(makeImage(), opts());
    const b = draw(makeImage(), opts());
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it("keeps dimensions", () => {
    const out = draw(makeImage(), opts());
    expect(out.width).toBe(SIZE);
    expect(out.height).toBe(SIZE);
    expect(out.data.length).toBe(SIZE * SIZE * 4);
  });

  it("changes pixels at intensity 0.8", () => {
    const before = makeImage();
    const original = Array.from(before.data);
    const out = draw(before, opts({ intensity: 0.8 }));
    expect(Array.from(out.data)).not.toEqual(original);
  });

  it("intensity 0 returns near-identity", () => {
    const before = makeImage();
    const original = Array.from(before.data);
    const out = draw(before, opts({ intensity: 0 }));
    expect(Array.from(out.data)).toEqual(original);
  });
});

describe("mosaic tiles", () => {
  /** Flat colour, so every cell means exactly that colour. */
  function flat(width: number, height: number): ImageData {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 200;
      data[i + 1] = 100;
      data[i + 2] = 50;
      data[i + 3] = 255;
    }
    return new ImageData(data, width, height);
  }

  function red(img: ImageData, x: number, y: number): number {
    return img.data[(y * img.width + x) * 4] ?? -1;
  }

  it("mosaic tiles are 20 reference px (U5)", () => {
    // 1600 px is the reference width: 20 px tiles, 1 px gap on each tile's top/left.
    const wide = DRAWERS.mosaic(flat(1600, 40), opts({ intensity: 1 }));
    expect(red(wide, 0, 10)).toBe(70); // 0.35 x 200
    expect(red(wide, 20, 10)).toBe(70);
    expect(red(wide, 10, 0)).toBe(70);
    expect(red(wide, 10, 20)).toBe(70);
    expect(red(wide, 10, 10)).toBe(200);
  });

  it("the tile period scales with the output width", () => {
    const narrow = DRAWERS.mosaic(flat(800, 40), opts({ intensity: 1 }));
    expect(red(narrow, 0, 5)).toBe(70);
    expect(red(narrow, 10, 5)).toBe(70);
    expect(red(narrow, 5, 5)).toBe(200);
  });
});

describe("drawer theme rules", () => {
  it("halftone ignores appearance", () => {
    const dark = DRAWERS.halftone(makeImage(), opts({ appearance: "dark" }));
    const light = DRAWERS.halftone(makeImage(), opts({ appearance: "light" }));
    expect(Array.from(dark.data)).toEqual(Array.from(light.data));
  });

  it("scanlines differ between dark and light", () => {
    const dark = DRAWERS.scanlines(makeImage(), opts({ appearance: "dark" }));
    const light = DRAWERS.scanlines(makeImage(), opts({ appearance: "light" }));
    expect(Array.from(dark.data)).not.toEqual(Array.from(light.data));
  });
});

describe("makeRng", () => {
  it("is deterministic for the same seed", () => {
    const a = makeRng(7);
    const b = makeRng(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("stays inside [0,1) and differs between seeds", () => {
    const a = makeRng(1);
    const b = makeRng(2);
    const first = a();
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(1);
    expect(b()).not.toBe(first);
  });
});

describe("bakeSeed", () => {
  it("depends on the texture and the output size", () => {
    expect(bakeSeed("grain", 1920, 1080)).toBe(bakeSeed("grain", 1920, 1080));
    expect(bakeSeed("grain", 1920, 1080)).not.toBe(bakeSeed("grain", 1280, 800));
    expect(bakeSeed("grain", 1920, 1080)).not.toBe(bakeSeed("glitch", 1920, 1080));
  });
});
