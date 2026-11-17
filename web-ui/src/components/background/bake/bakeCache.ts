import { ObjectUrlLru } from "../objectUrlLru";
import { RENDER_VERSION } from "../textureCatalog";

/**
 * Cache API wrapper for baked wallpaper blobs. The bake key is the cache key,
 * stored under a synthetic origin so nothing ever hits the
 * network: `caches` is absent in jsdom / an insecure context, where every call
 * degrades to a miss / no-op instead of throwing.
 */
export const BAKE_CACHE_NAME = "vst-wallpaper-bakes";
/** Keep about 24 recent wallpaper/texture/size combinations; cache.keys() returns insertion order so oldest drop first. */
export const MAX_BAKE_ENTRIES = 24;

const SYNTHETIC_ORIGIN = "https://vst-bake.invalid/";

/** Synthetic request URL for one bake key. */
export function bakedUrl(key: string): string {
  return `${SYNTHETIC_ORIGIN}${encodeURIComponent(key)}`;
}

/** The RENDER_VERSION whose entries have been evicted (once per page load). */
let evictedVersion: number | null = null;

async function openCache(): Promise<Cache | null> {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open(BAKE_CACHE_NAME);
    // A drawer/baker change bumps RENDER_VERSION; everything older is dead
    // weight, so it is dropped the first time the cache is opened.
    if (evictedVersion !== RENDER_VERSION) {
      evictedVersion = RENDER_VERSION;
      await evictStale(cache);
    }
    return cache;
  } catch {
    return null;
  }
}

function keyOf(request: Request | string): string {
  const url = typeof request === "string" ? request : request.url;
  if (!url.startsWith(SYNTHETIC_ORIGIN)) return url;
  return decodeURIComponent(url.slice(SYNTHETIC_ORIGIN.length));
}

function isCurrent(key: string): boolean {
  return key.endsWith(`|${RENDER_VERSION}`);
}

async function evictStale(cache: Cache): Promise<void> {
  try {
    const requests = await cache.keys();
    await Promise.all(
      requests.filter((r) => !isCurrent(keyOf(r))).map((r) => cache.delete(r)),
    );
  } catch {
    // A cache that cannot list its entries is still usable for reads/writes.
  }
}

export async function getBaked(key: string): Promise<Blob | null> {
  const cache = await openCache();
  if (cache === null) return null;
  try {
    const res = await cache.match(bakedUrl(key));
    if (res === undefined) return null;
    const blob = await res.blob();
    // An empty entry is a half-written/corrupt hit: treat it as a miss.
    return blob.size === 0 ? null : blob;
  } catch {
    return null;
  }
}

export async function putBaked(key: string, blob: Blob): Promise<void> {
  const cache = await openCache();
  if (cache === null) return;
  try {
    await cache.put(bakedUrl(key), new Response(blob));
    const keys = await cache.keys();
    const excess = keys.length - MAX_BAKE_ENTRIES;
    if (excess > 0) await Promise.all(keys.slice(0, excess).map((r) => cache.delete(r)));
  } catch {
    // Quota / opaque response: baking still works, it just is not cached.
  }
}

/** Test-only: forget that the current RENDER_VERSION was already swept. */
export function __resetBakeCacheForTests(): void {
  evictedVersion = null;
  memory.clear();
}

/**
 * Baked images kept decoded in memory, so a pair baked in this page session is
 * shown synchronously on the first render after a switch: the current picture,
 * the one it is dissolving into, and a few recently used agents (each 1920x1200
 * decoded image is about 9 MB). The Cache API above stays the persistent layer.
 */
export const BAKED_MEMORY_ENTRIES = 6;
const memory = new ObjectUrlLru(BAKED_MEMORY_ENTRIES);

/** Synchronous memory-tier read; null means the pair has to be baked or read. */
export function peekBakedUrl(key: string): string | null {
  return memory.get(key);
}

/** Put a finished bake into the memory tier; returns its object URL. */
export function rememberBaked(key: string, blob: Blob): string {
  return memory.put(key, blob);
}

/** Hold the shown key in memory until the returned unpin runs. */
export function pinBaked(key: string): () => void {
  return memory.pin(key);
}

/** Memory first, then the Cache API; a hit fills the memory tier. */
export async function getBakedUrl(key: string): Promise<string | null> {
  const known = peekBakedUrl(key);
  if (known !== null) return known;
  const blob = await getBaked(key);
  return blob === null ? null : rememberBaked(key, blob);
}
