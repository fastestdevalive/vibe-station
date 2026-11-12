import type { LimitWindow } from "@/api/types";
import { useLimits } from "@/hooks/useLimits";
import { cadenceBadge, cadenceFromWindowId } from "@/components/limits/limitsModel";
import "./accounts.css";

interface AccountLimitMeterProps {
  cli: string;
  /** `"system"` / absent = the CLI's System login. */
  accountId: string | null | undefined;
  /** Only the tightest (most used) window, for dense rows. */
  compact?: boolean;
}

/** Short window label: "5h" for the rolling five hours, else the cadence badge ("wk", "mo"). */
function windowShortLabel(win: LimitWindow): string {
  const minutes = win.cadenceMinutes ?? cadenceFromWindowId(win.windowId);
  if (minutes === 300) return "5h";
  return cadenceBadge(minutes) || win.windowId.replace(/_/g, " ");
}

type Measured = LimitWindow & { usedPct: number };

function hasUsage(win: LimitWindow): win is Measured {
  return typeof win.usedPct === "number" && Number.isFinite(win.usedPct);
}

function fillTone(pct: number): "ok" | "warn" | "danger" {
  if (pct >= 100) return "danger";
  if (pct >= 90) return "warn";
  return "ok";
}

/**
 * A slim (2px) usage meter per limit window that has data, labelled by window
 * ("5h 12%", "wk 56%"). Renders nothing when the account has no numeric data
 * (signed out, API key, not probed yet) — never a fake 0.
 */
export function AccountLimitMeter({ cli, accountId, compact = false }: AccountLimitMeterProps) {
  const { resultFor } = useLimits();
  const result = resultFor(cli, accountId && accountId !== "system" ? accountId : undefined);
  let windows = (result?.windows ?? []).filter(hasUsage);
  if (compact && windows.length > 1) {
    windows = [windows.reduce((tight, w) => (w.usedPct > tight.usedPct ? w : tight))];
  }
  if (windows.length === 0) return null;
  return (
    <span className={`account-meter${compact ? " account-meter--compact" : ""}`}>
      {windows.map((win) => {
        const pct = Math.max(0, Math.min(100, Math.round(win.usedPct)));
        const label = windowShortLabel(win);
        return (
          <span key={win.windowId} className="account-meter__win">
            <span className="account-meter__label">{label}</span>
            <span
              className="account-meter__track"
              role="meter"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              aria-label={`${label} ${pct}% used`}
            >
              <span
                className={`account-meter__fill account-meter__fill--${fillTone(win.usedPct)}`}
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="account-meter__pct">{pct}%</span>
          </span>
        );
      })}
    </span>
  );
}
