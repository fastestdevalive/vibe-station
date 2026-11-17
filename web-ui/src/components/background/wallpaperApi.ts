import { apiFetch, baseUrl } from "@/api/client";
import type { WallpaperCatalogResponse, WallpaperEntry } from "@/api/types";

/**
 * Wallpaper catalog client. Nothing here is a display URL: Tauri authenticates
 * with a Bearer header, so a raw `<img src>`/CSS `url()` would 401 — every
 * image goes through `fetchWallpaperBlob` → object URL instead.
 */
export async function fetchWallpaperCatalog(): Promise<WallpaperCatalogResponse> {
  const res = await apiFetch(`${baseUrl()}/wallpapers`);
  if (!res.ok) {
    throw new Error(`wallpaper catalog request failed with status ${res.status}`);
  }
  return parseWallpaperCatalog(await res.json());
}

/**
 * Tolerant parse of the catalog body (AGENTS.md "parse tolerantly", one place):
 * a 200 the daemon never meant to send must fail HERE, with a named error, so
 * the consumer's retry budget still applies. Entries without a usable `id` are
 * dropped; anything else is passed through as-is.
 */
function parseWallpaperCatalog(body: unknown): WallpaperCatalogResponse {
  const wallpapers =
    typeof body === "object" && body !== null ? (body as { wallpapers?: unknown }).wallpapers : undefined;
  if (!Array.isArray(wallpapers)) {
    throw new Error("wallpaper catalog response is malformed");
  }
  const valid = wallpapers.filter(
    (w): w is WallpaperEntry =>
      typeof w === "object" &&
      w !== null &&
      typeof (w as { id?: unknown }).id === "string" &&
      (w as { id: string }).id !== "",
  );
  return { ...(body as WallpaperCatalogResponse), wallpapers: valid };
}

/** Daemon image route. `baseUrl()` already ends in `/api`. */
export function wallpaperImageUrl(id: string, size: "thumb" | "full"): string {
  return `${baseUrl()}/wallpapers/${encodeURIComponent(id)}/image?size=${size}`;
}

export async function fetchWallpaperBlob(
  id: string,
  size: "thumb" | "full",
  signal?: AbortSignal,
): Promise<Blob> {
  const res = await apiFetch(wallpaperImageUrl(id, size), { signal });
  if (!res.ok) {
    throw new Error(`wallpaper image ${id} (${size}) failed with status ${res.status}`);
  }
  return res.blob();
}
