import { useNowTick } from "@/hooks/useNowTick";
import { formatOutlineTime, formatOutlineTitle } from "@/lib/timeAgo";

export interface OutlineTimeProps {
  ts?: string;
  /** A merged beat's last timestamp: the tooltip then reads "start – end". */
  tsEnd?: string;
  /** The owning turn's timestamp, for a beat (same-day beats then show only the time). */
  parentTs?: string;
}

/**
 * An outline row's time, at the row's right edge. Subscribes to the shared minute
 * tick so the visible timestamp stays fresh. (TurnOutlinePanel also subscribes
 * to keep treeitem aria-labels fresh.) Renders nothing for a missing/invalid timestamp.
 */
export function OutlineTime({ ts, tsEnd, parentTs }: OutlineTimeProps) {
  const now = useNowTick();
  const text = formatOutlineTime(ts, now, parentTs);
  if (!ts || !text) return null;
  const start = formatOutlineTitle(ts);
  const end = tsEnd ? formatOutlineTitle(tsEnd) : "";
  return (
    <time className="olp__time" dateTime={ts} title={end ? `${start} – ${end}` : start}>
      {text}
    </time>
  );
}
