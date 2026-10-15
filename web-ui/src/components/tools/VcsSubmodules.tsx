import { ChevronRight } from "lucide-react";
import type { SubmoduleInfo } from "@/api/types";
import { CommitRow, splitOwnCommits } from "@/components/tools/VcsCommitRow";
import type { SubmoduleCommitState } from "@/hooks/useSubmoduleCommits";

/** Label + modifier class for a submodule's `git submodule status` state. */
function submoduleStatus(status: SubmoduleInfo["status"]): { label: string; modifier: string } {
  switch (status) {
    case "clean":
      return { label: "Clean", modifier: "clean" };
    case "modified":
      return { label: "Modified", modifier: "modified" };
    case "out-of-date":
      return { label: "Out of date", modifier: "out-of-date" };
    case "uninitialized":
      return { label: "Uninitialized", modifier: "uninitialized" };
  }
}

interface VcsSubmodulesProps {
  submodules: SubmoduleInfo[];
  /** Per-path commit-list state, owned by `VcsPanel` via `useSubmoduleCommits`. */
  states: Record<string, SubmoduleCommitState>;
  onToggle: (path: string) => void;
  onLoadMore: (path: string) => void;
  onOpenDiff: (sha: string, submodule: string) => void;
  /** "Diff from main" effective flag (already collapsed to false under project
   *  scope) — ON shows only the submodule's own commits (per the base pin),
   *  OFF shows the full log. */
  diffFromMainEff: boolean;
}

/**
 * Top-level `.gitmodules` submodules section, shown below the commit list when
 * the worktree has any. Each row collapses to its one-line summary (exactly as
 * before) and expands inline into the same commit-graph UI the main repo gets:
 * a "Commits (N)" header + `<ol className="vcs-graph">` of `CommitRow`, with
 * load-more, inline error, and a "Not initialized" state for uninitialized
 * submodules (no request fired). Purely presentational — commit state and
 * fetching live in `useSubmoduleCommits` (owned by VcsPanel).
 */
export function VcsSubmodules({
  submodules,
  states,
  onToggle,
  onLoadMore,
  onOpenDiff,
  diffFromMainEff,
}: VcsSubmodulesProps) {
  if (submodules.length === 0) return null;
  return (
    <div className="vcs-submodules">
      <div className="vcs-submodules__header">Submodules</div>
      <ul className="vcs-submodules__list">
        {submodules.map((s) => {
          const state = states[s.path];
          const expanded = state?.expanded ?? false;
          const { label, modifier } = submoduleStatus(s.status);
          return (
            <li
              key={s.path}
              className={`vcs-submodules__row${expanded ? " vcs-submodules__row--expanded" : ""}`}
            >
              <button
                type="button"
                className="vcs-submodules__toggle"
                aria-expanded={expanded}
                onClick={() => onToggle(s.path)}
              >
                <ChevronRight
                  size={12}
                  aria-hidden
                  className={`vcs-submodules__chevron${expanded ? " vcs-submodules__chevron--open" : ""}`}
                />
                <span className="vcs-submodules__path" title={s.path}>
                  {s.path}
                </span>
                {s.shortSha ? <code className="vcs-submodules__sha">{s.shortSha}</code> : null}
                <span className="vcs-submodules__subject" title={s.subject ?? undefined}>
                  {s.subject ?? "—"}
                </span>
                <span className={`vcs-submodules__badge vcs-submodules__badge--${modifier}`}>{label}</span>
              </button>
              {expanded ? (
                <div className="vcs-submodules__expanded">
                  {s.status === "uninitialized" ? (
                    <div className="vcs-submodules__not-init">Not initialized</div>
                  ) : state?.commits == null ? (
                    <div className="vcs-submodules__loading">
                      {state?.error ? `Failed to load commits: ${state.error}` : "Loading commits…"}
                    </div>
                  ) : (
                    <SubmoduleCommitList
                      path={s.path}
                      state={state}
                      diffFromMainEff={diffFromMainEff}
                      onLoadMore={onLoadMore}
                      onOpenDiff={onOpenDiff}
                    />
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SubmoduleCommitList({
  path,
  state,
  diffFromMainEff,
  onLoadMore,
  onOpenDiff,
}: {
  path: string;
  state: SubmoduleCommitState;
  diffFromMainEff: boolean;
  onLoadMore: (path: string) => void;
  onOpenDiff: (sha: string, submodule: string) => void;
}) {
  const commits = state.commits ?? [];
  // Trim the lookahead entry `hasMore` uses, mirroring the main list.
  const pageCommits = commits.slice(0, state.pageLimit);
  const displayedCommits = diffFromMainEff ? splitOwnCommits(pageCommits) : pageCommits;
  const hasMore = commits.length > state.pageLimit;
  return (
    <>
      <div className="vcs-submodules__commits-header">
        Commits ({displayedCommits.length})
      </div>
      {displayedCommits.length === 0 ? (
        <div className="vcs-submodules__empty">No commits on this branch yet</div>
      ) : (
        <ol className="vcs-graph">
          {displayedCommits.map((c) => (
            <CommitRow key={c.sha} c={c} isOpen={false} onToggle={() => {}} onOpenDiff={(sha) => onOpenDiff(sha, path)} />
          ))}
        </ol>
      )}
      {hasMore ? (
        <div className="vcs-load-more-row">
          <button
            type="button"
            className="vcs-load-more"
            onClick={() => onLoadMore(path)}
            disabled={state.loading}
          >
            {state.loading ? "Loading…" : "Load 50 more"}
          </button>
          {state.loadMoreError ? (
            <span className="vcs-load-more-error">Failed to load more: {state.loadMoreError}</span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
