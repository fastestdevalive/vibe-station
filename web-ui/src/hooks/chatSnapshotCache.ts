/**
 * Module-level LRU cache of `ChatSnapshot`s, keyed by sessionId.
 * Capped at MAX_CACHE_SIZE entries; each snapshot keeps the newest
 * MAX_SNAPSHOT_EVENTS events.  `save`/`restore`/`evict`/`clear` are the only
 * public surface — auth:expired handling is registered in `useChat`, not here.
 */

import type { NormalizedEvent } from "@/api/types";
import { countUserTurns, isUserTurnEvent } from "@/lib/chatTurns";

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
  /** User turns before the retained window (the saved count plus any cut here); `null` if unknown. */
  turnsBefore: number | null;
  /** Max `logSeq` across all retained events; `null`/0 → skip `sinceSeq`. */
  latestSeq: number | null;
  /** `Date.now()` at save-time — used for the 60-second freshness check. */
  savedAt: number;
}

/** sessionId → snapshot */
const cache = new Map<string, ChatSnapshot>();

/**
 * Index the retained window starts at: the user turn at or before the newest
 * MAX_SNAPSHOT_EVENTS events, so a restored window never opens mid-turn (the
 * outline needs the turn's user row). 0 (keep all) when no such turn exists.
 */
function turnBoundaryCut(events: NormalizedEvent[]): number {
  if (events.length <= MAX_SNAPSHOT_EVENTS) return 0;
  for (let i = events.length - MAX_SNAPSHOT_EVENTS; i > 0; i--) {
    if (isUserTurnEvent(events[i]!)) return i;
  }
  return 0;
}

/**
 * Persist a snapshot.  No-ops when `events` is empty.  Keeps about the newest
 * MAX_SNAPSHOT_EVENTS events, cut on a user-turn boundary; recomputes
 * `oldestSeq` and `turnsBefore`, and sets `hasMore = true` only when events
 * were actually dropped.
 */
export function save(
  sessionId: string,
  snapshot: {
    events: NormalizedEvent[];
    hasMore: boolean;
    userTurnIds: Set<string>;
    /** User turns before `events[0]`; omitted / `null` when unknown. */
    turnsBefore?: number | null;
    latestSeq: number | null;
    savedAt: number;
  },
): void {
  if (snapshot.events.length === 0) return;

  let { events } = snapshot;
  let { hasMore } = snapshot;
  let turnsBefore = snapshot.turnsBefore ?? null;

  const cut = turnBoundaryCut(events);
  if (cut > 0) {
    if (turnsBefore != null) turnsBefore += countUserTurns(events.slice(0, cut));
    events = events.slice(cut);
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
    turnsBefore,
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
