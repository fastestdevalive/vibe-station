import { useEffect, useState } from "react";

/** The media query that identifies a touch-primary device: a primary (main)
 *  input that is a coarse pointer (finger/stylus) with no hover capability.
 *  This is the canonical "touch mode" detector — it distinguishes a real
 *  touch device from a desktop regardless of viewport width, unlike
 *  `(max-width: 768px)` which only measures width. Mirrors the heuristic in
 *  `SkillEditor.tsx`'s `useSoftKeyboardVisible` fallback. */
const TOUCH_QUERY = "(any-pointer: coarse) and (any-hover: none)";

/**
 * Whether the current device is a touch-primary one. Reactive: recomputes when
 * the media query result changes (e.g. connecting/disconnecting a touch input,
 * or a browser that reports a hybrid device). Falls back to `false` (treat as
 * non-touch/desktop) when `matchMedia` is unavailable.
 */
export function useIsTouch(): boolean {
  const [isTouch, setIsTouch] = useState(() => {
    if (typeof window === "undefined") return false;
    if (typeof window.matchMedia !== "function") return false;
    return window.matchMedia(TOUCH_QUERY).matches;
  });

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(TOUCH_QUERY);
    const handler = () => setIsTouch(mq.matches);
    mq.addEventListener("change", handler);
    setIsTouch(mq.matches);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return isTouch;
}
