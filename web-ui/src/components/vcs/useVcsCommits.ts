import { useEffect, useMemo, useState, useCallback } from "react";
import type { ApiInstance } from "@/api";
import type { CommitLogEntry, FileScope } from "@/api/types";
import { useVcsCacheStore, vcsKey, type VcsStatus } from "./vcsCacheStore";

export const VCS_PAGE_SIZE = 50;
/** Mirrors the clamp `GET /worktrees/:id/commits` applies server-side. */
export const VCS_SERVER_MAX_LIMIT = 1000;
/** A revalidation shows its spinner only after this delay: a fast refresh never flickers. */
const REFRESHING_DELAY_MS = 300;

/** One in-flight revalidation per cache key. Starting a new one aborts the old one's result (it is ignored). */
const inflight = new Map<string, AbortController>();
/** Worktrees already focused this page session (their `origin/<base>` refresh is then driven by the daemon). */
const focusedWorktrees = new Set<string>();

const EMPTY: CommitLogEntry[] = [];

export interface UseVcsCommitsOptions {
  api: ApiInstance;
  id: string;
  scope: FileScope;
  submodule?: string;
  pageLimit?: number;
}

export interface UseVcsCommitsResult {
  /** The current page (the lookahead entry used for `hasMore` is never returned). */
  commits: CommitLogEntry[];
  hasMore: boolean;
  status: VcsStatus;
  /** A revalidation is in flight for longer than `REFRESHING_DELAY_MS`. */
  refreshing: boolean;
  error: string | undefined;
  /** Age of the rows in ms, or null when nothing was fetched yet. Read at render time. */
  staleAgeMs: number | null;
  refresh: () => void;
  loadMore: () => void;
}

/**
 * Starts one revalidation for a cache key. It fills the module-level store even after the list unmounts, so a
 * warm reopen paints from the cache. A cold entry (no ready rows) starts in `loading`.
 */
function revalidate(api: ApiInstance, key: string, id: string, scope: FileScope, submodule: string | undefined, limit: number): void {
  inflight.get(key)?.abort();
  const controller = new AbortController();
  inflight.set(key, controller);
  const store = useVcsCacheStore.getState();
  const cur = store.entries[key];
  store.beginLoad(key, { cold: cur?.status !== "ready", pageLimit: limit });
  api
    .listCommits(id, limit + 1, scope, submodule)
    .then((list) => {
      if (controller.signal.aborted) return;
      inflight.delete(key);
      useVcsCacheStore.getState().replace(key, list, limit);
    })
    .catch((err: unknown) => {
      if (controller.signal.aborted) return;
      inflight.delete(key);
      useVcsCacheStore.getState().fail(key, err instanceof Error ? err.message : String(err));
    });
}

/** Test seam: forget in-flight requests and the per-session focus set. */
export function resetVcsRevalidationForTests(): void {
  for (const c of inflight.values()) c.abort();
  inflight.clear();
  focusedWorktrees.clear();
}

/**
 * Commit list for one (scope, id, submodule). Paints the cached entry at once, then revalidates on mount, when the
 * entry turns stale (`useVcsSync`), and on `refresh()`. The first mount per worktree, and every `refresh()`, also
 * calls `focusWorktree` so the daemon refreshes `origin/<base>` in the background (worktree scope only).
 */
export function useVcsCommits({ api, id, scope, submodule, pageLimit = VCS_PAGE_SIZE }: UseVcsCommitsOptions): UseVcsCommitsResult {
  const key = vcsKey(scope, id, submodule);
  const entry = useVcsCacheStore((s) => s.entries[key]);
  const limit = entry && entry.pageLimit > 0 ? entry.pageLimit : pageLimit;
  const refreshingNow = entry?.refreshing ?? false;
  const stale = entry?.stale ?? false;
  const [showRefreshing, setShowRefreshing] = useState(false);

  // Mount / key change: revalidate. Focus the worktree once per page session.
  useEffect(() => {
    if (scope === "worktree" && !focusedWorktrees.has(id)) {
      focusedWorktrees.add(id);
      void api.focusWorktree(id).catch(() => undefined);
    }
    const e = useVcsCacheStore.getState().entries[key];
    revalidate(api, key, id, scope, submodule, e && e.pageLimit > 0 ? e.pageLimit : pageLimit);
    // The cache fill is intentionally not aborted on unmount: a warm reopen paints from it.
  }, [api, key]);

  // Stale flip (head changed, ws:open, ws:resync) while mounted: refetch at the current page size.
  useEffect(() => {
    if (!stale) return;
    const e = useVcsCacheStore.getState().entries[key];
    revalidate(api, key, id, scope, submodule, e && e.pageLimit > 0 ? e.pageLimit : pageLimit);
  }, [stale]);

  // Spinner delay: visible only after REFRESHING_DELAY_MS of a revalidation.
  useEffect(() => {
    if (!refreshingNow) return;
    const t = setTimeout(() => setShowRefreshing(true), REFRESHING_DELAY_MS);
    return () => {
      clearTimeout(t);
      setShowRefreshing(false);
    };
  }, [refreshingNow]);

  const raw = entry?.commits;
  const commits = useMemo(() => (raw ? raw.slice(0, limit) : EMPTY), [raw, limit]);
  const hasMore = raw != null && raw.length > limit && limit < VCS_SERVER_MAX_LIMIT;

  const refresh = useCallback(() => {
    if (scope === "worktree") void api.focusWorktree(id).catch(() => undefined);
    const e = useVcsCacheStore.getState().entries[key];
    revalidate(api, key, id, scope, submodule, e && e.pageLimit > 0 ? e.pageLimit : pageLimit);
  }, [api, key, id, scope, submodule, pageLimit]);

  const loadMore = useCallback(() => {
    const e = useVcsCacheStore.getState().entries[key];
    const current = e && e.pageLimit > 0 ? e.pageLimit : pageLimit;
    revalidate(api, key, id, scope, submodule, Math.min(current + VCS_PAGE_SIZE, VCS_SERVER_MAX_LIMIT));
  }, [api, key, id, scope, submodule, pageLimit]);

  return {
    commits,
    hasMore,
    status: entry?.status ?? "loading",
    refreshing: refreshingNow && showRefreshing,
    error: entry?.error,
    staleAgeMs: entry?.fetchedAt != null ? Date.now() - entry.fetchedAt : null,
    refresh,
    loadMore,
  };
}
