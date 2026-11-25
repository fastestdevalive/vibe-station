/** Server cap on an ordered list (`MAX_ORDERED_LIST_ITEMS` in vst-routes). */
export const MAX_ORDERED_LIST_IDS = 500;

/**
 * Merge a drag result over the ids THIS client displays into the stored list.
 *
 * `stored` may hold ids this client does not show (hidden projects/pins, ids
 * only mobile knows). Those keep their previous relative positions: walk
 * `stored`, replace each displayed id's slot with the next id of
 * `displayedNext`, leave every other id in place. Displayed ids missing from
 * `stored` are inserted just before the next displayed id that is in `stored`
 * (or appended when none follows), so their displayed order is preserved.
 * The result is clamped to the 500-id server cap.
 */
export function mergeDisplayedOrder(stored: readonly string[], displayedNext: readonly string[]): string[] {
  const displayed = new Set(displayedNext);
  const storedSet = new Set(stored);
  const queue = displayedNext.filter((id) => storedSet.has(id));
  let qi = 0;
  const slotted = stored.map((id) => (displayed.has(id) ? queue[qi++]! : id));

  // Group displayed-but-unstored ids by the stored id that follows them.
  const before = new Map<string, string[]>();
  let pending: string[] = [];
  for (const id of displayedNext) {
    if (storedSet.has(id)) {
      if (pending.length > 0) before.set(id, pending);
      pending = [];
    } else {
      pending.push(id);
    }
  }
  const out: string[] = [];
  for (const id of slotted) {
    const lead = before.get(id);
    if (lead) out.push(...lead);
    out.push(id);
  }
  out.push(...pending);
  return out.slice(0, MAX_ORDERED_LIST_IDS);
}
