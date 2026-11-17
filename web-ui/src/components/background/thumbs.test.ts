import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FOCAL_Y, objectPosition } from "./focal";
import { textureTileUrl, thumbUrl } from "./thumbs";
import type { TextureId } from "./backgroundStore";

/** The 11 texture ids of the plan's texture table (Track B owns `TEXTURES`). */
const TEXTURE_IDS: TextureId[] = [
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
];

const CATALOG_IDS: string[] = JSON.parse(
  readFileSync(resolve(__dirname, "../../../../rust/vst-wallpapers/assets/catalog.json"), "utf8"),
).wallpapers.map((w: { id: string }) => w.id);

describe("bundled wallpaper assets", () => {
  it("all 31 catalog ids have a thumb and a focal point", () => {
    expect(CATALOG_IDS.length).toBeGreaterThan(0);
    for (const id of CATALOG_IDS) {
      expect(thumbUrl(id), `thumb for ${id}`).toBeTruthy();
      expect(typeof FOCAL_Y[id], `focal point for ${id}`).toBe("number");
      expect(objectPosition(id)).toBe(`50% ${FOCAL_Y[id]}%`);
    }
    expect(thumbUrl("wp-999")).toBeUndefined();
    expect(objectPosition("wp-999")).toBe("50% 50%");
  });

  it("every texture has a tile url in both appearances", () => {
    for (const id of TEXTURE_IDS) {
      expect(textureTileUrl(id, "dark"), `${id} dark tile`).toBeTruthy();
      expect(textureTileUrl(id, "light"), `${id} light tile`).toBeTruthy();
    }
    // The effects without a bake show the untouched source; haze/frost add CSS.
    for (const id of ["none", "haze", "frost"] as const) {
      expect(textureTileUrl(id, "dark")).toContain("original");
    }
  });

  it("halftone tile is the light bake in dark too", () => {
    expect(textureTileUrl("halftone", "dark")).toBe(textureTileUrl("halftone", "light"));
    expect(textureTileUrl("halftone", "dark")).toContain("halftone-light");
  });
});
