/**
 * Module-level LRU cache of whole-chat outline summaries (about 10 KB each), keyed by sessionId.
 * Capped at MAX_CACHE_SIZE entries. `save`/`restore`/`evict`/`clear` are the only public surface;
 * auth:expired handling is registered in the owner hook.
 */

import type { OutlineSummaryState } from "./useTranscriptOutline";

const MAX_CACHE_SIZE = 20;

const cache = new Map<string, OutlineSummaryState>();

/** Persist a ready summary, making it the most recently saved entry. */
export function save(sessionId: string, summary: OutlineSummaryState): void {
  // LRU eviction: drop the oldest entry when at capacity and this id is new.
  if (cache.size >= MAX_CACHE_SIZE && !cache.has(sessionId)) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.delete(sessionId);
  cache.set(sessionId, summary);
}

/** Return the cached summary for `sessionId`, or `null` if absent. */
export function restore(sessionId: string): OutlineSummaryState | null {
  return cache.get(sessionId) ?? null;
}

/** Remove a specific session's summary (e.g. on `session:fork`). */
export function evict(sessionId: string): void {
  cache.delete(sessionId);
}

/** Drop all summaries (called on `auth:expired`). */
export function clear(): void {
  cache.clear();
}
