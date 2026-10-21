import { useNowTick } from "@/hooks/useNowTick";
import { formatFullTimestamp, formatTimeAgo } from "@/lib/timeAgo";

/**
 * "2m" / "3w" with a "Last activity <full timestamp>" tooltip. Renders
 * nothing for a missing/invalid timestamp.
 */
export function RelativeTime({ at, className }: { at: string | null | undefined; className?: string }) {
  const now = useNowTick();
  const text = at ? formatTimeAgo(at, now) : "";
  if (!at || !text) return null;
  return (
    <time
      dateTime={at}
      title={`Last activity ${formatFullTimestamp(at)}`}
      className={className}
      style={{ fontVariantNumeric: "tabular-nums" }}
    >
      {text}
    </time>
  );
}
