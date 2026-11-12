import { useEffect, useRef } from "react";

/** Pixels of wheel travel that move the scrub one row. */
export const WHEEL_PX_PER_ROW = 28;
/** Pixels per line for `deltaMode === 1` (Firefox's line-based wheel). */
export const WHEEL_LINE_PX = 33;
/** Pixels per page for `deltaMode === 2`. */
export const WHEEL_PAGE_PX = 800;
/**
 * A rail wheel this soon after a chat wheel, after the wheel list closed, or after
 * another such ignored wheel is momentum carry-over, not a scrub.
 */
export const WHEEL_CHAT_GUARD_MS = 150;

/**
 * Rows a wheel event moves: signed and fractional (a mouse notch is ~3.5 rows,
 * a trackpad pixel delta is ~1:1 with a row). `null` when the event must not be
 * hijacked: ctrl/meta is a pinch-zoom, and a horizontal gesture (incl. Shift+wheel)
 * is not a scrub. Pure: the caller owns the accumulated position.
 */
export function wheelRows(e: WheelEvent, rowCount: number): number | null {
  if (e.ctrlKey || e.metaKey) return null;
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return null;
  const px = e.deltaY * (e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? WHEEL_PAGE_PX : 1);
  // Long chats get a gain so a wheel still crosses a useful share of the list.
  const gain = Math.min(6, Math.max(1, rowCount / 400));
  return (px / WHEEL_PX_PER_ROW) * gain;
}

/** Clamp a float row position to the loaded rows. */
export function clampRow(pos: number, rowCount: number): number {
  return Math.min(rowCount - 1, Math.max(0, pos));
}

export interface UseRailWheelOpts {
  /**
   * The rail's hit strip. Comes from a callback-ref state, not a ref read in an
   * effect: the chain renders nothing until it has something worth mapping, so
   * on the first effect pass the ref can still be null and never attach.
   */
  el: HTMLElement | null;
  /** The chat scroller; a wheel there just before a rail wheel is momentum. */
  scrollElement?: HTMLElement | null;
  /** Flat row count (`chainRows` of the filtered nodes). */
  rowCount: number;
  /** True while the list is open in wheel mode; leaving it ends the scrub. */
  active: boolean;
  /** True while another gesture owns the rail (a held press): wheels are swallowed, never scrubbed. */
  blocked?: () => boolean;
  /** Flat row the scrub starts from (the turn in view). */
  getStartRow: () => number;
  /** Called with the flat row under the scrub, once per frame while wheeling. */
  onScrubRow: (row: number) => void;
}

/**
 * Wheel-scrub on the turn rail: a wheel over the hit strip is preventDefault'ed
 * (the chat must not scroll) and moves a float row position that the caller
 * turns into the highlighted row. The first wheel applies its own delta at once
 * so the list opens on the right row; later deltas are summed per animation
 * frame. Deltas past either end are swallowed, never passed to the chat.
 *
 * The listener is attached natively with `passive: false` (React's `onWheel` is
 * passive and silently no-ops preventDefault), the same pattern as
 * `lib/pinchZoom.ts`.
 */
export function useRailWheel({
  el,
  scrollElement,
  rowCount,
  active,
  blocked,
  getStartRow,
  onScrubRow,
}: UseRailWheelOpts): void {
  // The listener must see the current props without being re-attached each render.
  const latest = useRef({ rowCount, blocked, getStartRow, onScrubRow });
  useEffect(() => {
    latest.current = { rowCount, blocked, getStartRow, onScrubRow };
  });

  const posRef = useRef(0); // float row position
  const pendingRef = useRef(0); // rows accumulated since the last frame
  const rafRef = useRef<number | null>(null);
  const runRef = useRef(false); // a wheel scrub is in progress
  /** Time of the last wheel that marks rail wheels as momentum for WHEEL_CHAT_GUARD_MS. */
  const guardAtRef = useRef(-Infinity);
  const wasActiveRef = useRef(active);

  // Leaving wheel mode ends the scrub: the next wheel starts from the turn in view again,
  // and the momentum of the closed scrub (e.g. a wheel still coasting after Esc) cannot reopen it.
  useEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = active;
    if (active) return;
    if (wasActive) guardAtRef.current = Date.now();
    runRef.current = false;
    posRef.current = 0;
    pendingRef.current = 0;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, [active]);

  // The position is a flat index: rows added or removed mid-scrub (earlier turns loaded
  // after a jump near the top) shift it, so it re-anchors on the marked row. An append at
  // the end leaves the marked row in place and keeps the fractional position; pending
  // deltas are relative and always kept.
  const rowCountRef = useRef(rowCount);
  useEffect(() => {
    if (rowCountRef.current === rowCount) return;
    rowCountRef.current = rowCount;
    if (!runRef.current || rowCount <= 0) return;
    const start = latest.current.getStartRow();
    if (start !== Math.round(posRef.current)) posRef.current = clampRow(start, rowCount);
  }, [rowCount]);

  // Timestamp chat wheels so momentum carry-over onto the rail does not pop the list.
  useEffect(() => {
    if (!scrollElement) return;
    const onChatWheel = () => {
      guardAtRef.current = Date.now();
    };
    scrollElement.addEventListener("wheel", onChatWheel, { passive: true });
    return () => scrollElement.removeEventListener("wheel", onChatWheel);
  }, [scrollElement]);

  useEffect(() => {
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const now = Date.now();
      if (now - guardAtRef.current < WHEEL_CHAT_GUARD_MS) {
        // Momentum keeps arriving while it coasts: each one extends the guard.
        guardAtRef.current = now;
        return;
      }
      const { rowCount: rows, blocked: isBlocked, getStartRow: start, onScrubRow: scrub } = latest.current;
      if (isBlocked?.()) {
        e.preventDefault();
        return;
      }
      if (rows <= 0) return;
      const delta = wheelRows(e, rows);
      if (delta == null) return; // pinch-zoom or a horizontal gesture: leave it to the page
      e.preventDefault();
      if (!runRef.current) {
        runRef.current = true;
        posRef.current = clampRow(start() + delta, rows);
        scrub(Math.round(posRef.current));
        return;
      }
      pendingRef.current += delta;
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const cur = latest.current;
        if (cur.rowCount <= 0) return;
        posRef.current = clampRow(posRef.current + pendingRef.current, cur.rowCount);
        pendingRef.current = 0;
        cur.onScrubRow(Math.round(posRef.current));
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [el]);

  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );
}
