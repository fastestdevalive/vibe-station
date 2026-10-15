import { ChevronRight, GitCommit } from "lucide-react";
import type { CommitLogEntry } from "@/api/types";

/** Relative time like "3m ago", "2h ago", "5d ago"; falls back to a date past ~30d. */
export function relativeTime(iso: string): string {
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

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

/**
 * The branch's own commits, split out of a (most-recent-first) page at the
 * first `isOnBranch: false` entry. Everything from there down is base-branch /
 * upstream history. A branch that merged the base back in partway can
 * interleave `isOnBranch: true` commits after that point; those still get
 * bucketed as upstream here, which is an acceptable simplification for this
 * view (they're still visible, just grouped under "from <base>").
 */
export function splitOwnCommits(page: CommitLogEntry[]): CommitLogEntry[] {
  const splitIdx = page.findIndex((c) => !c.isOnBranch);
  return splitIdx === -1 ? page : page.slice(0, splitIdx);
}

/** One row of the commit graph — a single commit's card, with expand/collapse for its body. */
export function CommitRow({
  c,
  isOpen,
  onToggle,
  onOpenDiff,
}: {
  c: CommitLogEntry;
  isOpen: boolean;
  onToggle: () => void;
  /** Opens `VcsCommitView` scoped to this commit. `submodule` names the
   *  submodule whose history the commit belongs to (undefined for the main
   *  repo's own commit list). */
  onOpenDiff: (sha: string, submodule?: string) => void;
}) {
  // Only commits with a body beyond the subject line get the expand
  // affordance — a bare one-line commit has nothing more to reveal, so
  // tapping it would just be a no-op toggle.
  const hasBody = c.body.trim() !== c.subject.trim() && c.body.trim() !== "";
  return (
    <li className="vcs-graph__item">
      <div className="vcs-graph__rail">
        <span
          className="vcs-graph__dot vcs-graph__dot--clickable"
          role="button"
          tabIndex={0}
          aria-label={`View diff for commit ${c.shortSha}`}
          title="View commit diff"
          onClick={(e) => {
            e.stopPropagation();
            onOpenDiff(c.sha);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              onOpenDiff(c.sha);
            }
          }}
        >
          <GitCommit size={11} aria-hidden="true" />
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
