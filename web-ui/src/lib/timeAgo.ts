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
