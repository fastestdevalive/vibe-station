import { describe, expect, it } from "vitest";
import { RENDER_VERSION, TEXTURES, textureById } from "./textureCatalog";

describe("textureCatalog (surface-style-lib TextureCatalog.kt parity)", () => {
  it("table matches TextureCatalog.kt", () => {
    expect(RENDER_VERSION).toBe(5);
    expect(TEXTURES.map((t) => t.id)).toEqual([
      "none",
      "dither",
      "ascii",
      "halftone",
      "scanlines",
      "haze",
      "grain",
      "mosaic",
      "glitch",
      "hex",
      "frost",
    ]);
    expect(TEXTURES.map((t) => t.defaultIntensity)).toEqual([
      0, 0.7, 0.8, 0.8, 0.6, 0.8, 0.5, 0.8, 0.7, 0.8, 0.6,
    ]);
    expect(TEXTURES.map((t) => t.costTier)).toEqual([
      "cheap",
      "heavy",
      "heavy",
      "heavy",
      "cheap",
      "medium",
      "cheap",
      "cheap",
      "cheap",
      "heavy",
      "medium",
    ]);
    expect(TEXTURES.map((t) => t.hasLightVariant)).toEqual([
      false,
      false,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      true,
      false,
    ]);
    expect(TEXTURES.map((t) => t.needsSource)).toEqual([
      false,
      true,
      true,
      true,
      false,
      true,
      false,
      true,
      true,
      true,
      true,
    ]);
    expect(TEXTURES.map((t) => t.delivery)).toEqual([
      "none",
      "baked",
      "baked",
      "baked",
      "baked",
      "css",
      "baked",
      "baked",
      "baked",
      "baked",
      "css",
    ]);
  });

  it("every texture carries a label and a one-sentence blurb", () => {
    for (const t of TEXTURES) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.blurb.length).toBeGreaterThan(0);
      expect(t.blurb.endsWith(".")).toBe(true);
    }
  });

  it("unknown id is none", () => {
    expect(textureById("sparkles").id).toBe("none");
    expect(textureById("").id).toBe("none");
    expect(textureById("grain").id).toBe("grain");
  });
});
