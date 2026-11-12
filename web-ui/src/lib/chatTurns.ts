import type { NormalizedEvent } from "@/api/types";

/** A rendered user turn's opening event (silent notice turns and superseded rows are not turns). */
export function isUserTurnEvent(ev: NormalizedEvent): boolean {
  return ev.kind === "user" && !ev.superseded && !ev.silent;
}

/** Distinct user turns among `events` (a repeated `user` row of one turnId counts once). */
export function countUserTurns(events: NormalizedEvent[]): number {
  const seenTurnIds = new Set<string>();
  let count = 0;
  for (const ev of events) {
    if (!isUserTurnEvent(ev)) continue;
    const turnKey = ev.turnId ?? ev.id;
    if (!seenTurnIds.has(turnKey)) {
      seenTurnIds.add(turnKey);
      count++;
    }
  }
  return count;
}
