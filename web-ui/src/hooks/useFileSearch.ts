import { useEffect, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { FileScope } from "@/api/types";

/**
 * Debounced, abort-on-supersede file search query.
 *
 * Behavior:
 *  - `worktreeId === null` disables the hook entirely — no debounce timer, no
 *    network request, returns the empty state. Callers use this to signal
 *    "don't search" (e.g. a `:digit`/`>` prefix in Quick Open).
 *  - Otherwise `query` is debounced by 60ms; only the last keystroke's value
 *    ever fires a request (abort-on-supersede cancels the previous in-flight
 *    one, and superseded responses never touch state).
 *  - While the result reports `indexing` (first walk still running, no data
 *    yet), the same query is re-issued every 500ms. After 30s it keeps polling
 *    at a slower 2s cadence (never gives up: a giving-up hook would fake a
 *    "No files found" empty state) and sets `slowIndexing`. The poll stops when
 *    the query/target changes, the result is no longer indexing, or the
 *    component unmounts; each re-query still aborts its predecessor.
 *  - Both `scope === "worktree"` and `scope === "project"` query the daemon's
 *    server-owned filename index via `api.fileSearch`; no client-side scoring.
 *
 * The server is the single source of truth for freshness — this hook holds no
 * module-level cache and never calls `useTreeWatch`.
 */
const DEBOUNCE_MS = 60;
const LIMIT = 50;
/** While the daemon reports `indexing`, re-run the same query on this cadence… */
const INDEXING_POLL_MS = 500;
/** …after this long the listing is "taking longer than usual": flag it and slow the poll. */
const INDEXING_SLOW_AFTER_MS = 30_000;
const INDEXING_SLOW_POLL_MS = 2_000;

export interface UseFileSearchResult {
  files: string[];
  truncated: boolean;
  /** Server is still building its first index for this target; `files` is empty. */
  indexing: boolean;
  /** `indexing` for longer than 30s; UI says so instead of showing an empty state. */
  slowIndexing: boolean;
  loading: boolean;
  error: string | null;
}

export function useFileSearch(
  api: ApiInstance,
  worktreeId: string | null,
  query: string,
  scope: FileScope = "worktree",
): UseFileSearchResult {
  const [files, setFiles] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [slowIndexing, setSlowIndexing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Guards setState below against a request that resolves/rejects after the
  // hook's component unmounts.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      abortControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!worktreeId) {
      // Disabled: cancel anything still in flight and reset to the empty
      // state. No request is ever issued for this case.
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      setFiles([]);
      setTruncated(false);
      setIndexing(false);
      setSlowIndexing(false);
      setLoading(false);
      setError(null);
      return;
    }

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    let stopped = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let indexingSince = 0;

    const run = (isPoll: boolean) => {
      // Cancel the previous in-flight request before issuing a new one.
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      // Polls re-query silently: no loading flicker over the indexing row.
      if (!isPoll) {
        setLoading(true);
        setError(null);
      }

      void (async () => {
        try {
          const result = await api.fileSearch(worktreeId, query, LIMIT, controller.signal, scope);
          if (abortControllerRef.current !== controller || !isMountedRef.current) return;
          setFiles(result.files);
          setTruncated(result.truncated);
          const stillIndexing = result.indexing === true;
          setIndexing(stillIndexing);
          if (stillIndexing && !stopped) {
            if (!isPoll) indexingSince = Date.now();
            const slow = Date.now() - indexingSince >= INDEXING_SLOW_AFTER_MS;
            setSlowIndexing(slow);
            pollTimer = setTimeout(
              () => run(true),
              slow ? INDEXING_SLOW_POLL_MS : INDEXING_POLL_MS,
            );
          } else {
            setSlowIndexing(false);
          }
        } catch (e) {
          // Superseded by a newer request or unmounted: neither an AbortError
          // nor any other rejection racing a fresher request is a real error
          // to surface — clearing `files`/`error` here would clobber the
          // newer request's state.
          if (abortControllerRef.current !== controller || !isMountedRef.current) return;
          if (e instanceof Error && e.name !== "AbortError") {
            setError(e.message || "File search failed");
            setFiles([]);
            setTruncated(false);
            setIndexing(false);
            setSlowIndexing(false);
          }
        } finally {
          if (abortControllerRef.current === controller && isMountedRef.current) {
            setLoading(false);
          }
        }
      })();
    };

    debounceTimerRef.current = setTimeout(() => run(false), DEBOUNCE_MS);

    return () => {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [api, worktreeId, query, scope]);

  return { files, truncated, indexing, slowIndexing, loading, error };
}
