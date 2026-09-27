import type { Channel, PrStatus } from "@/api/types";
import type { WorktreeRolledUpStatus } from "@/lib/worktreeStatus";
import { StatusDot } from "@/components/layout/StatusDot";
import { ModeIcon } from "@/components/agent/ModeIcon";
import { formatTimeAgo } from "@/lib/timeAgo";

/**
 * Plain data in, no hooks/store access inside the component itself —
 * keeps the chip's actual render logic portable to a non-React client later.
 */
export interface SessionChipProps {
  status: WorktreeRolledUpStatus;
  pr: PrStatus | null;
  sessionLabel: string;          // Agent name / session name — row 1
  worktreeLabel?: string | null; // Worktree / branch name — row 2
  projectLabel?: string | null;  // Project name — row 2
  groupLabel?: string;           // Fallback for worktree · project
  isDirect?: boolean;            // Direct agent (no worktree)
  modeIconKey?: string;
  channel?: Channel;
  createdAt?: string | number | Date | null;
  href?: string;
  onClick?: () => void;
}

export function SessionChip({
  status,
  pr,
  sessionLabel,
  worktreeLabel,
  projectLabel,
  groupLabel,
  isDirect,
  modeIconKey,
  channel,
  createdAt,
  href,
  onClick,
}: SessionChipProps) {
  const direct = isDirect ?? (worktreeLabel === "direct");
  const timeAgo = createdAt ? formatTimeAgo(createdAt) : "";
  const createdTitle = createdAt ? new Date(createdAt).toLocaleString() : undefined;

  const subtitle = direct
    ? (projectLabel ? `direct · ${projectLabel}` : "direct")
    : worktreeLabel && projectLabel
      ? `${worktreeLabel} · ${projectLabel}`
      : (worktreeLabel ?? groupLabel ?? projectLabel ?? "");

  const content = (
    <>
      <span className="session-chip__row-1 session-chip__top-row">
        <span className="dashboard-card__dot dashboard-card__dot--status">
          <StatusDot status={status} pr={pr} />
        </span>
        {modeIconKey ? (
          <span className="dashboard-card__icon" aria-hidden="true">
            <ModeIcon iconKey={modeIconKey} channel={channel} size={12} />
          </span>
        ) : null}
        <span className="session-chip__session dashboard-card__primary" title={sessionLabel}>
          {sessionLabel}
        </span>
        {timeAgo ? (
          <span className="session-chip__time" title={createdTitle}>
            {timeAgo}
          </span>
        ) : null}
      </span>

      <span className="session-chip__row-2 session-chip__bottom-row session-chip__group dashboard-card__secondary" title={subtitle}>
        {direct ? (
          <>
            <span className="session-chip__direct-tag">direct</span>
            {projectLabel ? <span className="session-chip__separator"> · </span> : null}
            {projectLabel ? <span className="session-chip__project-name">{projectLabel}</span> : null}
          </>
        ) : worktreeLabel && projectLabel ? (
          <>
            <span className="session-chip__worktree-name">{worktreeLabel}</span>
            <span className="session-chip__separator"> · </span>
            <span className="session-chip__project-name">{projectLabel}</span>
          </>
        ) : (
          <span>{subtitle}</span>
        )}
      </span>
    </>
  );

  const directClass = direct ? " session-chip--direct" : "";
  const className = `dashboard-card dashboard-card--session session-chip${directClass}`;

  if (href) {
    return (
      <a
        href={href}
        className={className}
        onClick={(e) => {
          // Only intercept a plain left-click — ctrl/cmd/shift/middle-click
          // must fall through to the browser's native "open in new
          // tab/window" behavior (matches react-router's <Link>; the old
          // <Link>-based row supported this, found regressed in review).
          if (
            onClick &&
            e.button === 0 &&
            !e.metaKey &&
            !e.ctrlKey &&
            !e.shiftKey &&
            !e.altKey
          ) {
            e.preventDefault();
            onClick();
          }
        }}
      >
        {content}
      </a>
    );
  }

  if (onClick) {
    return (
      <button type="button" className={className} onClick={onClick}>
        {content}
      </button>
    );
  }

  return <div className={className}>{content}</div>;
}
