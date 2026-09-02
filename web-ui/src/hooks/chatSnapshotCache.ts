/**
 * Module-level LRU cache of `ChatSnapshot`s, keyed by sessionId.
 * Capped at MAX_CACHE_SIZE entries; each snapshot keeps the newest
 * MAX_SNAPSHOT_EVENTS events.  `save`/`restore`/`evict`/`clear` are the only
 * public surface — auth:expired handling is registered in `useChat`, not here.
 */

import type { NormalizedEvent } from "@/api/types";

const MAX_SNAPSHOT_EVENTS = 200;
const MAX_CACHE_SIZE = 20;

export interface ChatSnapshot {
  events: NormalizedEvent[];
  /** `logSeq` of the oldest retained event after truncation; `null` if unknown. */
  oldestSeq: number | null;
  /** True when older events exist before the retained window. */
  hasMore: boolean;
  /** Union of all `turnId`s seen in the retained window. */
  userTurnIds: Set<string>;
  /** Max `logSeq` across all retained events; `null`/0 → skip `sinceSeq`. */
  latestSeq: number | null;
  /** `Date.now()` at save-time — used for the 60-second freshness check. */
  savedAt: number;
}

/** sessionId → snapshot */
const cache = new Map<string, ChatSnapshot>();

/**
 * Persist a snapshot.  No-ops when `events` is empty.  Truncates to the newest
 * MAX_SNAPSHOT_EVENTS events, recomputes `oldestSeq`, and forces `hasMore =
 * true` when truncation occurred.
 */
export function save(
  sessionId: string,
  snapshot: {
    events: NormalizedEvent[];
    hasMore: boolean;
    userTurnIds: Set<string>;
    latestSeq: number | null;
    savedAt: number;
  },
): void {
  if (snapshot.events.length === 0) return;

  let { events } = snapshot;
  let { hasMore } = snapshot;

  const truncated = events.length > MAX_SNAPSHOT_EVENTS;
  if (truncated) {
    events = events.slice(events.length - MAX_SNAPSHOT_EVENTS);
    hasMore = true;
  }

  const oldestSeq = events[0]?.logSeq ?? null;

  // LRU eviction: remove the oldest entry when at capacity (and this sessionId
  // is not already in the cache — inserting an existing key doesn't grow it).
  if (cache.size >= MAX_CACHE_SIZE && !cache.has(sessionId)) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }

  // Move this entry to the "most recently used" position.
  cache.delete(sessionId);
  cache.set(sessionId, {
    events,
    oldestSeq,
    hasMore,
    // Minor Fix B: copy the Set to avoid storing the caller's live reference
    // (defensive — the ref is reassigned not mutated, but this is fragile).
    userTurnIds: new Set(snapshot.userTurnIds),
    latestSeq: snapshot.latestSeq,
    savedAt: snapshot.savedAt,
  });
}

/** Return the cached snapshot for `sessionId`, or `null` if absent. */
export function restore(sessionId: string): ChatSnapshot | null {
  return cache.get(sessionId) ?? null;
}

/** Remove a specific session's snapshot (e.g. on `session:fork` or `session:error`). */
export function evict(sessionId: string): void {
  cache.delete(sessionId);
}

/** Drop all snapshots (called on `auth:expired`). */
export function clear(): void {
  cache.clear();
}
