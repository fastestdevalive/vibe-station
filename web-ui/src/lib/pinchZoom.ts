/**
 * Two-finger pinch → zoom, for an element that isn't the whole page (e.g. the
 * file preview body). Two input sources feed the same `onDelta` callback:
 *
 *  - Touch (phones/tablets): two `touches` moving apart/together. Naturally
 *    touch-only — a mouse/trackpad never dispatches `touchmove`, so no extra
 *    device check is needed to keep this off desktop mice.
 *  - Trackpad pinch (macOS, in Chrome/Firefox/Safari): the browser reports a
 *    trackpad pinch gesture as a `wheel` event with `ctrlKey` set — this is
 *    also indistinguishable from an actual physical Ctrl+scroll, which is
 *    fine here since both conventionally mean "zoom". We `preventDefault()`
 *    it so the browser's own page-zoom doesn't fire instead.
 *
 * Returns a cleanup function that removes all listeners.
 */

const WHEEL_ZOOM_FACTOR = 0.01;
const TOUCH_ZOOM_FACTOR = 0.004;

function touchDistance(a: Touch, b: Touch): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

export function attachPinchZoom(el: HTMLElement, onDelta: (delta: number) => void): () => void {
  // Closure-local, not component state: a pinch is a fast, continuous
  // gesture and re-rendering the owning component on every step (as `onDelta`
  // typically does, via a zustand `set()`) must not reset this tracking.
  let lastTouchDistance: number | null = null;

  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    onDelta(-e.deltaY * WHEEL_ZOOM_FACTOR);
  };

  const onTouchStart = (e: TouchEvent) => {
    const [a, b] = e.touches;
    lastTouchDistance = e.touches.length === 2 && a && b ? touchDistance(a, b) : null;
  };

  const onTouchMove = (e: TouchEvent) => {
    const [a, b] = e.touches;
    if (e.touches.length !== 2 || !a || !b) {
      lastTouchDistance = null;
      return;
    }
    const distance = touchDistance(a, b);
    if (lastTouchDistance != null) {
      // Stop the OS/browser's own pinch-zoom-the-page gesture from also firing.
      e.preventDefault();
      onDelta((distance - lastTouchDistance) * TOUCH_ZOOM_FACTOR);
    }
    lastTouchDistance = distance;
  };

  const onTouchEnd = (e: TouchEvent) => {
    if (e.touches.length < 2) lastTouchDistance = null;
  };

  // `passive: false` is required on the events we call preventDefault() in —
  // React's synthetic onWheel/onTouchMove props are attached passively and
  // silently no-op preventDefault(), which is why this is wired with native
  // addEventListener instead of JSX handlers.
  el.addEventListener("wheel", onWheel, { passive: false });
  el.addEventListener("touchstart", onTouchStart, { passive: true });
  el.addEventListener("touchmove", onTouchMove, { passive: false });
  el.addEventListener("touchend", onTouchEnd, { passive: true });
  el.addEventListener("touchcancel", onTouchEnd, { passive: true });

  return () => {
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("touchstart", onTouchStart);
    el.removeEventListener("touchmove", onTouchMove);
    el.removeEventListener("touchend", onTouchEnd);
    el.removeEventListener("touchcancel", onTouchEnd);
  };
}
