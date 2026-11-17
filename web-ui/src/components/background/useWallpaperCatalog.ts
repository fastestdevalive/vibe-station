import { useSyncExternalStore } from "react";
import type { WallpaperEntry } from "@/api/types";
import { fetchWallpaperCatalog } from "./wallpaperApi";

/**
 * One catalog fetch per page load, shared by every consumer (Decision: the
 * daemon catalog is a bundled snapshot, so there is nothing to poll for).
 *
 * A failure retries at most 3 times (2 s / 8 s / 30 s), then settles on
 * `unavailable` — the window then renders solid instead of waiting forever.
 * Every rejection is handled here so rendering `Layout` without a mocked
 * daemon cannot produce an unhandled rejection.
 */
export interface WallpaperCatalogState {
  status: "loading" | "ready" | "unavailable";
  wallpapers: WallpaperEntry[];
  /** Catalog order (`wp-001..wp-031`, same as mobile) — hash picks match the phone. */
  ids: string[];
}

const RETRY_DELAYS_MS = [2_000, 8_000, 30_000];
const UNAVAILABLE_RETRY_MS = 60_000;

const LOADING: WallpaperCatalogState = { status: "loading", wallpapers: [], ids: [] };

let state: WallpaperCatalogState = LOADING;
let attempt = 0;
let inFlight: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function publish(next: WallpaperCatalogState): void {
  state = next;
  for (const listener of listeners) listener();
}

function clearRetry(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function startLoad(): void {
  if (state.status === "ready" || inFlight !== null) return;
  inFlight = fetchWallpaperCatalog()
    .then((res) => {
      // Build the ready state BEFORE clearing the attempt counter: anything that
      // throws here must reach `.catch` with the real attempt count, otherwise the
      // budget resets and a malformed 200 is retried every 2 s forever.
      const ready: WallpaperCatalogState = {
        status: "ready",
        wallpapers: res.wallpapers,
        ids: res.wallpapers.map((w) => w.id),
      };
      inFlight = null;
      attempt = 0;
      publish(ready);
    })
    .catch(() => {
      inFlight = null;
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        if (state.status !== "unavailable") {
          publish({ status: "unavailable", wallpapers: [], ids: [] });
        }
        retryTimer = setTimeout(() => {
          retryTimer = null;
          startLoad();
        }, UNAVAILABLE_RETRY_MS);
        return;
      }
      attempt += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        startLoad();
      }, delay);
    });
}

function subscribe(listener: () => void): () => void {
  const wasEmpty = listeners.size === 0;
  listeners.add(listener);
  if (wasEmpty) startLoad();
  return () => {
    listeners.delete(listener);
    // Nobody is left to show the result: stop the retry chain. A later mount
    // resumes it (the attempt budget is kept).
    if (listeners.size === 0) clearRetry();
  };
}

function getSnapshot(): WallpaperCatalogState {
  return state;
}

export function useWallpaperCatalog(): WallpaperCatalogState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test-only: forget the cached catalog and any pending retry. */
export function __resetWallpaperCatalogForTests(): void {
  clearRetry();
  inFlight = null;
  attempt = 0;
  publish(LOADING);
}
