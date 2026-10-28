/** Schedule time copy shared by the Rich Chat and Terminal strips (board 12). */

const COUNTDOWN_MS = 10 * 60 * 1000;

/** Intl output uses U+202F before AM/PM on newer ICU; normalise to a plain space. */
function clean(s: string): string {
  return s.replace(/[\u202f\u00a0]/g, " ");
}

/** "3:00 PM" in the local timezone. */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return clean(d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * "in 4m 12s" under 10 minutes; "Today 3:00 PM" / "Tomorrow 9:00 AM"; "Wed 9:00 AM"
 * for later days within a week; "Nov 3, 9:00 AM" beyond (and for past times on an
 * earlier day). Local timezone; DST-safe because days are compared as calendar
 * dates, not as 24h blocks.
 */
export function formatScheduleTime(fireAt: string, now: Date = new Date()): string {
  const d = new Date(fireAt);
  if (Number.isNaN(d.getTime())) return "";
  const diffMs = d.getTime() - now.getTime();
  if (diffMs >= 0 && diffMs < COUNTDOWN_MS) {
    const mins = Math.floor(diffMs / 60_000);
    const secs = Math.floor((diffMs % 60_000) / 1000);
    return mins === 0 ? `in ${secs}s` : `in ${mins}m ${secs}s`;
  }
  const clock = formatClock(fireAt);
  const dayDiff = Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000);
  if (dayDiff === 0) return `Today ${clock}`;
  if (dayDiff === 1) return `Tomorrow ${clock}`;
  if (dayDiff >= 2 && dayDiff < 7) {
    return `${clean(d.toLocaleDateString(undefined, { weekday: "short" }))} ${clock}`;
  }
  return clean(
    d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
  );
}

/** True while `fireAt` is in the per-second countdown window (0 to 10 min away). */
export function isCountdown(fireAt: string, now: number = Date.now()): boolean {
  const t = Date.parse(fireAt);
  return !Number.isNaN(t) && t - now >= 0 && t - now < COUNTDOWN_MS;
}
