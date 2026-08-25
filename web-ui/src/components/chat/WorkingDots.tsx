import { useEffect, useState } from "react";

/** Milliseconds each dot-count step of `WorkingDots` is shown. */
const WORKING_INDICATOR_STEP_MS = 450;

/** The animated `•••` dot-cycle shared by the in-feed `WorkingIndicator`
 *  (MessageList) and the footer `StatusBar`'s scrolled-away busy hint. Dot
 *  COUNT cycles 1 → 2 → 3 → 1 (not a spinner). Only the dots — every caller
 *  supplies its own wrapper (live region, label, positioning), so the interval
 *  and the reduced-motion opt-out live in exactly one place.
 *
 *  Mount it only while busy: the interval's lifetime IS the component's, so
 *  there is no separate start/stop wiring. */
export function WorkingDots() {
  const [count, setCount] = useState(1);
  useEffect(() => {
    // Explicit `prefers-reduced-motion` check: this dot-cycle's motion is a
    // JS interval (not CSS-driven, so an `@media (prefers-reduced-motion)`
    // rule alone can't stop it) — has to honor the opt-out itself.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => {
      setCount((c) => (c >= 3 ? 1 : c + 1));
    }, WORKING_INDICATOR_STEP_MS);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span className="chat-working-indicator__dots" aria-hidden>
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          className={`chat-working-indicator__dot${n <= count ? " chat-working-indicator__dot--on" : ""}`}
        />
      ))}
    </span>
  );
}
