const MARGIN = 8;

/**
 * Scroll `scroller` by the minimum needed to show `el`, and not at all when `el` already fits in its visible
 * box (`block: "nearest"` semantics, but only ever on `scroller`: `scrollIntoView` also scrolls every
 * `overflow: hidden` ancestor and the window, which moved the panes around the preview). A box taller than the
 * visible area is aligned to its top, so its start (the editor) stays reachable. Returns the applied delta.
 */
export function revealInScroller(el: HTMLElement, scroller: HTMLElement, margin = MARGIN): number {
  const r = el.getBoundingClientRect();
  if (r.height === 0) return 0;
  const s = scroller.getBoundingClientRect();
  const visTop = s.top + scroller.clientTop;
  const visBottom = visTop + scroller.clientHeight;
  let delta = 0;
  if (r.top < visTop) delta = r.top - visTop - margin;
  else if (r.bottom > visBottom) delta = Math.min(r.bottom - visBottom + margin, Math.max(0, r.top - visTop - margin));
  if (delta !== 0) scroller.scrollTop += delta;
  return delta;
}
