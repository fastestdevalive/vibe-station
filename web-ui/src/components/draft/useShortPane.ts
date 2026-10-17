import { useEffect, useState, type RefObject } from "react";

export const SHORT_PANE_PX = 520;

/** True when the pane's usable height is below `threshold` px, so the draft's
 *  field rows can fold into a one-line summary (Decision 4). Uses a
 *  `ResizeObserver` on the given ref; a no-op (returns `false`) when
 *  `ResizeObserver` is unavailable (e.g. jsdom without a stub). */
export function useShortPane(ref: RefObject<HTMLElement | null>, threshold = SHORT_PANE_PX): boolean {
  const [short, setShort] = useState(false);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setShort(entry.contentRect.height < threshold);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, threshold]);

  return short;
}
