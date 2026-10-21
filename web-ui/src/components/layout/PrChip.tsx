import type { KeyboardEvent, MouseEvent } from "react";
import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import type { PrStatus } from "@/api/types";
import { openExternal } from "@/lib/openExternal";
import "./PrChip.css";

const ICON = {
  open: GitPullRequest,
  merged: GitMerge,
  draft: GitPullRequestDraft,
  closed: GitPullRequestClosed,
} as const;

type ChipState = keyof typeof ICON;

/** True when `PrChip` would render something for this PR (single source for the card's band rule). */
export function hasPrChip(pr: PrStatus | null | undefined): pr is PrStatus & { url: string; number: number } {
  return !!pr && !!pr.number && !!pr.url && pr.state in ICON;
}

/**
 * House PR chip for the agent card band: icon + `#142`; the state is the icon, the
 * `--pr-<state>` tint and the aria-label.
 * Purely informational — it never changes a card's dot colour or bucket. It is
 * a `role="link"` span (not an `<a>`) because the card's stretched name link
 * covers it (it sits above via z-index) and a nested anchor is invalid HTML; activating it opens the PR and does not
 * trigger the card.
 */
export function PrChip({ pr }: { pr: PrStatus | null | undefined }) {
  if (!hasPrChip(pr)) return null;
  const state = pr.state as ChipState;
  const Icon = ICON[state];
  const url = pr.url;

  const open = (e: MouseEvent | KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openExternal(url);
  };

  return (
    <span
      role="link"
      tabIndex={0}
      className={`pr-chip pr-chip--${state}`}
      aria-label={`Open pull request #${pr.number} (${state})`}
      title={`Open pull request #${pr.number} (${state})`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") open(e);
      }}
    >
      <Icon size={11} strokeWidth={1.8} aria-hidden="true" />
      <span className="pr-chip__num">#{pr.number}</span>
    </span>
  );
}
