import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { CommitLogEntry, FileScope } from "@/api/types";

/** Commits fetched and shown per page — an initial load, and each "Load more" click. */
const PAGE_SIZE = 50;
/** Mirrors the `limit` clamp the commits route applies server-side. */
const SERVER_MAX_LIMIT = 1000;

export interface SubmoduleCommitState {
  expanded: boolean;
  /** At most `pageLimit + 1` entries — the lookahead entry drives "Load more". */
  commits: CommitLogEntry[] | null;
  pageLimit: number;
  loading: boolean;
  error: string | null;
  loadMoreError: string | null;
}

const INITIAL_STATE: SubmoduleCommitState = {
  expanded: true,
  commits: null,
  pageLimit: PAGE_SIZE,
  loading: true,
  error: null,
  loadMoreError: null,
};

/**
 * Per-submodule commit-list state for the VCS tab's expandable submodule rows.
 * Owned by `VcsPanel` (Key Decision 6) so expanded rows + fetched commits
 * survive opening a commit and going back (Requirement 10) — the commit-view
 * swap unmounts `VcsSubmodules`, but this hook's state lives in VcsPanel.
 *
 * Collapsed-by-default costs nothing: the first expand lazily fetches the
 * submodule's log via `api.listCommits(worktreeId, limit + 1, scope, path)`.
 * An uninitialized submodule's row is expandable but never fires a request —
 * it just shows "Not initialized" (Requirement 6).
 */
export function useSubmoduleCommits(
  api: ApiInstance,
  worktreeId: string,
  scope: FileScope = "worktree",
  uninitializedPaths: Set<string>,
) {
  const [byPath, setByPath] = useState<Record<string, SubmoduleCommitState>>({});
  // Read the latest state from callbacks without re-creating them every render.
  const byPathRef = useRef(byPath);
  useEffect(() => {
    byPathRef.current = byPath;
  }, [byPath]);
  // Bumped on reset()/worktree/scope change so a response for the previous
  // worktree can never repopulate the new worktree's state.
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
  }, [api, worktreeId, scope]);

  const loadFor = useCallback(
    (path: string, limit: number, mode: "initial" | "more") => {
      const gen = generation.current;
      return api
        .listCommits(worktreeId, limit + 1, scope, path)
        .then((list) => {
          if (gen !== generation.current) return;
          setByPath((prev) => ({
            ...prev,
            [path]: {
              ...(prev[path] ?? INITIAL_STATE),
              commits: list,
              pageLimit: limit,
              loading: false,
              error: null,
              loadMoreError: null,
            },
          }));
        })
        .catch((err: unknown) => {
          if (gen !== generation.current) return;
          const message = err instanceof Error ? err.message : String(err);
          setByPath((prev) => ({
            ...prev,
            [path]: {
              ...(prev[path] ?? INITIAL_STATE),
              loading: false,
              ...(mode === "initial" ? { error: message } : { loadMoreError: message }),
            },
          }));
        });
    },
    [api, worktreeId, scope],
  );

  /** Expand/collapse a submodule row; the first expand lazily fetches its log. */
  const toggle = useCallback(
    (path: string) => {
      const cur = byPathRef.current[path];
      if (cur?.expanded) {
        setByPath((prev) => ({
          ...prev,
          [path]: { ...(prev[path] ?? INITIAL_STATE), expanded: false },
        }));
        return;
      }
      if (cur) {
        // Re-expanding after a failed first load retries it.
        const retry = cur.commits == null && !cur.loading && !uninitializedPaths.has(path);
        setByPath((prev) => ({
          ...prev,
          [path]: { ...(prev[path] ?? INITIAL_STATE), expanded: true, ...(retry ? { loading: true, error: null } : {}) },
        }));
        if (retry) void loadFor(path, PAGE_SIZE, "initial");
        return;
      }
      // First expand: no request for an uninitialized submodule (Requirement 6).
      setByPath((prev) => ({ ...prev, [path]: { ...INITIAL_STATE } }));
      if (!uninitializedPaths.has(path)) {
        void loadFor(path, PAGE_SIZE, "initial");
      }
    },
    [loadFor, uninitializedPaths],
  );

  /** "Load more" for one submodule — only loads more; never flips a toggle (Key Decision 7). */
  const loadMore = useCallback(
    (path: string) => {
      const cur = byPathRef.current[path];
      if (!cur?.expanded || cur.loading || cur.commits == null) return;
      const nextLimit = Math.min(cur.pageLimit + PAGE_SIZE, SERVER_MAX_LIMIT);
      setByPath((prev) => ({
        ...prev,
        [path]: { ...(prev[path] ?? INITIAL_STATE), loading: true, loadMoreError: null },
      }));
      void loadFor(path, nextLimit, "more");
    },
    [loadFor],
  );

  /** Collapse every submodule row (worktree change). */
  const reset = useCallback(() => {
    generation.current += 1;
    setByPath({});
  }, []);

  /** Refetch the log of every currently-expanded submodule (manual refresh). */
  const refresh = useCallback(() => {
    const cur = byPathRef.current;
    for (const path of Object.keys(cur)) {
      if (!cur[path]?.expanded || uninitializedPaths.has(path)) continue;
      setByPath((prev) => ({
        ...prev,
        [path]: {
          ...(prev[path] ?? INITIAL_STATE),
          loading: true,
          error: null,
          loadMoreError: null,
        },
      }));
      void loadFor(path, PAGE_SIZE, "initial");
    }
  }, [loadFor, uninitializedPaths]);

  return { byPath, toggle, loadMore, reset, refresh };
}
