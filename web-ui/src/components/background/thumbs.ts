import type { TextureId } from "./backgroundStore";

/**
 * Bundled wallpaper thumbs (384x216, same crops as the design) and texture
 * tiles (the design's wp-023 bakes, resized to 256 px wide; Mosaic is re-baked at
 * 20 px tiles so its cells read at tile size).
 *
 * Both are shipped in the web bundle so the Picker paints instantly and works
 * offline — the daemon only serves full images.
 */
const THUMB_MODULES = import.meta.glob("./assets/thumbs/*.jpg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const TEXTURE_MODULES = import.meta.glob("./assets/textures/*.jpg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

/** `"./assets/thumbs/wp-001.jpg"` -> `"wp-001"`. */
function fileKey(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1);
  return file.slice(0, file.lastIndexOf("."));
}

function urlByKey(modules: Record<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, url] of Object.entries(modules)) out.set(fileKey(path), url);
  return out;
}

const THUMB_URLS = urlByKey(THUMB_MODULES);
const TEXTURE_URLS = urlByKey(TEXTURE_MODULES);
const ORIGINAL_TILE = TEXTURE_URLS.get("original") ?? "";

/** Bundled thumb for a catalog id, or `undefined` for an id we do not ship. */
export function thumbUrl(id: string): string | undefined {
  return THUMB_URLS.get(id);
}

/**
 * Tile image for one texture. `halftone` always shows its light "ink on paper"
 * bake in both themes (one look, so appearance is not part of its
 * cache key either). Effects that have no baked tile (`none`, `haze`, `frost`)
 * fall back to the untouched source — the tile layer adds the CSS effect.
 */
export function textureTileUrl(texture: TextureId, appearance: "dark" | "light"): string {
  if (texture === "halftone") return TEXTURE_URLS.get("halftone-light") ?? ORIGINAL_TILE;
  return (
    TEXTURE_URLS.get(`${texture}-${appearance}`) ??
    TEXTURE_URLS.get(texture) ??
    ORIGINAL_TILE
  );
}
