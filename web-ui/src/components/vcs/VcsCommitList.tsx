import { RefreshCw } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ApiInstance } from "@/api";
import type { CommitLogEntry, FileScope, PrStatus } from "@/api/types";
import { RailHeader } from "@/components/layout/RailHeader";
import { RailMenu, ViewOptionsMenu } from "@/components/layout/ViewOptionsMenu";
import { relativeTime, splitOwnCommits } from "@/components/tools/VcsCommitRow";
import { VCS_PAGE_SIZE, VCS_SERVER_MAX_LIMIT, useVcsCommits } from "./useVcsCommits";
import { VcsPrSlot } from "./VcsPrSlot";

/** How long a newly seen commit keeps its tint (CSS fades it; `prefers-reduced-motion` drops the fade). */
const NEW_ROW_MS = 1200;
const SKELETON_WIDTHS = [78, 64, 88, 70, 82, 60];

/** "2h" from "2h ago" (the row shows the short age; "just now" and older dates pass through). */
export function shortAge(iso: string): string {
  return relativeTime(iso).replace(/ ago$/, "");
}

/** Age text for the refresh-failed bar: "4 min", or "a moment". */
export function ageText(ms: number | null): string {
  if (ms == null || ms < 60_000) return ms == null ? "earlier" : "a moment";
  return `${Math.floor(ms / 60_000)} min`;
}

/**
 * One commit as a whole-row button (board 3): subject, then `Author · 2h · b1d0e22`, then `+n −n` on the right.
 * `compact` drops the author (sidebar level "list"); `active` marks the commit whose details are open.
 */
export function VcsCommitRow({
  c,
  onOpen,
  compact = false,
  active = false,
  isNew = false,
}: {
  c: CommitLogEntry;
  onOpen: (sha: string) => void;
  compact?: boolean;
  active?: boolean;
  isNew?: boolean;
}) {
  return (
    <li className={`vcs-row${active ? " vcs-row--active" : ""}${isNew ? " vcs-row--new" : ""}`}>
      <button
        type="button"
        className="vcs-row__btn"
        aria-current={active ? "true" : undefined}
        title={c.subject}
        onClick={() => onOpen(c.sha)}
      >
        <span className="vcs-row__subject">{c.subject || "(no message)"}</span>
        <span className="vcs-row__meta">
          {compact ? null : (
            <>
              <span className="vcs-row__author">{c.authorName}</span>
              <span className="vcs-row__sep" aria-hidden>
                ·
              </span>
            </>
          )}
          <span className="vcs-row__time" title={c.date}>
            {shortAge(c.date)}
          </span>
          <span className="vcs-row__sep" aria-hidden>
            ·
          </span>
          <code className="vcs-row__sha">{c.shortSha}</code>
        </span>
        {c.insertions > 0 || c.deletions > 0 ? (
          <span className="vcs-row__stats">
            {c.insertions > 0 ? <span className="vcs-row__add">+{c.insertions}</span> : null}
            {c.deletions > 0 ? <span className="vcs-row__del">−{c.deletions}</span> : null}
          </span>
        ) : null}
      </button>
    </li>
  );
}

export interface VcsCommitListProps {
  api: ApiInstance;
  /** Worktree id (or project id under project scope). */
  id: string;
  scope: FileScope;
  baseBranch?: string;
  prStatus?: PrStatus | null;
  /** Opens a commit (docks the sidebar). */
  onOpen: (sha: string) => void;
  /** `since <base>` (true) or `all history` (false); project scope never filters. Owned by VcsPanel. */
  sinceMain: boolean;
  onSinceMainChange: (next: boolean) => void;
  activeSha?: string | null;
  /** Sidebar level "list": no author, active row marked. */
  compact?: boolean;
  /** The list fills the pane (no commit open): its header hosts the tool actions, not the mode actions. */
  fullPane?: boolean;
}

/**
 * The branch's commit list (board 3, states 1-4). Paints the cached rows at once and revalidates underneath
 * (`useVcsCommits`). Header: `Commits N` left; `since main ▾` and the View options menu right. Above the rows, the
 * one-row PR slot. Cold = skeleton rows in the row shape; a failed refresh keeps the rows behind a bar with Retry.
 */
export function VcsCommitList({
  api,
  id,
  scope,
  baseBranch,
  prStatus = null,
  onOpen,
  sinceMain,
  onSinceMainChange,
  activeSha = null,
  compact = false,
  fullPane = false,
}: VcsCommitListProps) {
  const isProject = scope === "project";
  const base = baseBranch || "main";
  const { commits, hasMore, status, refreshing, error, staleAgeMs, refresh, loadMore } = useVcsCommits({
    api,
    id,
    scope,
  });
  const diffFromMainEff = !isProject && sinceMain;
  const own = useMemo(() => splitOwnCommits(commits), [commits]);
  const shown = diffFromMainEff ? own : commits;
  // The first upstream row (`from <base>`) divides the list when the whole history is shown.
  const dividerAt = !diffFromMainEff && own.length < commits.length ? own.length : -1;
  const reachedServerCap = !hasMore && commits.length >= VCS_SERVER_MAX_LIMIT;

  // Requirement 1f: "Show more" that adds no branch commits turns "since <base>" off, so the click is never a no-op.
  // The check is armed per click and read once the new page lands; a failed load disarms it.
  const armedOwnCount = useRef<number | null>(null);
  useEffect(() => {
    if (armedOwnCount.current === null) return;
    const prev = armedOwnCount.current;
    armedOwnCount.current = null;
    if (splitOwnCommits(commits).length === prev) onSinceMainChange(false);
  }, [commits]);
  useEffect(() => {
    if (error) armedOwnCount.current = null;
  }, [error]);
  const onLoadMore = () => {
    if (diffFromMainEff) armedOwnCount.current = own.length;
    loadMore();
  };

  // Tint commits that appear after the first load (a new commit from an agent slides in with a brief tint).
  const [newShas, setNewShas] = useState<ReadonlySet<string>>(() => new Set());
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (status !== "ready") return;
    const shas = commits.map((c) => c.sha);
    const prev = seen.current;
    seen.current = new Set(shas);
    if (!prev) return;
    const added = shas.filter((s) => !prev.has(s));
    if (added.length === 0) return;
    setNewShas(new Set(added));
    const t = setTimeout(() => setNewShas(new Set()), NEW_ROW_MS);
    return () => clearTimeout(t);
  }, [commits, status]);

  const countLabel = shown.length;
  const header = (
    <RailHeader
      mode="commit"
      host={fullPane ? "tool" : "mode"}
      className="vcs-list__head"
      left={
        <>
          <span className="rail-header__title">Commits</span>
          {status === "ready" ? <span className="rail-header__count">{countLabel}</span> : null}
          {refreshing ? <RefreshCw size={11} aria-hidden="true" className="vcs-panel__spin" /> : null}
        </>
      }
      right={
        <>
          {isProject ? null : (
            <RailMenu
              label="Commit range"
              variant="text"
              text={diffFromMainEff ? `since ${base}` : "all history"}
              itemCount={2}
            >
              {(close) => (
                <>
                  {(
                    [
                      [true, `since ${base}`],
                      [false, "all history"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={String(value)}
                      type="button"
                      role="menuitemradio"
                      aria-checked={diffFromMainEff === value}
                      className="rail-menu__item"
                      onClick={() => {
                        onSinceMainChange(value);
                        close(true);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </>
              )}
            </RailMenu>
          )}
          <ViewOptionsMenu itemCount={hasMore ? 2 : 1}>
            {(close) => (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="rail-menu__item"
                  onClick={() => {
                    refresh();
                    close(true);
                  }}
                >
                  Refresh now
                </button>
                {hasMore ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="rail-menu__item"
                    onClick={() => {
                      onLoadMore();
                      close(true);
                    }}
                  >
                    Show {VCS_PAGE_SIZE} more
                  </button>
                ) : null}
              </>
            )}
          </ViewOptionsMenu>
        </>
      }
    />
  );

  let body;
  if (status === "error") {
    body = <div className="empty-state">Failed to load commits: {error}</div>;
  } else if (status !== "ready") {
    // Cold: skeleton rows in the real row shape, no count.
    body = (
      <ul className="vcs-list vcs-list--skeleton" aria-label="Loading commits" aria-busy="true">
        {SKELETON_WIDTHS.map((w, i) => (
          <li key={i} className="vcs-row vcs-row--skeleton">
            <span className="vcs-skeleton__bar" style={{ width: `${w}%` }} />
            <span className="vcs-skeleton__bar vcs-skeleton__bar--meta" />
          </li>
        ))}
      </ul>
    );
  } else if (shown.length === 0) {
    body = <div className="empty-state">No commits on this branch yet</div>;
  } else {
    body = (
      <ul className="vcs-list">
        {shown.map((c, i) => (
          <Fragment key={c.sha}>
            {i === dividerAt ? (
              <li className="vcs-list__divider" role="presentation">
                from {base}
              </li>
            ) : null}
            <VcsCommitRow
              c={c}
              onOpen={onOpen}
              compact={compact}
              active={activeSha === c.sha}
              isNew={newShas.has(c.sha)}
            />
          </Fragment>
        ))}
      </ul>
    );
  }

  return (
    <div className="vcs-list-pane">
      {header}
      <VcsPrSlot api={api} worktreeId={id} scope={scope} prStatus={prStatus} />
      {status === "ready" && error ? (
        <div className="vcs-refresh-bar" role="status">
          <span>Couldn’t refresh. Showing the list from {ageText(staleAgeMs)} ago.</span>
          <button type="button" className="vcs-refresh-bar__retry" onClick={refresh}>
            Retry
          </button>
        </div>
      ) : null}
      <div className="vcs-list-pane__body">
        {body}
        {status === "ready" && hasMore ? (
          <div className="vcs-load-more-row">
            <button type="button" className="vcs-load-more" onClick={onLoadMore}>
              Load {VCS_PAGE_SIZE} more
            </button>
          </div>
        ) : null}
        {status === "ready" && reachedServerCap ? (
          <div className="vcs-load-more-row">
            <span className="vcs-load-more-cap">
              Showing the most recent {VCS_SERVER_MAX_LIMIT} commits — older history isn’t loaded here.
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
