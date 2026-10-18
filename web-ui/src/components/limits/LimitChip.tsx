import type { Ref } from "react";
import type { LimitWindow } from "@/api/types";
import { ModeIcon } from "@/components/agent/ModeIcon";
import {
  ariaLabel,
  cadenceBadge,
  cadenceFromWindowId,
  chipView,
  compactResetCountdown,
  isResetImminent,
  resetCountdown,
  windowLabel,
} from "./limitsModel";

interface LimitChipProps {
  harness: string;
  window: LimitWindow | undefined;
  nowMs: number;
  /** `bar` = tappable button in the status bar; `row` = presentational span inside the popup. */
  variant: "bar" | "row";
  /** "Slot 1" for aria. */
  slotLabel?: string;
  expanded?: boolean;
  onClick?: () => void;
  /** Optional ref to the rendered button (bar variant) — lets the bar return
   *  focus to the tapped chip after the popup closes. */
  buttonRef?: Ref<HTMLButtonElement>;
  /** The slot's window id, used to show a cadence while the window has no data yet. */
  fallbackWindowId?: string;
}

const RING_R = 7.5;
const RING_C = 2 * Math.PI * RING_R;

function capitalize(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Tooltip for the bar chip: reset time, plus an as-of note when dimmed, plus
 *  a reason when the window has one. The window label (agy) is prefixed. */
function tooltipText(
  harness: string,
  windowId: string | undefined,
  window: LimitWindow | undefined,
  view: ReturnType<typeof chipView>,
  nowMs: number,
): string {
  const parts: string[] = [];
  const label = windowLabel(harness, windowId ?? "");
  if (label) parts.push(label);
  if (window?.resetsAt) {
    parts.push(view.kind === "reset" ? "Reset" : capitalize(resetCountdown(window.resetsAt, nowMs)));
  }
  if (view.dim && view.asOfLabel) parts.push(`as of ${view.asOfLabel}`);
  if (view.reason) parts.push(view.reason);
  return parts.join(" · ");
}

export function LimitChip({
  harness,
  window,
  nowMs,
  variant,
  slotLabel,
  expanded,
  onClick,
  buttonRef,
  fallbackWindowId,
}: LimitChipProps) {
  const view = chipView(window, nowMs);
  const cadence = window?.cadenceMinutes ?? cadenceFromWindowId(fallbackWindowId);
  const isBar = variant === "bar";

  const ringPct = view.pct !== null ? Math.min(view.pct, 100) : 0;
  const dash = view.pct !== null ? `${(ringPct / 100) * RING_C} ${RING_C}` : `0 ${RING_C}`;

  const className = [
    "limit-chip",
    view.dim ? "limit-chip--dim" : "",
    view.kind === "warn" ? "limit-chip--warn" : "",
    view.kind === "limit" ? "limit-chip--limit" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const pctText = view.kind === "nodata" ? "—" : view.pctText;
  const isPercentView = view.kind === "ok" || view.kind === "warn" || view.kind === "limit";
  const pctDisplay = !isBar && isPercentView ? `${pctText} used` : pctText;

  const label = ariaLabel(harness, window, view, nowMs);
  const tooltipWindowId = window?.windowId ?? fallbackWindowId;

  const ringText = cadenceBadge(cadence);

  const showImminentCountdown = isBar && isResetImminent(window?.resetsAt, nowMs);

  const inner = (
    <>
      <ModeIcon iconKey={harness} channel="json" size={12} />
      <svg
        className="limit-chip__ring"
        width="18"
        height="18"
        viewBox="0 0 18 18"
        aria-hidden="true"
      >
        <circle
          className="limit-chip__ring-track"
          cx="9"
          cy="9"
          r={RING_R}
          fill="none"
          strokeWidth="1.5"
        />
        <circle
          className="limit-chip__ring-arc"
          cx="9"
          cy="9"
          r={RING_R}
          fill="none"
          strokeWidth="1.5"
          strokeDasharray={dash}
          strokeLinecap="round"
          transform="rotate(-90 9 9)"
        />
        {ringText && (
          <text
            className="limit-chip__ring-text"
            x="9"
            y="9"
            textAnchor="middle"
            dominantBaseline="central"
          >
            {ringText}
          </text>
        )}
      </svg>
      <span className="limit-chip__pct">{pctDisplay}</span>
      {showImminentCountdown && (
        <span className="limit-chip__countdown">
          {compactResetCountdown(window?.resetsAt ?? null, nowMs)}
        </span>
      )}
      {view.glyph && <span className="limit-chip__glyph" aria-hidden="true">{view.glyph}</span>}
    </>
  );

  if (isBar) {
    return (
      <button
        type="button"
        ref={buttonRef}
        className={className}
        aria-haspopup="dialog"
        aria-expanded={expanded}
        aria-label={slotLabel ? `${slotLabel}, ${label}` : label}
        title={tooltipText(harness, tooltipWindowId, window, view, nowMs)}
        onClick={onClick}
      >
        {inner}
      </button>
    );
  }

  return (
    <span className={className} title={tooltipText(harness, tooltipWindowId, window, view, nowMs)}>
      {inner}
    </span>
  );
}
