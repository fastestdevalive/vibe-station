import type { NormalizedEvent, TranscriptSincePage } from "@/api/types";

/** A forward page cut back to a turn boundary, plus the cursor to page from next. */
export interface ForwardPage {
  events: NormalizedEvent[];
  /** `logSeq` of the last row this page accounts for. */
  cursor: number;
  /** True when rows newer than `cursor` exist. */
  hasMore: boolean;
}

/**
 * Align a `since` page (a fixed number of rows, so it can stop mid-turn) to a
 * turn boundary: while newer rows exist, the trailing rows of the page's last
 * turn are dropped and re-read by the next page, so a turn is appended whole.
 * A page holding a single turn is kept as is (the turn is longer than a page).
 */
export function alignForwardPage(page: TranscriptSincePage, since: number): ForwardPage {
  const events = page.events;
  const end = page.nextSeq ?? events[events.length - 1]?.logSeq ?? since;
  if (!page.hasMore) return { events, cursor: end, hasMore: false };
  const lastTurn = events[events.length - 1]?.turnId;
  if (!lastTurn) return { events, cursor: end, hasMore: true };
  let cut = events.length;
  while (cut > 0 && (events[cut - 1]!.turnId ?? lastTurn) === lastTurn) cut--;
  const cutSeq = cut > 0 ? events[cut - 1]!.logSeq : undefined;
  if (cutSeq == null) return { events, cursor: end, hasMore: true };
  return { events: events.slice(0, cut), cursor: cutSeq, hasMore: true };
}

/** `logSeq` of the first event that has one. */
export function firstLogSeq(events: readonly NormalizedEvent[]): number | null {
  for (const ev of events) if (ev.logSeq != null) return ev.logSeq;
  return null;
}
