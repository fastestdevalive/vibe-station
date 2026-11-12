/**
 * Format an ISO timestamp or date into a compact relative duration:
 * e.g. "now", "5m", "3h", "2d", "1w", "1mo", "1y".
 */
export function formatTimeAgo(
  isoOrDate: string | number | Date | null | undefined,
  now = Date.now(),
): string {
  if (!isoOrDate) return "";
  const then =
    isoOrDate instanceof Date
      ? isoOrDate.getTime()
      : typeof isoOrDate === "number"
        ? isoOrDate
        : new Date(isoOrDate).getTime();
  if (Number.isNaN(then) || then <= 0) return "";
  const diffMs = Math.max(0, now - then);
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (days < 30) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (days < 365) return `${months}mo`;
  const years = Math.floor(days / 365);
  return `${years}y`;
}

/**
 * Full local timestamp for tooltips: "Tue 20 Oct 2026, 23:44" (24h, en-GB
 * order, local time). Empty string for missing/invalid input.
 */
export function formatFullTimestamp(isoOrDate: string | number | Date | null | undefined): string {
  if (!isoOrDate) return "";
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")}`;
}

type TimeInput = string | number | Date | null | undefined;

const DAY_MS = 86_400_000;

function toMs(t: TimeInput): number | null {
  if (t == null || t === "") return null;
  const ms = t instanceof Date ? t.getTime() : typeof t === "number" ? t : new Date(t).getTime();
  return Number.isNaN(ms) || ms <= 0 ? null : ms;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function dateFormat(locale: string | undefined, kind: "day-time" | "day-year" | "time" | "full"): Intl.DateTimeFormat {
  const cacheKey = `${locale ?? ""}|${kind}`;
  let f = formatters.get(cacheKey);
  if (!f) {
    const opts: Intl.DateTimeFormatOptions =
      kind === "day-time"
        ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
        : kind === "day-year"
          ? { month: "short", day: "numeric", year: "numeric" }
          : kind === "time"
            ? { hour: "numeric", minute: "2-digit" }
            : { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" };
    f = new Intl.DateTimeFormat(locale, opts);
    formatters.set(cacheKey, f);
  }
  return f;
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * Outline row time: "now" / "5m" / "3h" under a day old; past that an absolute
 * browser-locale date ("Nov 11, 3:42 PM", or "Nov 11, 2025" in another year).
 * A beat (`parentTs` = its turn's time) on its turn's calendar day shows only
 * the time once that turn is a day old. Empty string for missing/invalid input.
 * `locale` is for tests; the UI always uses the browser's.
 */
export function formatOutlineTime(ts: TimeInput, now = Date.now(), parentTs?: TimeInput, locale?: string): string {
  const then = toMs(ts);
  if (then == null) return "";
  if (now - then < DAY_MS) return formatTimeAgo(then, now);
  const d = new Date(then);
  const parent = toMs(parentTs);
  if (parent != null && now - parent >= DAY_MS && sameLocalDay(new Date(parent), d)) {
    return dateFormat(locale, "time").format(d);
  }
  const kind = d.getFullYear() === new Date(now).getFullYear() ? "day-time" : "day-year";
  return dateFormat(locale, kind).format(d);
}

/** Tooltip for an outline time, in the same browser locale as its label: "Wed, Nov 11, 2026, 3:42 PM". */
export function formatOutlineTitle(ts: TimeInput, locale?: string): string {
  const then = toMs(ts);
  return then == null ? "" : dateFormat(locale, "full").format(new Date(then));
}

/** Spoken age for screen readers: "now", "5 minutes ago", "yesterday", else the full date. */
export function formatOutlineSpokenTime(ts: TimeInput, now = Date.now(), locale?: string): string {
  const then = toMs(ts);
  if (then == null) return "";
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const mins = Math.floor(Math.max(0, now - then) / 60_000);
  if (mins < 1) return rtf.format(0, "second");
  if (mins < 60) return rtf.format(-mins, "minute");
  const hours = Math.floor(mins / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 7) return rtf.format(-days, "day");
  return formatOutlineTitle(then, locale);
}
