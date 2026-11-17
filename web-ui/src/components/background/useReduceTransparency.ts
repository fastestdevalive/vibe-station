import { useEffect, useState } from "react";

const REDUCED_TRANSPARENCY_QUERY = "(prefers-reduced-transparency: reduce)";

/**
 * The system 'reduce transparency' preference: with it on the window
 * is solid no matter what is stored. `false` when the platform cannot answer
 * (and in jsdom's stub).
 */
export function useReduceTransparency(): boolean {
  const [reduce, setReduce] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(REDUCED_TRANSPARENCY_QUERY).matches === true,
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(REDUCED_TRANSPARENCY_QUERY);
    const update = () => setReduce(query.matches === true);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  return reduce;
}
