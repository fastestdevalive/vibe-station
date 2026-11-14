/** How long a centred jump keeps re-centring while its row still changes height or position. */
export const JUMP_SETTLE_MS = 1000;
/** Gap kept above a row too tall to centre, so its first line is not flush with the edge. */
export const JUMP_TOP_GAP = 8;
/** The user's own scroll input: the first one ends the settle, a jump never fights it. */
const USER_SCROLL_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

export interface CenterInput {
  /** The row's top in scroll-content coordinates. */
  rowTop: number;
  rowHeight: number;
  /** The scroller's visible height. */
  viewport: number;
  scrollHeight: number;
  /** Height an overlay covers at the top of the viewport (the row's `scroll-margin-top`). */
  topInset?: number;
}

/**
 * The scrollTop that puts a row in the vertical middle of the visible viewport
 * (the chat's version of the scroll map's `centeredTopLine`). A row that does
 * not fit is top-aligned instead, so its start stays visible, and the result is
 * clamped to the scrollable range (no overscroll near either end, 0 for a list
 * shorter than the viewport).
 */
export function centeredScrollTop({ rowTop, rowHeight, viewport, scrollHeight, topInset = 0 }: CenterInput): number {
  const visible = Math.max(0, viewport - topInset);
  const fits = rowHeight + JUMP_TOP_GAP * 2 <= visible;
  const lead = fits ? (visible - rowHeight) / 2 : JUMP_TOP_GAP;
  const maxTop = Math.max(0, scrollHeight - viewport);
  return Math.min(maxTop, Math.max(0, Math.round(rowTop - topInset - lead)));
}

function measure(scroller: HTMLElement, row: HTMLElement): CenterInput {
  const rect = row.getBoundingClientRect();
  return {
    rowTop: rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop,
    rowHeight: rect.height,
    viewport: scroller.clientHeight,
    scrollHeight: scroller.scrollHeight,
    topInset: parseFloat(getComputedStyle(row).scrollMarginTop) || 0,
  };
}

/**
 * Centres `row()` in `scroller` now and keeps it centred for JUMP_SETTLE_MS
 * while the row mounts, expands or is re-measured (virtualised rows, markdown,
 * images). Ends at the user's first scroll input. Returns the cancel function.
 */
export function keepRowCentered(
  scroller: HTMLElement,
  row: () => HTMLElement | null,
  setTop: (top: number) => void,
): () => void {
  let frame = 0;
  let done = false;
  const stop = () => {
    done = true;
    cancelAnimationFrame(frame);
    for (const ev of USER_SCROLL_EVENTS) scroller.removeEventListener(ev, stop);
  };
  const deadline = performance.now() + JUMP_SETTLE_MS;
  const tick = () => {
    if (done) return;
    const el = row();
    if (el) {
      const top = centeredScrollTop(measure(scroller, el));
      if (Math.abs(top - scroller.scrollTop) > 1) setTop(top);
    }
    if (performance.now() < deadline) frame = requestAnimationFrame(tick);
    else stop();
  };
  for (const ev of USER_SCROLL_EVENTS) scroller.addEventListener(ev, stop, { passive: true });
  tick();
  return stop;
}
