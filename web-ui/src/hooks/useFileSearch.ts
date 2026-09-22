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
 *  - `scope === "worktree"` queries the daemon's server-owned filename index
 *    via `api.fileSearch`. `scope === "project"` reuses the existing
 *    `api.fileList` endpoint (no daemon-side watcher exists for project scope)
 *    and scores the returned paths client-side with QuickOpen's old 3-tier
 *    bucket logic.
 *
 * The server is the single source of truth for freshness — this hook holds no
 * module-level cache and never calls `useTreeWatch`.
 */
const DEBOUNCE_MS = 60;
const LIMIT = 50;

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

/** Ported from the old QuickOpen.tsx `filtered` useMemo (3-tier bucket scoring). */
function scoreProjectFiles(files: string[], query: string): string[] {
  const q = query.toLowerCase();
  const scored: { path: string; name: string; score: number }[] = [];
  for (const path of files) {
    const name = basename(path);
    const nameMatch = name.toLowerCase().indexOf(q);
    const pathMatch = path.toLowerCase().indexOf(q);
    const score = nameMatch === 0 ? 3 : nameMatch > 0 ? 2 : pathMatch >= 0 ? 1 : 0;
    if (score > 0) scored.push({ path, name, score });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, LIMIT).map((s) => s.path);
}

export interface UseFileSearchResult {
  files: string[];
  truncated: boolean;
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
      setLoading(false);
      setError(null);
      return;
    }

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      // Cancel the previous in-flight request before issuing a new one.
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setLoading(true);
      setError(null);

      void (async () => {
        try {
          if (scope === "worktree") {
            const result = await api.fileSearch(worktreeId, query, LIMIT, controller.signal);
            if (abortControllerRef.current !== controller || !isMountedRef.current) return;
            setFiles(result.files);
            setTruncated(result.truncated);
          } else {
            const result = await api.fileList(worktreeId, controller.signal, "project");
            if (abortControllerRef.current !== controller || !isMountedRef.current) return;
            setFiles(scoreProjectFiles(result.files, query));
            setTruncated(result.files.length > LIMIT);
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
          }
        } finally {
          if (abortControllerRef.current === controller && isMountedRef.current) {
            setLoading(false);
          }
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [api, worktreeId, query, scope]);

  return { files, truncated, loading, error };
}
