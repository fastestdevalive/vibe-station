import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Keeps a list's order stable while the pointer is over it, so a card does not
 * jump out from under the cursor when activity re-sorts the list.
 *
 * Not hovered: `order` is `ids` as given. Hovered: the order at hover start,
 * minus ids that disappeared, plus new ids appended in their given order.
 * Leaving the list re-applies the live order.
 */
export function useHoverFrozenOrder(ids: string[]): {
  order: string[];
  hoverProps: { onPointerEnter: () => void; onPointerLeave: () => void };
} {
  const [frozen, setFrozen] = useState<string[] | null>(null);
  const lastOrder = useRef<string[]>(ids);

  const order = useMemo(() => {
    if (!frozen) return ids;
    const live = new Set(ids);
    const kept = frozen.filter((id) => live.has(id));
    const known = new Set(kept);
    return [...kept, ...ids.filter((id) => !known.has(id))];
  }, [frozen, ids]);

  useEffect(() => {
    lastOrder.current = order;
  }, [order]);

  const onPointerEnter = useCallback(() => setFrozen(lastOrder.current), []);
  const onPointerLeave = useCallback(() => setFrozen(null), []);

  return { order, hoverProps: { onPointerEnter, onPointerLeave } };
}
