import { useEffect, useState } from "react";
import { ObjectUrlLru } from "./objectUrlLru";
import { fetchWallpaperBlob } from "./wallpaperApi";
import { thumbUrl } from "./thumbs";

/**
 * The daemon's full image for one wallpaper, as an object URL.
 *
 * Tauri authenticates with a Bearer header, so the image cannot be a plain
 * `<img src>` to the daemon (it would 401); the bytes are fetched through
 * `apiFetch` and turned into a blob URL here. Full images are kept in a small
 * LRU (this hook is their only owner), so a wallpaper shown a moment ago is
 * `ready` on the first render after switching back. The bundled thumb paints
 * immediately and stays as the fallback when nothing is cached yet or the fetch
 * fails.
 */
export type WallpaperImageStatus = "idle" | "loading" | "ready" | "failed";

export interface WallpaperImage {
  src: string | null;
  status: WallpaperImageStatus;
  /** True while `src` is the bundled 16:9 thumb (a placeholder for the full image). */
  isThumb: boolean;
}

/** Full images kept decoded in memory: current, incoming, and a few recent agents. */
export const FULL_IMAGE_ENTRIES = 6;
const fullImages = new ObjectUrlLru(FULL_IMAGE_ENTRIES);

interface ImageState extends WallpaperImage {
  /** The `id|full` this state belongs to; a different key resets it. */
  key: string | null;
}

interface InFlight {
  promise: Promise<Blob>;
  controller: AbortController;
  /** How many mounted hooks still want this request. */
  refs: number;
}

/** One request per `id|full`, shared by every caller while it is pending. */
const IN_FLIGHT = new Map<string, InFlight>();

function keyOf(id: string): string {
  return `${id}|full`;
}

function acquire(key: string, id: string): InFlight {
  const existing = IN_FLIGHT.get(key);
  if (existing !== undefined) {
    existing.refs += 1;
    return existing;
  }
  const controller = new AbortController();
  const entry: InFlight = { promise: Promise.resolve(new Blob()), controller, refs: 1 };
  const settle = () => {
    // Only drop the entry we created: a later request for the same key owns its own.
    if (IN_FLIGHT.get(key) === entry) IN_FLIGHT.delete(key);
  };
  entry.promise = fetchWallpaperBlob(id, "full", controller.signal).then(
    (blob) => {
      settle();
      return blob;
    },
    (err: unknown) => {
      settle();
      throw err;
    },
  );
  IN_FLIGHT.set(key, entry);
  return entry;
}

/** The full image's bytes, sharing a pending request with any mounted layer. */
export function loadFullWallpaperBlob(id: string): Promise<Blob> {
  const key = keyOf(id);
  const entry = acquire(key, id);
  return entry.promise.finally(() => {
    entry.refs -= 1;
    if (entry.refs <= 0 && IN_FLIGHT.get(key) === entry) IN_FLIGHT.delete(key);
  });
}

function release(key: string, entry: InFlight): void {
  entry.refs -= 1;
  if (entry.refs > 0) return;
  if (IN_FLIGHT.get(key) === entry) IN_FLIGHT.delete(key);
  entry.controller.abort();
}

/** Decode before reporting ready, so "ready" means "paints in the next frame". */
async function decode(url: string): Promise<void> {
  const image = new Image();
  image.src = url;
  if (typeof image.decode !== "function") return;
  try {
    await image.decode();
  } catch {
    // A decode failure still paints whenever the browser has the pixels.
  }
}

function initialState(id: string | null): ImageState {
  if (id === null) return { key: null, src: null, status: "idle", isThumb: false };
  const key = keyOf(id);
  const cached = fullImages.get(key);
  if (cached !== null) return { key, src: cached, status: "ready", isThumb: false };
  return { key, src: thumbUrl(id) ?? null, status: "loading", isThumb: true };
}

/** Test-only: forget pending requests and the memory tier between cases. */
export function __resetWallpaperImageForTests(): void {
  for (const entry of IN_FLIGHT.values()) entry.controller.abort();
  IN_FLIGHT.clear();
  fullImages.clear();
}

export function useWallpaperImage(id: string | null): WallpaperImage {
  const key = id === null ? null : keyOf(id);
  const [state, setState] = useState<ImageState>(() => initialState(id));
  // Same "adjust state when an input changes" pattern as `useBakedWallpaper`.
  if (state.key !== key) setState(initialState(id));

  useEffect(() => {
    if (key === null || id === null) return;

    const unpin = fullImages.pin(key);
    if (state.key === key && state.status === "ready") return unpin;

    let cancelled = false;
    const thumb = thumbUrl(id) ?? null;

    const entry = acquire(key, id);
    entry.promise
      .then(async (blob) => {
        if (cancelled) return;
        const url = fullImages.put(key, blob);
        await decode(url);
        if (cancelled) return;
        setState({ key, src: url, status: "ready", isThumb: false });
      })
      .catch(() => {
        if (!cancelled) setState({ key, src: thumb, status: "failed", isThumb: true });
      });

    return () => {
      cancelled = true;
      release(key, entry);
      unpin();
    };
  }, [key]);

  return { src: state.src, status: state.status, isThumb: state.isThumb };
}
