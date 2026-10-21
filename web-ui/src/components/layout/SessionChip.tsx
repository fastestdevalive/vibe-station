import type { Channel, PrStatus, ToolActivity } from "@/api/types";
import type { WorktreeRolledUpStatus } from "@/lib/worktreeStatus";
import { resolveStatusClass } from "@/lib/statusColor";
import { toolActivityLabel, type ToolActivityKind } from "@/lib/toolActivityLabel";
import { formatFullTimestamp } from "@/lib/timeAgo";
import { ModeIcon } from "@/components/agent/ModeIcon";
import { RelativeTime } from "@/components/layout/RelativeTime";
import { PrChip, hasPrChip } from "@/components/layout/PrChip";
import { WorktreeGlyph } from "@/components/layout/WorktreeGlyph";
import "./AgentCard.css";
import {
  Bot,
  Globe,
  ListChecks,
  Pencil,
  Plug,
  Search,
  SquareTerminal,
  Eye,
  Wrench,
} from "lucide-react";
import type { ComponentType } from "react";

const ACTIVITY_GLYPH: Record<ToolActivityKind, ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean | "true" }>> = {
  edit: Pencil,
  read: Eye,
  run: SquareTerminal,
  search: Search,
  web: Globe,
  agent: Bot,
  plan: ListChecks,
  mcp: Plug,
  other: Wrench,
};

/**
 * Dashboard / project-home agent card (design option E, "path and status
 * band"). One component renders list, kanban and project-home cards so the
 * markup can be swapped wholesale.
 *
 * Plain data in, no hooks/store access inside — keeps the render logic portable.
 * The column / section already names the status, so the card shows the AGENT
 * icon (no status dot); status is the icon's accessible name / tooltip.
 * The card is an `<article>`, not an `<a>`: the name is a stretched link
 * (`.acard__name::after`) and the PR chip sits above it, so there is no nested
 * interactive-in-anchor markup.
 */
export interface SessionChipProps {
  status: WorktreeRolledUpStatus;
  pr: PrStatus | null;
  sessionLabel: string;          // Agent name / session name
  worktreeLabel?: string | null; // Worktree / branch name
  projectLabel?: string | null;  // Project name
  groupLabel?: string;           // Fallback when no worktree/project pair
  isDirect?: boolean;            // Direct agent (no worktree)
  modeIconKey?: string;
  channel?: Channel;
  /** ISO time of the session's last activity (`sessionActivityAt`). */
  activityAt?: string | null;
  /** Last tool call of a Rich Chat agent -> band activity label. Omit for
   *  terminal agents (no structured tool events). */
  lastTool?: ToolActivity | null;
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
  activityAt,
  lastTool,
  href,
  onClick,
}: SessionChipProps) {
  const direct = isDirect ?? (worktreeLabel === "direct");
  const statusText = (resolveStatusClass(status, pr) ?? status).replace(/_/g, " ");
  const activity = toolActivityLabel(lastTool);
  const ActivityGlyph = activity ? ACTIVITY_GLYPH[activity.kind] : null;
  const terminal = channel !== "json";
  // Band only when it has content: tool activity, or a PR chip (never on a direct agent).
  const showPrChip = !direct && hasPrChip(pr);
  const showBand = activity != null || showPrChip;

  const pathTitle = direct
    ? (projectLabel ? `${projectLabel} · direct` : "direct")
    : worktreeLabel && projectLabel
      ? `${projectLabel} / ${worktreeLabel}`
      : (worktreeLabel ?? groupLabel ?? projectLabel ?? "");

  const path = direct ? (
    <div className="acard__path acard__path--direct" title={pathTitle}>
      {projectLabel ? <span className="acard__project">{projectLabel}</span> : null}
      <span className="dtag" title="Direct agent: runs in the project's own checkout, no worktree">
        direct
      </span>
    </div>
  ) : worktreeLabel && projectLabel ? (
    <div className="acard__path" title={pathTitle}>
      <span className="acard__project">{projectLabel}</span>
      <span className="acard__sep">/</span>
      <span className="acard__wt">
        <WorktreeGlyph />
        <span className="acard__branch">{worktreeLabel}</span>
      </span>
    </div>
  ) : (
    <div className="acard__path acard__path--plain" title={pathTitle}>
      <span className="acard__project">{pathTitle}</span>
    </div>
  );

  // Plain left-click only is intercepted; ctrl/cmd/shift/middle-click fall
  // through to the browser's native open-in-new-tab behaviour.
  // The stretched ::after covers the card, so the tooltips of the icon, path,
  // activity and time never receive hover; fold them into the name link's title.
  const fullTime = activityAt ? formatFullTimestamp(activityAt) : "";
  const nameTitle =
    `${sessionLabel} · ${statusText}` +
    (pathTitle ? ` — ${pathTitle}` : "") +
    (activity ? ` — ${activity.text}` : "") +
    (fullTime ? ` · Last activity ${fullTime}` : "");
  const nameProps = { className: "acard__name", title: nameTitle };
  const name = href ? (
    <a
      {...nameProps}
      href={href}
      onClick={(e) => {
        if (onClick && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {sessionLabel}
    </a>
  ) : onClick ? (
    <button type="button" {...nameProps} onClick={onClick}>
      {sessionLabel}
    </button>
  ) : (
    <span {...nameProps}>{sessionLabel}</span>
  );

  return (
    <article className={`acard${direct ? " acard--direct" : ""}`}>
      <div className="acard__head">
        <span
          className={`acard__agent${terminal ? " acard__agent--tty" : ""}`}
          role="img"
          aria-label={`status: ${statusText}`}
          title={`${sessionLabel} · ${statusText}`}
          data-status={statusText}
        >
          <ModeIcon iconKey={modeIconKey} channel={channel} size={14} />
        </span>
        {name}
        <RelativeTime at={activityAt} className="acard__time" />
      </div>
      {path}
      {showBand ? (
        <div className="acard__band">
          <span className="acard__act" title={activity?.text}>
            {activity && ActivityGlyph ? (
              <>
                <ActivityGlyph size={13} className="acard__act-ico" aria-hidden="true" />
                <span className="acard__act-t">
                  {activity.verb}
                  {activity.target ? (
                    <>
                      {" "}
                      <code>{activity.target}</code>
                    </>
                  ) : null}
                </span>
              </>
            ) : null}
          </span>
          {showPrChip ? <PrChip pr={pr} /> : null}
        </div>
      ) : null}
    </article>
  );
}
