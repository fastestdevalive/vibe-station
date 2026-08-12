import { useEffect, useState } from "react";
import { ChevronRight, ExternalLink, GitCommit, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, RefreshCw } from "lucide-react";
import type { ApiInstance } from "@/api";
import type { CommitLogEntry, PrInfo } from "@/api/types";

interface VcsPanelProps {
  api: ApiInstance;
  worktreeId: string;
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

/**
 * VCS tool — a vertical commit graph for the current worktree's branch, most
 * recent commit on top, plus a PR banner (linking out to GitHub) when the
 * branch has one. Each commit row shows the subject, author, relative time,
 * short SHA, and a +/- diffstat badge. Fetches `GET /worktrees/:id/commits`
 * and `GET /worktrees/:id/pr` once on mount / worktree change and on manual
 * refresh; no live updates yet (commits/PR state changes aren't
 * push-notified to the UI today).
 */
export function VcsPanel({ api, worktreeId }: VcsPanelProps) {
  const [commits, setCommits] = useState<CommitLogEntry[] | null>(null);
  const [pr, setPr] = useState<PrInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Shas whose full message is expanded. A Set rather than a single
  // "expandedSha" so multiple commits can be open at once (mirrors how e.g.
  // GitHub's PR commit list behaves) — tapping a row toggles just that row.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggleExpanded = (sha: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sha)) next.delete(sha);
      else next.add(sha);
      return next;
    });
  };

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    Promise.all([
      api.listCommits(worktreeId),
      // PR lookup is best-effort — a failure here shouldn't blank out the
      // commit list, so it's swallowed to null rather than propagated.
      api.getPr(worktreeId).catch(() => null),
    ])
      .then(([list, prInfo]) => {
        if (controller.signal.aborted) return;
        setCommits(list);
        setPr(prInfo);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, worktreeId]);

  const refresh = () => {
    setLoading(true);
    setError(null);
    Promise.all([api.listCommits(worktreeId), api.getPr(worktreeId).catch(() => null)])
      .then(([list, prInfo]) => {
        setCommits(list);
        setPr(prInfo);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };

  return (
    <div className="vcs-panel">
      <div className="vcs-panel__bar">
        <span className="vcs-panel__title">Commits{commits ? ` (${commits.length})` : ""}</span>
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
      </div>
      {pr ? <PrBanner pr={pr} /> : null}
      <div className="vcs-panel__body">
        {error ? (
          <div className="empty-state">Failed to load commits: {error}</div>
        ) : commits == null ? (
          <div className="empty-state">Loading commits…</div>
        ) : commits.length === 0 ? (
          <div className="empty-state">No commits on this branch yet</div>
        ) : (
          <ol className="vcs-graph">
            {commits.map((c) => {
              // Only commits with a body beyond the subject line get the
              // expand affordance — a bare one-line commit has nothing more
              // to reveal, so tapping it would just be a no-op toggle.
              const hasBody = c.body.trim() !== c.subject.trim() && c.body.trim() !== "";
              const isOpen = expanded.has(c.sha);
              return (
                <li key={c.sha} className="vcs-graph__item">
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
                    onClick={hasBody ? () => toggleExpanded(c.sha) : undefined}
                    onKeyDown={
                      hasBody
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              toggleExpanded(c.sha);
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
                        {c.insertions > 0 ? (
                          <span className="vcs-graph__add">+{c.insertions}</span>
                        ) : null}
                        {c.deletions > 0 ? (
                          <span className="vcs-graph__del">−{c.deletions}</span>
                        ) : null}
                        {c.insertions === 0 && c.deletions === 0 ? (
                          <span className="vcs-graph__nochange">no changes</span>
                        ) : null}
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
