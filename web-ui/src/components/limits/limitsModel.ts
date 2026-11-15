import type { LimitDollars, LimitSlotRef, LimitStatus, LimitWindow, LimitsResult } from "@/api/types";

export type SlotIndex = 0 | 1;

/** How long a cached limit value is considered fresh. After this the chip is
 *  dimmed (with an as-of timestamp) even though the number still shows. */
export const STALE_AFTER_MS = 30 * 60 * 1000;

/** Two refs identify the same slot iff harness, window AND account match.
 *  `accountId ?? null` so an absent accountId means the System login. */
export function sameRef(a: LimitSlotRef, b: LimitSlotRef): boolean {
  return (
    a.harness === b.harness &&
    a.windowId === b.windowId &&
    (a.accountId ?? null) === (b.accountId ?? null)
  );
}

/** The persisted slot key (mirror of `LimitSlotRef::to_key`):
 *  `"<harness>/<windowId>"` for the System login, `"<harness>/<windowId>@<accountId>"`
 *  for a named account. */
export function slotKey(ref: LimitSlotRef): string {
  return ref.accountId
    ? `${ref.harness}/${ref.windowId}@${ref.accountId}`
    : `${ref.harness}/${ref.windowId}`;
}

/** One harness's results, grouped per account (System first within a harness —
 *  the server's own order). */
export interface HarnessAccountGroup {
  /** Account id; absent = the CLI's System login. */
  accountId?: string;
  results: LimitsResult[];
}

export interface HarnessGroup {
  harness: string;
  accounts: HarnessAccountGroup[];
}

/** Group the limits snapshot by harness, then by account (plan B3.9). The
 *  popup renders "Claude · Work" headings from this; a harness with a single
 *  account group renders its bare harness label. */
export function groupByAccount(results: LimitsResult[]): HarnessGroup[] {
  const harnesses = new Map<string, HarnessAccountGroup[]>();
  for (const result of results) {
    const groups = harnesses.get(result.harness) ?? [];
    const key = result.accountId ?? null;
    const existing = groups.find((g) => (g.accountId ?? null) === key);
    if (existing) {
      existing.results.push(result);
    } else {
      groups.push({
        ...(result.accountId ? { accountId: result.accountId } : {}),
        results: [result],
      });
    }
    harnesses.set(result.harness, groups);
  }
  return [...harnesses.entries()].map(([harness, accounts]) => ({ harness, accounts }));
}

/** Compute the new two-slot layout after the user picks `picked` for
 *  `slotIndex`:
 *  - same as the current slot → unchanged;
 *  - equals the OTHER slot → swap the two;
 *  - otherwise → replace `slotIndex` only. */
export function nextSlots(
  slots: [LimitSlotRef, LimitSlotRef],
  slotIndex: SlotIndex,
  picked: LimitSlotRef,
): [LimitSlotRef, LimitSlotRef] {
  const current = slots[slotIndex];
  if (sameRef(current, picked)) return slots;
  const other = slots[slotIndex === 0 ? 1 : 0];
  if (sameRef(other, picked)) {
    return slotIndex === 0 ? [picked, current] : [current, picked];
  }
  const next: [LimitSlotRef, LimitSlotRef] = [...slots] as [LimitSlotRef, LimitSlotRef];
  next[slotIndex] = picked;
  return next;
}

/** Human label for a window's cadence (reset frequency). */
/** Best-effort cadence for a slot whose window has no data yet (derived from the stable window id).
 *  Handles the agy ids (`3p_5h` → 300, `gemini_weekly` → 10080) alongside the legacy claude ids. */
export function cadenceFromWindowId(windowId: string | undefined): number | null {
  if (windowId === "five_hour") return 300;
  if (windowId === "seven_day") return 10080;
  if (windowId?.startsWith("seven_day:")) return 10080;
  if (windowId?.startsWith("five_hour:")) return 300;
  if (windowId?.endsWith("_5h")) return 300;
  if (windowId?.endsWith("_weekly")) return 10080;
  return null;
}

/** Known agy window-id → human label. Keys are the lowercased bucket ids from
 *  the vendor's `/usage` output (see agy_limits.rs Decision 2). */
const AGY_WINDOW_LABELS: Record<string, string> = {
  gemini_5h: "Gemini · 5h",
  gemini_weekly: "Gemini · weekly",
  "3p_5h": "Claude/GPT · 5h",
  "3p_weekly": "Claude/GPT · weekly",
  gemini_argon_wtu_weekly: "Gemini 4 Argon · weekly",
};

/** Ids whose cadence ring already names them; they never need a label. */
const STABLE_PLAN_IDS = new Set(["five_hour", "seven_day", "primary", "secondary"]);

/** Human label for a window row, or `null` when the harness's own cadence ring
 *  already conveys it (claude / codex plan windows). Precedence: the daemon's
 *  `label` (a scoped meter like "Fable", a prettified codename) → agy's known
 *  ids → a readable fallback from the id (`foo_bar_5h` → "foo bar 5h",
 *  `seven_day:model:fable` → "seven day · model · fable"), so rows are never
 *  indistinguishable and an unknown bucket never renders blank. */
export function windowLabel(harness: string, windowId: string, label?: string | null): string | null {
  if (label) return label;
  if (harness === "agy") {
    return AGY_WINDOW_LABELS[windowId] ?? windowId.replace(/_/g, " ");
  }
  if (!windowId || STABLE_PLAN_IDS.has(windowId)) return null;
  return windowId.replace(/_/g, " ").replace(/:/g, " · ");
}

/** "$1.17 of $250" / "$250 cap" for a dollar-based bucket; `null` for a percent bucket. */
export function dollarsText(d: LimitDollars | null | undefined): string | null {
  if (!d || d.limit == null) return null;
  const money = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
  if (d.used != null) return `${money(d.used)} of ${money(d.limit)}`;
  if (d.remaining != null) return `${money(d.remaining)} left of ${money(d.limit)}`;
  return `${money(d.limit)} cap`;
}

export function cadenceLabel(minutes: number | null): string {
  if (minutes === null) return "limit";
  if (minutes === 300) return "Rolling hours";
  if (minutes < 60) return `${minutes}m`;
  if (minutes === 10080) return "wk";
  if (minutes >= 40320 && minutes <= 44640) return "mo";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.round(minutes / 60)}h`;
}

/** Short 1-2 char badge for the center of the circular progress bar. */
export function cadenceBadge(minutes: number | null): string {
  if (minutes === null) return "";
  if (minutes === 300) return "hr";
  if (minutes === 10080) return "wk";
  if (minutes >= 40320 && minutes <= 44640) return "mo";
  if (minutes < 60) return `${minutes}m`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.round(minutes / 60)}h`;
}

/** "resets in 12m" / "resets in 2h 10m" / "resets in 21d" countdown from `resetsAt`; "—" if null;
 *  "reset" if already past. Used in popup dialog rows. */
export function resetCountdown(resetsAt: string | null, nowMs: number): string {
  if (!resetsAt) return "—";
  const target = new Date(resetsAt).getTime();
  const diffMs = target - nowMs;
  if (diffMs <= 0) return "reset";
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return `resets in ${diffMin}m`;
  if (diffMin < 48 * 60) {
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    return m === 0 ? `resets in ${h}h` : `resets in ${h}h ${m}m`;
  }
  const d = Math.floor(diffMin / (60 * 24));
  return `resets in ${d}d`;
}

/** Compact countdown for the bottom status bar: "↻ 12m" / "↻ 2h 10m" / "↻ 21d"
 *  (uses the cycle symbol ↻ to keep the bar compact). */
export function compactResetCountdown(resetsAt: string | null, nowMs: number): string {
  if (!resetsAt) return "";
  const target = new Date(resetsAt).getTime();
  const diffMs = target - nowMs;
  if (diffMs <= 0) return "reset";
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return `↻ ${diffMin}m`;
  if (diffMin < 48 * 60) {
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    return m === 0 ? `↻ ${h}h` : `↻ ${h}h ${m}m`;
  }
  const d = Math.floor(diffMin / (60 * 24));
  return `↻ ${d}d`;
}

/** Format the exact local end time for popup rows.
 *  - Same calendar day: "2:41 AM"
 *  - Within 6 days: "Wed 2:41 AM"
 *  - Further out: "Oct 19, 2:41 AM"
 */
export function formatLocalResetTime(resetsAt: string | null, nowMs: number): string | null {
  if (!resetsAt) return null;
  const target = new Date(resetsAt);
  const targetMs = target.getTime();
  if (isNaN(targetMs) || targetMs <= nowMs) return null;

  const now = new Date(nowMs);
  const timeStr = target.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  const isSameDay =
    target.getFullYear() === now.getFullYear() &&
    target.getMonth() === now.getMonth() &&
    target.getDate() === now.getDate();

  if (isSameDay) {
    return timeStr;
  }

  const diffDays = Math.floor((targetMs - nowMs) / (24 * 60 * 60 * 1000));
  if (diffDays < 6) {
    const weekday = target.toLocaleDateString([], { weekday: "short" });
    return `${weekday} ${timeStr}`;
  }

  const dateStr = target.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${dateStr}, ${timeStr}`;
}

/** Whether remaining time until reset is strictly positive and less than threshold (default 10h). */
export function isResetImminent(
  resetsAt: string | null | undefined,
  nowMs: number,
  thresholdMs = 10 * 60 * 60 * 1000,
): boolean {
  if (!resetsAt) return false;
  const target = new Date(resetsAt).getTime();
  const diffMs = target - nowMs;
  return diffMs > 0 && diffMs < thresholdMs;
}

export function harnessLabel(harness: string): string {
  if (harness === "claude") return "Claude";
  if (harness === "codex") return "Codex";
  return harness.charAt(0).toUpperCase() + harness.slice(1);
}

export function statusReason(status: LimitStatus, message: string | null): string | null {
  switch (status) {
    case "ok":
      return null;
    case "not_installed":
      return "Not installed";
    case "signed_out":
      return "Signed out. Sign in from Settings.";
    case "no_plan_limits":
      return "No plan limits (signed out, API key or setup-token login)";
    case "no_data":
      return "No data yet";
    case "error":
      return message ?? "Couldn't read limit";
    case "unsupported":
      return "Not supported";
  }
}

export interface ChipView {
  kind: "nodata" | "reset" | "limit" | "warn" | "ok";
  pctText: string;
  pct: number | null;
  dim: boolean;
  asOfLabel: string | null;
  glyph: "!" | null;
  reason: string | null;
}

/** Precedence: no window or null usedPct → nodata; resetsAt in the past →
 *  reset; usedPct >= 100 → limit; >= 90 → warn (glyph "!"); else ok. */
export function chipView(win: LimitWindow | undefined, nowMs: number): ChipView {
  if (!win || win.usedPct === null) {
    return {
      kind: "nodata",
      pctText: "—",
      pct: null,
      dim: false,
      asOfLabel: null,
      glyph: null,
      reason: win ? statusReason(win.status, null) : null,
    };
  }
  const stale = nowMs - new Date(win.asOf).getTime() > STALE_AFTER_MS;
  const dim = stale || win.status === "error";
  const asOfLabel = stale ? asOfLabelText(win.asOf) : null;
  const reason = win.status !== "ok" ? statusReason(win.status, null) : null;
  const pct = win.usedPct;
  if (win.resetsAt && new Date(win.resetsAt).getTime() <= nowMs) {
    return { kind: "reset", pctText: "reset", pct, dim, asOfLabel, glyph: null, reason };
  }
  if (pct >= 100) {
    return { kind: "limit", pctText: "100%", pct, dim, asOfLabel, glyph: null, reason };
  }
  if (pct >= 90) {
    return { kind: "warn", pctText: `${Math.round(pct)}%`, pct, dim, asOfLabel, glyph: "!", reason };
  }
  // A real but tiny value (e.g. a dollar bucket at 0.47%) must not read as an exact "0%".
  const pctText = pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`;
  return { kind: "ok", pctText, pct, dim, asOfLabel, glyph: null, reason };
}

function asOfLabelText(asOf: string): string {
  const d = new Date(asOf);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function ariaLabel(
  harness: string,
  win: LimitWindow | undefined,
  view: ChipView,
  nowMs: number,
): string {
  const h = harnessLabel(harness);
  const friendly = win ? windowLabel(harness, win.windowId, win.label) : null;
  const windowLabelText = win
    ? friendly !== null
      ? `${friendly} limit`
      : `${win.windowId.replace(/_/g, " ")} limit`
    : "limit";
  const base = `${h} ${windowLabelText}`;
  if (view.kind === "nodata") {
    return `${base}, no data${view.reason ? `: ${view.reason}` : ""}`;
  }
  if (view.kind === "reset") {
    return `${base}, ${view.pctText}`;
  }
  const pct =
    view.pct === null
      ? ""
      : view.pct > 0 && view.pct < 1
        ? "less than 1 percent used"
        : `${Math.round(view.pct)} percent used`;
  const reset = win?.resetsAt ? `, ${resetCountdown(win.resetsAt, nowMs)}` : "";
  if (view.kind === "limit") {
    return `${base}, ${pct}, limit reached`;
  }
  return `${base}, ${pct}${reset}`;
}
