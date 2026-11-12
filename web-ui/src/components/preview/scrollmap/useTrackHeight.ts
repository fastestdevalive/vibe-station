import { useEffect, useState, type RefObject } from "react";

/** Height of the scroll-map track element, kept current by a ResizeObserver;
 *  falls back to a direct measurement until the first observation lands. */
export function useTrackHeight(ref: RefObject<HTMLElement | null>): number {
  const [observed, setObserved] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const h = el.clientHeight;
      if (h > 0) setObserved(h);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  if (observed > 0) return observed;
  const el = ref.current;
  return el ? el.clientHeight || el.getBoundingClientRect().height : 0;
}
