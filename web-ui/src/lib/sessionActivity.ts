/**
 * Session / worktree "last activity" derivation. The daemon pushes
 * `lastActivityAt` per session (`session:activity`); a session never seen
 * active since the upgrade has none, so the client falls back to `createdAt`
 * (which the wire fills with the last lifecycle transition).
 *
 * Worktree activity is derived here, not on the wire: one source of truth
 * (the sessions in `useServerStore`), nothing to keep in sync.
 */
import type { Session } from "@/api/types";

type ActivityFields = Pick<Session, "lastActivityAt" | "createdAt">;

/** ISO timestamp of the session's last activity (falls back to `createdAt`). */
export function sessionActivityAt(s: ActivityFields): string | null {
  return s.lastActivityAt || s.createdAt || null;
}

function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** worktreeId -> newest `sessionActivityAt` over its non-archived sessions. */
export function buildWorktreeActivityMap(
  sessions: ReadonlyArray<Pick<Session, "worktreeId" | "archivedAt" | "lastActivityAt" | "createdAt">>,
): Map<string, string> {
  const best = new Map<string, { ms: number; iso: string }>();
  for (const s of sessions) {
    if (s.worktreeId == null || s.archivedAt != null) continue;
    const iso = sessionActivityAt(s);
    const ms = toMs(iso);
    if (iso == null || ms == null) continue;
    const cur = best.get(s.worktreeId);
    if (!cur || ms > cur.ms) best.set(s.worktreeId, { ms, iso });
  }
  return new Map([...best].map(([id, v]) => [id, v.iso]));
}

/**
 * Newest first. Stable (ties keep input order); items with no/invalid
 * timestamp sort last. Does not mutate `items`.
 */
export function sortByActivity<T>(items: readonly T[], at: (t: T) => string | null | undefined): T[] {
  return items
    .map((item, index) => ({ item, index, ms: toMs(at(item)) }))
    .sort((a, b) => {
      if (a.ms == null && b.ms == null) return a.index - b.index;
      if (a.ms == null) return 1;
      if (b.ms == null) return -1;
      return b.ms - a.ms || a.index - b.index;
    })
    .map((x) => x.item);
}

/** Cards whose activity differs by no more than this keep their relative order. */
export const ORDER_STABILITY_MS = 3 * 60 * 1000;

/**
 * Order `items` newest-activity-first, but with hysteresis: starting from the
 * previous order (`prevIds`), an item only jumps ahead of a neighbour once it
 * is MORE than `thresholdMs` newer. Items within the threshold of each other
 * never swap, so a busy list doesn't reshuffle on every tick. Unknown ids
 * enter at their newest-first position; vanished ids are dropped.
 */
export function stableActivityOrder<T>(
  items: readonly T[],
  idOf: (t: T) => string,
  at: (t: T) => string | null | undefined,
  prevIds: readonly string[],
  thresholdMs: number = ORDER_STABILITY_MS,
): T[] {
  const byId = new Map(items.map((i) => [idOf(i), i]));
  const kept = prevIds.filter((id) => byId.has(id));
  const known = new Set(kept);
  // Fresh arrivals are placed by the plain sort, then merged by the pass below.
  const fresh = sortByActivity(items, at).filter((i) => !known.has(idOf(i)));
  const arr = [...kept.map((id) => byId.get(id) as T), ...fresh];
  const ms = (t: T) => toMs(at(t)) ?? -Infinity;
  // Insertion pass: an item moves up to just above the topmost item it beats
  // by more than the threshold (comparing only the neighbour would let a
  // chain of small gaps strand a much newer item at the bottom).
  for (let i = 1; i < arr.length; i++) {
    const cur = arr[i] as T;
    let k = arr.slice(0, i).findIndex((o) => ms(cur) - ms(o) > thresholdMs);
    if (k < 0) continue;
    for (let j = i; j > k; j--) arr[j] = arr[j - 1] as T;
    arr[k] = cur;
  }
  return arr;
}
