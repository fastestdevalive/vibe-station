import { useEffect, type ReactNode } from "react";
import type { ApiInstance } from "@/api";
import type { BulkItemStatus, BulkJob } from "./bulkRunner";
import { useBulkWorktreeActions } from "./useBulkWorktreeActions";
import { useBulkWorktrees } from "./useBulkWorktrees";

/** All-done, nothing-failed tray clears itself after this long (edge cases). */
const AUTO_DISMISS_MS = 4000;

function countStatus(job: BulkJob, status: BulkItemStatus): number {
  return job.items.filter((item) => item.status === status).length;
}

function progressText(job: BulkJob): ReactNode {
  const processed = job.items.length - countStatus(job, "queued") - countStatus(job, "running");
  const count = ` ${processed} of ${job.items.length}`;
  return job.action === "archive" ? (
    <>Archiving…{count}</>
  ) : (
    <>
      Deleting<span className="bulk-tray__verb-extra"> worktrees</span>…{count}
    </>
  );
}

/** "3 deleted", "2 deleted · 1 failed", "2 archived · 1 cancelled". */
function summaryText(job: BulkJob): string {
  const verb = job.action === "archive" ? "archived" : "deleted";
  const parts = [`${countStatus(job, "done")} ${verb}`];
  const failed = countStatus(job, "failed");
  const cancelled = countStatus(job, "cancelled");
  if (failed > 0) parts.push(`${failed} failed`);
  if (cancelled > 0) parts.push(`${cancelled} cancelled`);
  return parts.join(" · ");
}

/**
 * Non-blocking bulk job tray (design `Progress.dc.html`): an in-progress card
 * with a spinner, "… i of N", Cancel (not-yet-started items only) and a bar,
 * then a finished card with the outcome, Retry (failed/cancelled only) and ×.
 *
 * Always mounted so `useBulkWorktreeActions` keeps the module-scope runner's
 * api/navigate refs current (Decision 2); hidden by CSS on the collapsed rail.
 */
export function BulkProgressTray({ api }: { api: ApiInstance }) {
  const job = useBulkWorktrees((s) => s.job);
  const { cancelRemaining, retry, dismiss } = useBulkWorktreeActions(api);

  // All-done, nothing-failed tray clears itself after a beat (edge cases).
  useEffect(() => {
    if (!job || !job.finished || job.items.some((item) => item.status !== "done")) return undefined;
    const timer = window.setTimeout(() => dismiss(), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [job, dismiss]);

  if (!job) return null;

  if (!job.finished) {
    const processed = job.items.length - countStatus(job, "queued") - countStatus(job, "running");
    const percent = job.items.length === 0 ? 0 : Math.round((processed / job.items.length) * 100);
    const hasQueued = countStatus(job, "queued") > 0;
    return (
      <div className="bulk-tray">
        <div className="bulk-tray__card">
          <div className="bulk-tray__row">
            <span className="bulk-tray__spinner" aria-hidden />
            <span className="bulk-tray__text" role="status" aria-live="polite">
              {progressText(job)}
            </span>
            <button
              type="button"
              className="bulk-tray__link"
              disabled={!hasQueued}
              onClick={() => cancelRemaining()}
            >
              Cancel
            </button>
          </div>
          <div className="bulk-tray__bar">
            <div className="bulk-tray__fill" style={{ width: `${percent}%` }} />
          </div>
        </div>
      </div>
    );
  }

  const failed = countStatus(job, "failed") > 0;
  const retryable = failed || countStatus(job, "cancelled") > 0;
  const firstFailure = job.items.find((item) => item.status === "failed");

  return (
    <div className="bulk-tray">
      <div className={`bulk-tray__card${failed ? " bulk-tray__card--failure" : ""}`}>
        <div className="bulk-tray__row">
          <span
            className="bulk-tray__text"
            role="status"
            aria-live="polite"
            title={summaryText(job)}
            data-failure={failed ? "true" : undefined}
          >
            {summaryText(job)}
          </span>
          {retryable ? (
            <button type="button" className="bulk-tray__link" onClick={() => retry()}>
              Retry
            </button>
          ) : null}
          <button type="button" className="bulk-tray__link" aria-label="Dismiss" onClick={() => dismiss()}>
            ×
          </button>
        </div>
        {firstFailure ? (
          <div className="bulk-tray__detail">
            {firstFailure.label} — {firstFailure.error ?? "failed"}
          </div>
        ) : null}
      </div>
    </div>
  );
}
