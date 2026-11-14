import { useCallback, useEffect, useRef } from "react";
import type { MouseEvent, PointerEvent } from "react";

/** Hold time before a press counts as a long-press. */
export const LONG_PRESS_MS = 500;
/** Finger travel (px) beyond which the press is a scroll/drag, not a hold. */
export const LONG_PRESS_SLOP_PX = 8;
/** How long after a fired long-press the trailing click is swallowed. */
const CLICK_SUPPRESS_MS = 800;
/** Once the hold has fired, how long after a lift the trailing click is still swallowed (a hold longer than the suppress window). */
const LIFT_GRACE_MS = 400;

export interface LongPressOptions {
  /** When false (mouse-primary devices) every handler is inert. */
  enabled: boolean;
  /**
   * Called when a hold completes. `target` is the element the press started
   * on, so one container can serve many rows (event delegation). Return
   * `false` if nothing was handled — the following click is then NOT
   * suppressed and a plain tap/press behaves normally.
   */
  onLongPress: (target: HTMLElement, point: { x: number; y: number }) => boolean | void;
  delay?: number;
  slop?: number;
}

/**
 * Touch long-press detector, meant to be spread on a container. Mouse
 * pointers are ignored (hover/right-click keep working untouched). Cancels on
 * pointerup/cancel, movement past `slop`, and scroll. After a long-press
 * fires, the click the finger-lift produces is swallowed, and the browser's
 * native context menu is suppressed (touch only).
 */
export function useLongPress({ enabled, onLongPress, delay = LONG_PRESS_MS, slop = LONG_PRESS_SLOP_PX }: LongPressOptions) {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const suppressUntil = useRef(0);
  const docSwallow = useRef<((e: Event) => void) | null>(null);
  const cb = useRef(onLongPress);
  cb.current = onLongPress;

  const cancel = useCallback(() => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  }, []);

  const disarmDoc = useCallback(() => {
    if (docSwallow.current) document.removeEventListener("click", docSwallow.current, true);
    docSwallow.current = null;
  }, []);
  // The lift click can land outside the container (a portaled sheet's backdrop): swallow it at the document too.
  const armDoc = useCallback(() => {
    disarmDoc();
    const fn = (e: Event) => {
      disarmDoc();
      if (suppressUntil.current === 0) return;
      const live = performance.now() < suppressUntil.current;
      suppressUntil.current = 0;
      if (live) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    docSwallow.current = fn;
    document.addEventListener("click", fn, true);
  }, [disarmDoc]);

  useEffect(() => () => { cancel(); disarmDoc(); }, [cancel, disarmDoc]);

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      cancel();
      disarmDoc();
      suppressUntil.current = 0;
      if (!enabled || e.pointerType === "mouse" || e.isPrimary === false) return;
      const point = { x: e.clientX, y: e.clientY };
      const target = e.target as HTMLElement;
      origin.current = point;
      timer.current = window.setTimeout(() => {
        timer.current = null;
        origin.current = null;
        if (cb.current(target, point) !== false) {
          suppressUntil.current = performance.now() + CLICK_SUPPRESS_MS;
          armDoc();
        }
      }, delay);
    },
    [enabled, delay, cancel, disarmDoc, armDoc],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      const o = origin.current;
      if (!o) return;
      if (Math.hypot(e.clientX - o.x, e.clientY - o.y) > slop) cancel();
    },
    [slop, cancel],
  );

  // The finger lifts after the hold: the click it produces is still swallowed, even past the suppress window.
  const lift = useCallback(() => {
    if (suppressUntil.current !== 0) suppressUntil.current = performance.now() + LIFT_GRACE_MS;
    cancel();
  }, [cancel]);

  const onClickCapture = useCallback((e: MouseEvent<HTMLElement>) => {
    if (suppressUntil.current === 0) return;
    const live = performance.now() < suppressUntil.current;
    suppressUntil.current = 0;
    if (live) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, []);

  const onContextMenu = useCallback(
    (e: MouseEvent<HTMLElement>) => {
      // Touch/pen only: stop the native long-press menu/callout. A mouse
      // right-click keeps its native context menu. Engines that report no
      // pointerType on contextmenu are treated as touch (we are `enabled`).
      const pt = (e.nativeEvent as { pointerType?: string }).pointerType;
      if (enabled && pt !== "mouse") e.preventDefault();
    },
    [enabled],
  );

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: lift,
    onPointerCancel: lift,
    onScrollCapture: cancel,
    onClickCapture,
    onContextMenu,
  };
}
