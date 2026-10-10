import type { UsageInfo } from "@/api/types";
import { fmt } from "@/lib/formatTokens";

/** Share of the context window at which the meter turns orange, then red. */
const WARN_CONTEXT_PCT = 80;
const DANGER_CONTEXT_PCT = 90;

/**
 * Context-window meter shown at the right of the composer's status row: a thin
 * fill bar + "18k / 200k". Stays theme-coloured until 80% (orange), then 90% (red) as a
 * heads-up before the window is exhausted. Without a known window there is nothing to fill, so only the
 * token count renders. Cost is deliberately never shown.
 */
export function ContextMeter({ usage }: { usage: UsageInfo | undefined }) {
  if (!usage) return null;
  const total = usage.totalTokens;
  const ctx = usage.contextWindow;
  const hasWindow = !!ctx && ctx > 0;
  const pct = hasWindow ? Math.min(100, Math.round((total / ctx) * 100)) : null;
  const level =
    pct == null ? null : pct >= DANGER_CONTEXT_PCT ? "danger" : pct >= WARN_CONTEXT_PCT ? "warn" : null;
  const title = hasWindow
    ? `Context window: ${total.toLocaleString("en-US")} / ${ctx.toLocaleString("en-US")} tokens (${pct}%)`
    : `${total.toLocaleString("en-US")} tokens used`;

  return (
    <div
      className={`ctx-meter${level ? ` ctx-meter--${level}` : ""}`}
      title={title}
      {...(hasWindow
        ? { role: "meter", "aria-label": "Context window used", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": pct! }
        : {})}
    >
      {hasWindow ? (
        <span className="ctx-meter__bar" aria-hidden>
          <span className="ctx-meter__fill" style={{ width: `${pct}%` }} />
        </span>
      ) : null}
      <span className="ctx-meter__text">
        {fmt(total)}
        {hasWindow ? <span className="ctx-meter__total"> / {fmt(ctx)}</span> : null}
      </span>
    </div>
  );
}
