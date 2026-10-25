import { useMemo } from "react";
import type { Project, Session, SessionState, Worktree } from "@/api/types";
import { useServerStore } from "@/hooks/useServerStore";
import { useWorkspaceStore } from "@/hooks/useStore";
import { worktreeIsInactive } from "@/lib/worktreeStatus";

/**
 * Per-project visibility rules for the sidebar's worktree rows — the exact
 * predicate the tree has always applied inline:
 *
 *   1. archived (`hiddenAt != null`) worktrees never appear;
 *   2. with "Hide done" on, inactive worktrees (`worktreeIsInactive`) drop out;
 *   3. with a search active, a worktree stays only when its own label/branch
 *      (or one of its sessions) matches — unless the project name itself
 *      matches, in which case every worktree of that project stays visible.
 *
 * `worktreeMatchesQuery` is supplied by the caller because the fuzzy-search
 * matcher depends on session labels/supersede rules the sidebar already
 * derives; keeping one implementation avoids two subtly different searches.
 */
export interface VisibleWorktreeFilterOptions {
  hideInactiveWorktrees: boolean;
  /** worktreeId -> its sessions. */
  sessionsByWorktree: Record<string, Session[]>;
  sessionStates: Record<string, SessionState>;
  /** True when a search query is active (already trimmed). */
  queryActive: boolean;
  /** True when the project's own name matches the query — keeps all rows. */
  projectMatches: boolean;
  worktreeMatchesQuery: (worktree: Worktree) => boolean;
}

/** Pure: apply the visibility rules to one project's (non-hidden) worktrees. */
export function filterVisibleWorktrees(
  worktrees: readonly Worktree[],
  opts: VisibleWorktreeFilterOptions,
): Worktree[] {
  return worktrees.filter((w) => {
    if (
      opts.hideInactiveWorktrees &&
      worktreeIsInactive(opts.sessionsByWorktree[w.id] ?? [], opts.sessionStates)
    ) {
      return false;
    }
    if (!opts.queryActive || opts.projectMatches) return true;
    return opts.worktreeMatchesQuery(w);
  });
}

export interface UseVisibleWorktreesArgs {
  /** Projects to produce a list for (the sidebar's project rows). */
  projects: readonly Project[];
  hideInactiveWorktrees: boolean;
  /** Trimmed search query (`""` when no search is active). */
  trimmedQuery: string;
  projectDirectlyMatches: (project: Project) => boolean;
  worktreeMatchesQuery: (worktree: Worktree) => boolean;
}

/**
 * `projectId -> visible worktrees` for the whole sidebar. Read once per
 * render (not per expanded project) so the project row can offer "Select
 * all" over exactly the rows the tree would show, whether or not that
 * project is expanded.
 *
 * Worktrees/sessions come from `useServerStore` — the single source of server
 * truth (AGENTS.md) — so no caller keeps a second filtered copy.
 */
export function useVisibleWorktrees({
  projects,
  hideInactiveWorktrees,
  trimmedQuery,
  projectDirectlyMatches,
  worktreeMatchesQuery,
}: UseVisibleWorktreesArgs): Record<string, Worktree[]> {
  const worktrees = useServerStore((s) => s.worktrees);
  const sessions = useServerStore((s) => s.sessions);
  const sessionStates = useWorkspaceStore((s) => s.sessionStates);

  return useMemo(() => {
    const byProject: Record<string, Worktree[]> = {};
    for (const w of worktrees) {
      if (w.hiddenAt != null) continue;
      (byProject[w.projectId] ??= []).push(w);
    }
    const sessionsByWorktree: Record<string, Session[]> = {};
    for (const s of sessions) {
      if (s.worktreeId == null) continue;
      (sessionsByWorktree[s.worktreeId] ??= []).push(s);
    }

    const queryActive = trimmedQuery.length > 0;
    const visible: Record<string, Worktree[]> = {};
    for (const p of projects) {
      visible[p.id] = filterVisibleWorktrees(byProject[p.id] ?? [], {
        hideInactiveWorktrees,
        sessionsByWorktree,
        sessionStates,
        queryActive,
        projectMatches: projectDirectlyMatches(p),
        worktreeMatchesQuery,
      });
    }
    return visible;
  }, [
    worktrees,
    sessions,
    sessionStates,
    projects,
    hideInactiveWorktrees,
    trimmedQuery,
    projectDirectlyMatches,
    worktreeMatchesQuery,
  ]);
}
