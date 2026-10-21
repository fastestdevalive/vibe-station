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
