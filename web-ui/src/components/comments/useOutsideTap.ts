import { useEffect, useRef } from "react";

/**
 * Regions that are never "outside" a comment layer. `pins: true` also treats pin stacks as inside (the view card:
 * the pin's own click toggles / replaces it).
 */
export function isInsideCommentLayer(t: EventTarget | null, o: { pins: boolean }): boolean {
  if (!(t instanceof Element)) return false;
  return !!t.closest(
    `[data-comment-float], [data-selection-popover], .comment-delete-error, [role="dialog"], .bottom-sheet, .bottom-sheet__backdrop${o.pins ? ", [data-comment-stack]" : ""}`,
  );
}

const MOVE_PX = 8;
const MOVE_PX_TOUCH = 10;
const MAX_MS = 600;

interface Opts {
  /** True for targets that are part of the layer (never an outside tap). */
  inside: (t: EventTarget | null) => boolean;
  onTap: () => void;
}

interface Tracked {
  id: number;
  x: number;
  y: number;
  t: number;
  touch: boolean;
  cancelled: boolean;
}

/**
 * Calls `onTap` for a primary-button tap / click that starts AND ends outside `inside`, without moving more than
 * 8px (touch 10px), lasting under 600ms and leaving the selection collapsed: scrolls, drags, text selection and
 * long-press never count. Capture phase on `document`; never prevents or stops the event (the page is never
 * trapped). `click` is not used because iOS does not fire it on non-interactive elements.
 */
export function useOutsideTap(active: boolean, opts: Opts): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (!active) return undefined;
    let tracked: Tracked | null = null;
    const down = (e: PointerEvent) => {
      if (tracked && tracked.id !== e.pointerId) {
        tracked.cancelled = true; // a second pointer: multi-touch is a gesture, not a tap
        return;
      }
      if (e.button !== 0 || optsRef.current.inside(e.target)) {
        tracked = null;
        return;
      }
      tracked = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp || Date.now(), touch: e.pointerType === "touch", cancelled: false };
    };
    const move = (e: PointerEvent) => {
      if (!tracked || tracked.id !== e.pointerId) return;
      const limit = tracked.touch ? MOVE_PX_TOUCH : MOVE_PX;
      if (Math.hypot(e.clientX - tracked.x, e.clientY - tracked.y) > limit) tracked.cancelled = true;
    };
    const cancel = (e: PointerEvent) => {
      if (tracked && tracked.id === e.pointerId) tracked = null;
    };
    const up = (e: PointerEvent) => {
      const cur = tracked;
      if (!cur || cur.id !== e.pointerId) return;
      tracked = null;
      if (cur.cancelled) return;
      const limit = cur.touch ? MOVE_PX_TOUCH : MOVE_PX;
      if (Math.hypot(e.clientX - cur.x, e.clientY - cur.y) > limit) return;
      if ((e.timeStamp || Date.now()) - cur.t > MAX_MS) return;
      const sel = typeof document.getSelection === "function" ? document.getSelection() : null;
      if (sel && !sel.isCollapsed && sel.toString() !== "") return;
      if (optsRef.current.inside(e.target)) return;
      optsRef.current.onTap();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointermove", move, { capture: true, passive: true });
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", cancel, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", cancel, true);
    };
  }, [active]);
}
