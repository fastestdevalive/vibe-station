import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import { useTreeWatch } from "./useSubscription";

/**
 * Coalesce rapid `tree:changed` events into a single background refetch.
 * E.g. an agent that writes 50 files in 200 ms produces 50 events; we want
 * exactly one resulting `/file-list` request once the burst settles.
 */
const REFRESH_DEBOUNCE_MS = 500;

interface CacheEntry {
  files: string[];
  truncated: boolean;
  ts: number;
  stale: boolean;
}

/**
 * Module-level cache keyed by worktreeId — survives QuickOpen close/reopen
 * and remounts of the consuming component. This is what makes the second
 * (and every subsequent) open of Quick Open feel instant.
 */
const cache = new Map<string, CacheEntry>();

/** Test-only: drop all cached file lists. */
export function _clearWorktreeFilesCacheForTest(): void {
  cache.clear();
}

export interface UseWorktreeFilesResult {
  files: string[];
  truncated: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Cached flat-file listing for a worktree.
 *
 * Behavior:
 *  - First call for a worktree triggers a fetch; result is cached.
 *  - Subsequent calls return the cached list immediately.
 *  - `tree:changed` events mark the entry stale, but the stale list is still
 *    returned to the UI (stale-while-revalidate) and a background refetch
 *    starts. The UI never blocks on a refresh of an existing list.
 *  - Pass `worktreeId: null` to disable (e.g., when the consumer is closed).
 *
 * The hook opens its own `tree:watch` via `useTreeWatch`, because
 * `tree:changed` is per-WS-connection state — we cannot assume any other
 * component (e.g. the sidebar) has registered a watch.
 */
export function useWorktreeFiles(
  api: ApiInstance,
  worktreeId: string | null,
): UseWorktreeFilesResult {
  const { lastChanged } = useTreeWatch(api, worktreeId);

  const cached = worktreeId ? cache.get(worktreeId) : undefined;
  const [files, setFiles] = useState<string[]>(cached?.files ?? []);
  const [truncated, setTruncated] = useState<boolean>(cached?.truncated ?? false);
  const [loading, setLoading] = useState<boolean>(!cached && worktreeId !== null);
  const [error, setError] = useState<string | null>(null);
  // Local refresh counter; used by refresh() and stale-detection to retrigger
  // the fetch effect.
  const [refreshTick, setRefreshTick] = useState(0);

  const refresh = useCallback(() => {
    setRefreshTick((t) => t + 1);
  }, []);

  useEffect(() => {
    if (!worktreeId) {
      setFiles([]);
      setTruncated(false);
      setLoading(false);
      setError(null);
      return;
    }

    const existing = cache.get(worktreeId);
    if (existing) {
      // Show stale list immediately. Only fetch if stale or if caller asked
      // for a refresh.
      setFiles(existing.files);
      setTruncated(existing.truncated);
      setError(null);
      if (!existing.stale && refreshTick === 0) {
        setLoading(false);
        return;
      }
    } else {
      setLoading(true);
    }

    const controller = new AbortController();
    void (async () => {
      try {
        const result = await api.fileList(worktreeId, controller.signal);
        if (controller.signal.aborted) return;
        cache.set(worktreeId, {
          files: result.files,
          truncated: result.truncated,
          ts: Date.now(),
          stale: false,
        });
        setFiles(result.files);
        setTruncated(result.truncated);
        setLoading(false);
      } catch (e) {
        if (controller.signal.aborted) return;
        // Some fetch implementations throw an AbortError without flipping
        // signal.aborted at the moment the catch runs — guard explicitly.
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Failed to load files");
        setLoading(false);
      }
    })();

    return () => {
      // Abort the in-flight fetch on unmount, worktree switch, or refresh
      // retrigger. Critical under React 18 strict mode where effects run
      // twice on mount — without abort, we'd fire two HTTP requests.
      controller.abort();
    };
  }, [api, worktreeId, refreshTick]);

  // Mark cache stale on tree:changed and schedule a debounced background
  // refetch. The debounce coalesces bursts (e.g. a bulk agent edit emits
  // dozens of file:changed events in rapid succession; we want one refetch,
  // not dozens). The hook still returns the stale list to the caller
  // immediately — only the refetch is delayed.
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!worktreeId || lastChanged === 0) return;
    const entry = cache.get(worktreeId);
    if (entry) entry.stale = true;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null;
      setRefreshTick((t) => t + 1);
    }, REFRESH_DEBOUNCE_MS);
    return () => {
      // Cleanup on unmount / worktree switch so a pending debounce doesn't
      // fire for a stale subscription.
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
    };
  }, [worktreeId, lastChanged]);

  return { files, truncated, loading, error, refresh };
}
