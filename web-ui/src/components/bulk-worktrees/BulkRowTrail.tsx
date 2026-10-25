import type { ReactNode } from "react";
import { Check } from "lucide-react";
import type { BulkAction, BulkItemStatus } from "./bulkRunner";

export interface BulkRowTrailProps {
  /** Row label — becomes the checkbox's accessible name. */
  label: string;
  /**
   * `true`/`false` while selecting; `null` outside select mode, when the trail
   * instead shows this row's job status (if any).
   */
  checked: boolean | null;
  /** `worktreeRolledUpStatus(...) === "working"` (Decision 7) — chip only. */
  running: boolean;
  /** The `+N −N` badge. Rendered by the sidebar so there is one implementation. */
  diffStat: ReactNode;
  /** Item status while a bulk job targets this worktree (design `Progress.dc.html`). */
  jobStatus?: BulkItemStatus;
  /** The job's action — decides "deleting…" vs "archiving…". */
  jobAction?: BulkAction;
  onToggle: () => void;
}

function statusLabel(status: BulkItemStatus, action: BulkAction | undefined): string {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return action === "archive" ? "archiving…" : "deleting…";
    case "done":
      return action === "archive" ? "archived" : "deleted";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}

/**
 * Worktree row trail while selecting (checkbox) or while a bulk job targets
 * this row (status label) — replaces the relative-time slot + `⋯` button in
 * both cases. Order matches the mockups: chip, diffstat, control.
 */
export function BulkRowTrail({
  label,
  checked,
  running,
  diffStat,
  jobStatus,
  jobAction,
  onToggle,
}: BulkRowTrailProps) {
  const chip = running ? <span className="bulk-row__chip">agent running</span> : null;

  if (checked === null) {
    if (!jobStatus) return null;
    return (
      <div className="wt-row__trail bulk-row__trail" style={{ position: "relative", zIndex: 2 }}>
        {chip}
        {diffStat}
        <span className="bulk-row__status">{statusLabel(jobStatus, jobAction)}</span>
      </div>
    );
  }

  return (
    <div className="wt-row__trail bulk-row__trail" style={{ position: "relative", zIndex: 2 }}>
      {chip}
      {diffStat}
      <span
        role="checkbox"
        aria-checked={checked}
        aria-label={`Select ${label}`}
        tabIndex={0}
        className="bulk-row__checkbox"
        data-checked={checked ? "true" : undefined}
        onKeyDown={(e) => {
          // Stop the row's own Enter/Space handler from toggling a second time.
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            onToggle();
          }
        }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggle();
        }}
      >
        {checked ? <Check size={11} strokeWidth={3.5} aria-hidden /> : null}
      </span>
    </div>
  );
}
