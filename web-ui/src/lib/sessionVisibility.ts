import type { Session } from "@/api/types";

/**
 * Pure helpers that define which agent sessions are "tab-visible" and how the
 * active agent is re-selected when the current one stops being valid (deleted,
 * superseded, hidden). Single source of truth shared by the URL-sync hooks and
 * the store actions (Decision 6) — TabsStrip imports the comparator/visibility
 * helpers so no component keeps a divergent copy of the rules.
 *
 * A session is a "tab-visible agent" iff:
 *   - `type === "agent"`, and
 *   - `supersededBy == null` (hidden from the tab strip on reset/supersede).
 *
 * Deleted sessions are absent from the server list entirely; superseded ones
 * linger in the list but are hidden from tabs — visibility, not list
 * membership, is the axis this module operates on (Decision 1).
 */

/** True iff `s` is an agent session that belongs in the tab strip. */
export function isTabVisibleAgent(s: Session): boolean {
  return s.type === "agent" && s.supersededBy == null;
}

/**
 * Deterministic tab-order comparator — `sortOrder ?? 0`, then `id`. Must match
 * TabsStrip's `orderedSessions` sort so neighbor selection agrees with the
 * rendered strip. TabsStrip imports this so the two can never diverge.
 */
export function compareTabOrder(a: Session, b: Session): number {
  const ao = a.sortOrder ?? 0;
  const bo = b.sortOrder ?? 0;
  if (ao !== bo) return ao - bo;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Follow the `supersededBy` chain from `id` to its final replacement. If `id`
 * is not superseded (or not found), returns `id` unchanged.
 */
export function resolveSupersededChain(id: string, sessions: Session[]): string {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const seen = new Set<string>();
  let cur = id;
  while (seen.size <= sessions.length) {
    const s = byId.get(cur);
    if (!s || !s.supersededBy) return cur;
    if (seen.has(cur)) return cur; // cycle guard — never infinite-loop
    seen.add(cur);
    cur = s.supersededBy;
  }
  return cur;
}

/**
 * Pick the worktree's active agent session, in priority order:
 *   1. `explicitId`, if it is a tab-visible agent in `sessions`
 *   2. `lastId`, if it is a tab-visible, non-exited agent in `sessions`
 *   3. the main (non-archived) tab-visible agent
 *   4. the first tab-visible, non-archived agent by `compareTabOrder`
 *   5. the first tab-visible agent by `compareTabOrder`
 *   6. null (no valid agent)
 *
 * `sessions` is expected to be pre-filtered to the worktree; only tab-visible
 * agents are ever considered.
 */
export function pickWorktreeAgent(
  sessions: Session[],
  opts: { explicitId?: string | null; lastId?: string | null },
): string | null {
  const visible = sessions.filter(isTabVisibleAgent);
  if (visible.length === 0) return null;

  if (opts.explicitId != null && visible.some((s) => s.id === opts.explicitId)) {
    return opts.explicitId;
  }
  if (
    opts.lastId != null &&
    visible.some((s) => s.id === opts.lastId && s.state !== "exited")
  ) {
    return opts.lastId;
  }
  const nonArchived = visible.filter((s) => s.archivedAt == null);
  const main = nonArchived.find((s) => s.isMain);
  if (main) return main.id;
  if (nonArchived.length > 0) return [...nonArchived].sort(compareTabOrder)[0]!.id;
  return [...visible].sort(compareTabOrder)[0]!.id;
}

/**
 * Pick the first tab-visible direct agent whose id is in `openTabIds`.
 * Returns null when none match.
 */
export function pickFirstDirectAgent(openTabIds: string[], sessions: Session[]): string | null {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const candidates = openTabIds
    .map((id) => byId.get(id))
    .filter((s): s is Session => !!s && isTabVisibleAgent(s))
    .sort(compareTabOrder);
  return candidates[0]?.id ?? null;
}

/**
 * Pick the direct agent to select after `closed` is removed, from the tabs
 * that were open BEFORE the removal (`openTabIds`). `sessions` may already be
 * post-deletion (the closed row absent). Preference: the visible tab-visible
 * agent immediately before `closed` in `compareTabOrder`, else the first
 * remaining visible tab-visible agent, else null.
 */
export function pickNextDirectAgent(
  openTabIds: string[],
  closed: Session,
  sessions: Session[],
): string | null {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const remaining = openTabIds
    .filter((id) => id !== closed.id)
    .map((id) => byId.get(id))
    .filter((s): s is Session => !!s && isTabVisibleAgent(s))
    .sort(compareTabOrder);
  if (remaining.length === 0) return null;

  const closedSortOrder = closed.sortOrder ?? 0;
  const before = remaining.filter((s) => {
    const so = s.sortOrder ?? 0;
    if (so !== closedSortOrder) return so < closedSortOrder;
    return s.id < closed.id;
  });
  return (before[before.length - 1] ?? remaining[0])!.id;
}
