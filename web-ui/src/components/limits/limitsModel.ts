import type { LimitSlotRef, LimitStatus, LimitWindow } from "@/api/types";

export type SlotIndex = 0 | 1;

/** How long a cached limit value is considered fresh. After this the chip is
 *  dimmed (with an as-of timestamp) even though the number still shows. */
export const STALE_AFTER_MS = 30 * 60 * 1000;

export function sameRef(a: LimitSlotRef, b: LimitSlotRef): boolean {
  return a.harness === b.harness && a.windowId === b.windowId;
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
/** Best-effort cadence for a slot whose window has no data yet (derived from the stable window id). */
export function cadenceFromWindowId(windowId: string | undefined): number | null {
  if (windowId === "five_hour") return 300;
  if (windowId === "seven_day") return 10080;
  return null;
}

export function cadenceLabel(minutes: number | null): string {
  if (minutes === null) return "limit";
  if (minutes < 60) return `${minutes}m`;
  if (minutes === 10080) return "wk";
  if (minutes >= 40320 && minutes <= 44640) return "mo";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.round(minutes / 60)}h`;
}

/** "in 12m" / "in 2h 10m" / "in 21d" countdown from `resetsAt`; "—" if null;
 *  "reset" if already past. */
export function resetCountdown(resetsAt: string | null, nowMs: number): string {
  if (!resetsAt) return "—";
  const target = new Date(resetsAt).getTime();
  const diffMs = target - nowMs;
  if (diffMs <= 0) return "reset";
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return `in ${diffMin}m`;
  if (diffMin < 48 * 60) {
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    return m === 0 ? `in ${h}h` : `in ${h}h ${m}m`;
  }
  const d = Math.floor(diffMin / (60 * 24));
  return `in ${d}d`;
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
      return "Signed out";
    case "no_plan_limits":
      return "No plan limits (API key or signed out)";
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
  return { kind: "ok", pctText: `${Math.round(pct)}%`, pct, dim, asOfLabel, glyph: null, reason };
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
  const windowLabel = win ? `${win.windowId.replace(/_/g, " ")} limit` : "limit";
  const base = `${h} ${windowLabel}`;
  if (view.kind === "nodata") {
    return `${base}, no data${view.reason ? `: ${view.reason}` : ""}`;
  }
  if (view.kind === "reset") {
    return `${base}, ${view.pctText}`;
  }
  const pct = view.pct !== null ? `${Math.round(view.pct)} percent used` : "";
  const reset = win?.resetsAt ? `, resets ${resetCountdown(win.resetsAt, nowMs)}` : "";
  if (view.kind === "limit") {
    return `${base}, ${pct}, limit reached`;
  }
  return `${base}, ${pct}${reset}`;
}
