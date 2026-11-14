import { ExternalLink, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import { useEffect, useState } from "react";
import type { ApiInstance } from "@/api";
import type { FileScope, PrInfo, PrStatus } from "@/api/types";

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
 * The PR-status row's copy for a worktree with no PR banner.
 *
 * Distinct text per failure kind (Decision 3's states), and a stale marker
 * for a held last-known value: `staleSince` means the poller failed
 * transiently and kept the previous answer rather than blanking it.
 * Colours/buckets never change here — these rows are informational only.
 */
export function prStatusMessage(
  prStatus: PrStatus | null | undefined,
): { text: string; title?: string } | null {
  if (!prStatus) return null;
  if (prStatus.staleSince) {
    return {
      text: "PR status may be stale — the last lookup failed",
      title: `Last checked ${prStatus.checkedAt}`,
    };
  }
  switch (prStatus.errorKind) {
    case "no_credentials":
      return { text: "No GitHub credentials — run gh auth login" };
    case "auth":
      return { text: "GitHub token can't access this repo" };
    case "not_found":
      return { text: "Repo not visible to configured accounts" };
    case "transient":
      return { text: "PR lookup failed, retrying…" };
    case "unsupported":
      return { text: "Unsupported GitHub host — PR status unavailable" };
    default:
      return null;
  }
}


interface VcsPrSlotProps {
  api: ApiInstance;
  worktreeId: string;
  scope: FileScope;
  /** PR status from the session store (branch-guarded); the message row's source when no PR is known. */
  prStatus?: PrStatus | null;
}

/**
 * The ONE-row PR slot above the commit list (board 3): the existing PR banner when the branch has a PR, else the
 * PR-status message row, else nothing. Fetches `GET .../pr` independently of the commit list, never delays it, and
 * never runs for project scope (no PR concept there). Board 7 (PR workflow) is out of scope.
 */
export function VcsPrSlot({ api, worktreeId, scope, prStatus = null }: VcsPrSlotProps) {
  const isProject = scope === "project";
  const [pr, setPr] = useState<PrInfo | null>(null);
  useEffect(() => {
    setPr(null);
    if (isProject) return;
    let live = true;
    // Best-effort: a failed lookup is a missing banner, not an error state for the list.
    api.getPr(worktreeId).catch(() => null).then((p) => {
      if (live) setPr(p);
    });
    return () => {
      live = false;
    };
  }, [api, worktreeId, isProject]);

  if (pr) return <PrBanner pr={pr} />;
  const message = prStatusMessage(prStatus);
  if (!message) return null;
  return (
    <div className="vcs-pr-error error-text" title={message.title}>
      {message.text}
    </div>
  );
}
