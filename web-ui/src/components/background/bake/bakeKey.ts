import type { BakedTextureId } from "./protocol";
import { RENDER_VERSION } from "../textureCatalog";

/**
 * Cache identity of one baked wallpaper.
 *
 * The image identity is the catalog sha when known and the catalog id
 * otherwise: a key must exist before the image is fetched, so an image whose
 * bytes change under the same id only re-bakes when the catalog gains a sha.
 * Halftone always uses the light "ink on paper" look in both themes, so its
 * appearance slot is a constant — theme must not split its cache entry.
 *
 * Intensity is NOT part of the key: every drawer is a linear blend, so one bake
 * at full strength is drawn at the slider value as the layer's opacity
 * (`WallpaperEffect`), and moving the slider never re-bakes.
 */
export interface BakeKeyParts {
  id: string;
  sha?: string | null;
  texture: BakedTextureId;
  appearance: "dark" | "light";
  width: number;
  height: number;
}

export function bakeKey(parts: BakeKeyParts): string {
  const source = parts.sha ?? parts.id;
  const theme = parts.texture === "halftone" ? "-" : parts.appearance;
  return [
    source,
    parts.texture,
    theme,
    `${parts.width}x${parts.height}`,
    String(RENDER_VERSION),
  ].join("|");
}
