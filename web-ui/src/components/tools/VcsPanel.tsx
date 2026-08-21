import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, ExternalLink, GitCommit, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, RefreshCw } from "lucide-react";
import type { ApiInstance } from "@/api";
import type { CommitLogEntry, PrInfo, SubmoduleInfo } from "@/api/types";

interface VcsPanelProps {
  api: ApiInstance;
  worktreeId: string;
  /** Worktree's base branch (e.g. "main"), used to label the collapsed upstream-commits group. */
  baseBranch?: string;
}

/** Relative time like "3m ago", "2h ago", "5d ago"; falls back to a date past ~30d. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

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

/**
 * Top-level `.gitmodules` submodules section, shown below the commit list
 * when the worktree has any (Requirement 3f). Renders nothing when empty —
 * the commit list is the primary content and most repos have no submodules.
 */
function SubmodulesSection({ submodules }: { submodules: SubmoduleInfo[] }) {
  if (submodules.length === 0) return null;
  return (
    <div className="vcs-submodules">
      <div className="vcs-submodules__header">Submodules</div>
      <ul className="vcs-submodules__list">
        {submodules.map((s) => {
          const { label, modifier } = submoduleStatus(s.status);
          return (
            <li key={s.path} className="vcs-submodules__row">
              <span className="vcs-submodules__path" title={s.path}>
                {s.path}
              </span>
              {s.shortSha ? <code className="vcs-submodules__sha">{s.shortSha}</code> : null}
              <span className="vcs-submodules__subject" title={s.subject ?? undefined}>
                {s.subject ?? "—"}
              </span>
              <span className={`vcs-submodules__badge vcs-submodules__badge--${modifier}`}>{label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Icon + label + modifier class for a PR's current status. */
function prStatus(pr: PrInfo): { Icon: typeof GitPullRequest; label: string; modifier: string } {
  if (pr.merged) return { Icon: GitMerge, label: "Merged", modifier: "merged" };
  if (pr.state === "closed") return { Icon: GitPullRequestClosed, label: "Closed", modifier: "closed" };
  if (pr.draft) return { Icon: GitPullRequestDraft, label: "Draft", modifier: "draft" };
  return { Icon: GitPullRequest, label: "Open", modifier: "open" };
}

/**
 * PR banner shown above the commit list when the worktree's branch has a
 * GitHub pull request (any state — open/draft/merged/closed). Renders
 * nothing while loading or when there's no PR/no GitHub remote, so it never
 * shows a "no PR" placeholder — the commit list is the primary content.
 */
function PrBanner({ pr }: { pr: PrInfo }) {
  const { Icon, label, modifier } = prStatus(pr);
  return (
    <a
      className={`vcs-pr vcs-pr--${modifier}`}
      href={pr.url}
      target="_blank"
      rel="noreferrer noopener"
      title={`Open PR #${pr.number} on GitHub`}
    >
      <Icon size={14} aria-hidden className="vcs-pr__icon" />
      <span className="vcs-pr__title" title={pr.title}>
        {pr.title}
      </span>
      <span className="vcs-pr__number">#{pr.number}</span>
      <span className={`vcs-pr__badge vcs-pr__badge--${modifier}`}>{label}</span>
      {pr.author ? <span className="vcs-pr__author">by {pr.author}</span> : null}
      <ExternalLink size={12} aria-hidden className="vcs-pr__external" />
    </a>
  );
}

/** One row of the commit graph — a single commit's card, with expand/collapse for its body. */
function CommitRow({
  c,
  isOpen,
  onToggle,
}: {
  c: CommitLogEntry;
  isOpen: boolean;
  onToggle: () => void;
}) {
  // Only commits with a body beyond the subject line get the expand
  // affordance — a bare one-line commit has nothing more to reveal, so
  // tapping it would just be a no-op toggle.
  const hasBody = c.body.trim() !== c.subject.trim() && c.body.trim() !== "";
  return (
    <li className="vcs-graph__item">
      <div className="vcs-graph__rail">
        <span className="vcs-graph__dot">
          <GitCommit size={11} aria-hidden />
        </span>
        <span className="vcs-graph__line" aria-hidden />
      </div>
      <div
        className={`vcs-graph__card${hasBody ? " vcs-graph__card--expandable" : ""}`}
        role={hasBody ? "button" : undefined}
        tabIndex={hasBody ? 0 : undefined}
        aria-expanded={hasBody ? isOpen : undefined}
        onClick={hasBody ? onToggle : undefined}
        onKeyDown={
          hasBody
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onToggle();
                }
              }
            : undefined
        }
      >
        <div className="vcs-graph__subject-row">
          <span className="vcs-graph__subject" title={hasBody ? undefined : c.subject}>
            {c.subject || "(no message)"}
          </span>
        </div>
        {hasBody && isOpen ? <pre className="vcs-graph__body">{c.body}</pre> : null}
        <div className="vcs-graph__meta">
          {hasBody ? (
            <ChevronRight
              size={12}
              aria-hidden
              className={`vcs-graph__chevron${isOpen ? " vcs-graph__chevron--open" : ""}`}
            />
          ) : null}
          <span className="vcs-graph__avatar" title={c.authorName}>
            {initials(c.authorName)}
          </span>
          <span className="vcs-graph__author">{c.authorName}</span>
          <span className="vcs-graph__dot-sep" aria-hidden>
            ·
          </span>
          <span className="vcs-graph__time" title={c.date}>
            {relativeTime(c.date)}
          </span>
          <span className="vcs-graph__dot-sep" aria-hidden>
            ·
          </span>
          <code className="vcs-graph__sha">{c.shortSha}</code>
          <span className="vcs-graph__stats">
            {c.insertions > 0 ? <span className="vcs-graph__add">+{c.insertions}</span> : null}
            {c.deletions > 0 ? <span className="vcs-graph__del">−{c.deletions}</span> : null}
            {c.insertions === 0 && c.deletions === 0 ? (
              <span className="vcs-graph__nochange">no changes</span>
            ) : null}
          </span>
        </div>
      </div>
    </li>
  );
}

/** Commits fetched and shown per page — an initial load, and each "Load more" click. */
const PAGE_SIZE = 50;

/** Mirrors the `limit` clamp `GET /worktrees/:id/commits` applies server-side (`daemon/src/routes/worktrees.ts`). */
const SERVER_MAX_LIMIT = 1000;

/**
 * VCS tool — a vertical commit graph for the current worktree's branch, most
 * recent commit on top, plus a PR banner (linking out to GitHub) when the
 * branch has one. Each commit row shows the subject, author, relative time,
 * short SHA, and a +/- diffstat badge. Fetches `GET /worktrees/:id/commits`
 * and `GET /worktrees/:id/pr` on mount / worktree change and on manual
 * refresh (both reset back to one page of `PAGE_SIZE` commits), plus again
 * for each additional page on "Load more"; no live updates yet (commits/PR
 * state changes aren't push-notified to the UI today).
 */
export function VcsPanel({ api, worktreeId, baseBranch }: VcsPanelProps) {
  // `commits` holds at most `pageLimit + 1` entries — the lookahead extra
  // entry (never rendered) is how `hasMore` is known for certain instead of
  // guessed from `commits.length === pageLimit`, which can't tell "exactly
  // that many commits total" apart from "more are available".
  const [commits, setCommits] = useState<CommitLogEntry[] | null>(null);
  const [pr, setPr] = useState<PrInfo | null>(null);
  const [submodules, setSubmodules] = useState<SubmoduleInfo[]>([]);
  // Initial-load/refresh failure — blocks the whole panel, since there's
  // nothing else to show yet (or the refresh is presumed stale/distrusted).
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // "Load more" failure — shown inline near the button instead, so a blip
  // fetching page 2 doesn't blank out the page of commits already on screen.
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  // How many commits the user has asked to see (starts at one page, grows by
  // PAGE_SIZE per "Load more" click). Resets to PAGE_SIZE on worktree change
  // and on manual refresh — a stale "load more" position from a previous
  // worktree/session would be confusing carried over.
  const [pageLimit, setPageLimit] = useState(PAGE_SIZE);
  // Shas whose full message is expanded. A Set rather than a single
  // "expandedSha" so multiple commits can be open at once (mirrors how e.g.
  // GitHub's PR commit list behaves) — tapping a row toggles just that row.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // ON by default — the branch's own commits are the point of this view;
  // flipping it OFF reveals the full unfiltered log inline (Requirement 1a-1c).
  const [diffFromMain, setDiffFromMain] = useState(true);

  const toggleExpanded = (sha: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sha)) next.delete(sha);
      else next.add(sha);
      return next;
    });
  };

  const hasMore = commits != null && commits.length > pageLimit && pageLimit < SERVER_MAX_LIMIT;
  // The daemon's `GET /worktrees/:id/commits` clamps `limit` to 1000 (see
  // `daemon/src/routes/worktrees.ts`) — once a page hits that ceiling with a
  // full page of commits, "no more available" and "1000+ commits, server
  // won't return past its clamp" are indistinguishable from the response
  // alone. Rather than silently hiding "Load more" either way (which reads
  // as "that's the whole history" even when it isn't), this is surfaced
  // explicitly below instead.
  const reachedServerCap = pageLimit >= SERVER_MAX_LIMIT && commits != null && commits.length >= SERVER_MAX_LIMIT;
  // The page currently on screen — trims off the lookahead entry `hasMore`
  // uses, so it never gets to leak into the split below or the rendered list.
  const pageCommits = useMemo(
    () => (commits == null ? null : commits.slice(0, pageLimit)),
    [commits, pageLimit],
  );

  // Commits come back most-recent-first with `isOnBranch` already computed
  // server-side against the worktree's `baseSha`. In the common case (no
  // merges back from the base branch mid-history) the branch's own commits
  // form a contiguous prefix, so splitting at the first `isOnBranch: false`
  // is enough — everything from there down is base-branch/upstream history
  // and gets grouped under the collapsed section below. A branch that merged
  // main back into itself partway through can interleave `isOnBranch: true`
  // commits after that point; those still get bucketed as upstream here,
  // which is an acceptable simplification for this view (they're still
  // visible, just under "from <base>" instead of inline).
  const ownCommits = useMemo(() => {
    if (!pageCommits) return [];
    const splitIdx = pageCommits.findIndex((c) => !c.isOnBranch);
    return splitIdx === -1 ? pageCommits : pageCommits.slice(0, splitIdx);
  }, [pageCommits]);

  // Commits actually rendered: `ownCommits` when the toggle is ON, the full
  // unfiltered page when OFF (Requirements 1b/1c).
  const displayedCommits = diffFromMain ? ownCommits : (pageCommits ?? []);

  // The controller for whichever fetch is currently in flight. Centralizing
  // cancellation here (rather than only aborting on effect cleanup) is what
  // makes it safe to fire a "Load more" or "Refresh" from an event handler,
  // not just from the effect: every `load()` call aborts whatever it's
  // superseding before starting, so a `loadMore` for the *old* worktree that
  // was still in flight when the user switched worktrees can never resolve
  // into the new worktree's state — the worktree-change effect's own `load()`
  // call aborts it as its very first step.
  const activeLoad = useRef<AbortController | null>(null);

  // Shared loader for the initial fetch, "Load more", and manual refresh —
  // `limit` is how many commits the caller wants to end up displaying;
  // `limit + 1` is what's actually requested from the API so `hasMore` above
  // has a definite answer rather than a guess. `loadMoreCheck`, when
  // supplied for a `mode === "more"` call, carries the own-commit count from
  // just before this specific "Load more" click — Requirement 1f's
  // auto-toggle-off check is done synchronously right here in the success
  // path (not via a ref/effect keyed on `ownCommits`), so a failed or
  // aborted "Load more" never leaves any stale armed state to misfire on a
  // later, unrelated commits update.
  const load = (
    limit: number,
    mode: "initial" | "more" = "initial",
    loadMoreCheck?: { prevOwnCount: number },
  ) => {
    activeLoad.current?.abort();
    const controller = new AbortController();
    activeLoad.current = controller;
    const { signal } = controller;

    if (mode === "initial") {
      setLoading(true);
      setError(null);
      setSubmodules([]);
      // A prior page's "Load more" failure is no longer relevant once we're
      // re-fetching from scratch (refresh, or a worktree switch) — leaving
      // it set would show a stale failure next to a button that hasn't
      // actually failed since this fetch started.
      setLoadMoreError(null);
    } else {
      setLoadingMore(true);
      setLoadMoreError(null);
    }
    return Promise.all([
      api.listCommits(worktreeId, limit + 1),
      // PR lookup is best-effort — a failure here shouldn't blank out the
      // commit list, so it's swallowed to null rather than propagated. Only
      // refetched on "initial" (mount/worktree-change/refresh) — a "Load
      // more" page is more commits of the same worktree, so the PR banner
      // can't have changed as a side effect of it.
      mode === "initial" ? api.getPr(worktreeId).catch(() => null) : Promise.resolve(undefined),
      // Submodules are also best-effort and initial-only, same reasoning as
      // the PR lookup above — a "Load more" page can't change the worktree's
      // submodule set.
      mode === "initial" ? api.listSubmodules(worktreeId).catch(() => []) : Promise.resolve(undefined),
    ])
      .then(([list, prInfo, submoduleList]) => {
        if (signal.aborted) return;
        setCommits(list);
        if (prInfo !== undefined) setPr(prInfo);
        if (submoduleList !== undefined) setSubmodules(submoduleList);
        setPageLimit(limit);
        if (mode === "more" && loadMoreCheck) {
          // Recompute the own-commit prefix for the newly loaded page the
          // same way `ownCommits` does, and compare against the count from
          // just before this click — if "Load more" added zero additional
          // own-branch commits, the click was a no-visible-op with the
          // toggle ON, so turn it OFF to reveal the new page.
          const newPageCommits = list.slice(0, limit);
          const splitIdx = newPageCommits.findIndex((c) => !c.isOnBranch);
          const newOwnCount = splitIdx === -1 ? newPageCommits.length : splitIdx;
          if (newOwnCount === loadMoreCheck.prevOwnCount) {
            setDiffFromMain(false);
          }
        }
      })
      .catch((err: unknown) => {
        if (signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        // Route the error so a failed "load more" only annotates the button
        // rather than replacing the page of commits already on screen (see
        // the `error` vs `loadMoreError` state comments above).
        if (mode === "initial") setError(message);
        else setLoadMoreError(message);
      })
      .finally(() => {
        if (signal.aborted) return;
        if (mode === "initial") setLoading(false);
        else setLoadingMore(false);
      });
  };

  useEffect(() => {
    // Requirement 1a: the toggle is checked by default for every worktree —
    // reset it here so an auto-toggle-off (Requirement 1f) or a manual flip
    // on a previous worktree doesn't carry over to this one.
    setDiffFromMain(true);
    // Requirement 3: a worktree switch must fall back to the "Loading
    // commits…" empty state, not briefly show the PREVIOUS worktree's stale
    // commits under a "Syncing…" label (which reads as "these are your
    // commits, just refreshing" instead of "wrong worktree, please wait").
    // Deliberately scoped to this effect only — manual `refresh()` of the
    // SAME worktree should keep showing old data while it reloads.
    setCommits(null);
    void load(PAGE_SIZE, "initial");
    return () => activeLoad.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `load` is redefined every render (reads current api/worktreeId via closure); depending on worktreeId/api alone matches the pre-existing effect's deps.
  }, [api, worktreeId]);

  const refresh = () => {
    void load(PAGE_SIZE, "initial");
  };

  const loadMore = () => {
    // For a typical worktree, page 1 already contains the whole own-commit
    // prefix — every subsequent page is entirely upstream history. Without
    // Requirement 1f's auto-toggle-off, clicking "Load more" while the
    // toggle is ON would be a no-visible-op in that case (the new page loads
    // but nothing new renders). Only arm the check when the toggle is
    // actually ON — if it's already OFF, the newly loaded page renders
    // regardless, so there's nothing to detect.
    const loadMoreCheck = diffFromMain ? { prevOwnCount: ownCommits.length } : undefined;
    void load(Math.min(pageLimit + PAGE_SIZE, SERVER_MAX_LIMIT), "more", loadMoreCheck);
  };

  return (
    <div className="vcs-panel">
      <div className="vcs-panel__bar">
        <span className="vcs-panel__title">
          Commits{pageCommits ? ` (${diffFromMain ? ownCommits.length : pageCommits.length})` : ""}
        </span>
        <div className="vcs-panel__bar-actions">
          <label className="vcs-panel__diff-toggle">
            <input
              type="checkbox"
              checked={diffFromMain}
              onChange={(e) => setDiffFromMain(e.target.checked)}
            />
            Diff from {baseBranch || "main"}
          </label>
          <button
            type="button"
            className="tab tab--icon tool-bar-btn"
            aria-label="Refresh commits"
            title="Refresh commits"
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCw size={13} className={loading ? "vcs-panel__spin" : undefined} />
          </button>
          {/* Requirement 2b: a visible "syncing" indicator distinct from the
              refresh button's spin animation, shown only while a refresh is
              in flight over a commit list already on screen (never during
              the true first load — Requirement 2c's "Loading commits…"
              empty state covers that case instead).
              Rendered UNCONDITIONALLY (only its text/icon content toggles) —
              a `role="status"` live region needs to already exist in the DOM
              before its content changes, or some screen readers won't
              announce it. Paired with `aria-live="polite"` per the existing
              convention in `TerminalPane.tsx`/`ConnectionStatus.tsx`. Sits
              AFTER the refresh button (not before) and reserves its own
              width via CSS (`visibility: hidden` when idle, not
              `display: none`) so its appearance/disappearance never shifts
              the button's position. */}
          <span
            className={`vcs-panel__syncing${loading && commits != null ? "" : " vcs-panel__syncing--idle"}`}
            role="status"
            aria-live="polite"
          >
            {loading && commits != null ? (
              <>
                <RefreshCw size={11} className="vcs-panel__spin" aria-hidden />
                Syncing…
              </>
            ) : (
              ""
            )}
          </span>
        </div>
      </div>
      {pr ? <PrBanner pr={pr} /> : null}
      <div className="vcs-panel__body">
        {error ? (
          <div className="empty-state">Failed to load commits: {error}</div>
        ) : pageCommits == null ? (
          <div className="empty-state">Loading commits…</div>
        ) : (
          <>
            {displayedCommits.length === 0 ? (
              <div className="empty-state">No commits on this branch yet</div>
            ) : (
              <ol className="vcs-graph">
                {displayedCommits.map((c) => (
                  <CommitRow key={c.sha} c={c} isOpen={expanded.has(c.sha)} onToggle={() => toggleExpanded(c.sha)} />
                ))}
              </ol>
            )}
            {/* Keyed on `pageCommits` (the underlying, unfiltered page), not on
                `displayedCommits` — a worktree with 0 own commits but plenty of
                upstream history (toggle ON, fresh branch) still needs the pager
                so there's a way to reach more history or discover the toggle. */}
            {hasMore ? (
              <div className="vcs-load-more-row">
                <button type="button" className="vcs-load-more" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? "Loading…" : `Load ${PAGE_SIZE} more`}
                </button>
                {loadMoreError ? (
                  <span className="vcs-load-more-error">Failed to load more: {loadMoreError}</span>
                ) : null}
              </div>
            ) : reachedServerCap ? (
              <div className="vcs-load-more-row">
                <span className="vcs-load-more-cap">
                  Showing the most recent {SERVER_MAX_LIMIT} commits — older history isn't loaded here.
                </span>
              </div>
            ) : null}
          </>
        )}
        {!error && pageCommits != null ? <SubmodulesSection submodules={submodules} /> : null}
      </div>
    </div>
  );
}
