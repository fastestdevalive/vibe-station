import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  useVirtualizer,
  defaultRangeExtractor,
  measureElement as defaultMeasureElement,
  type Virtualizer,
} from "@tanstack/react-virtual";

/** Fallback line height when the measure span hasn't resolved yet. */
export const DEFAULT_LH = 20;
/** Fallback monospace character width when the measure span hasn't resolved. */
export const DEFAULT_CHW = 8;
/** Horizontal padding on each side of a code line, in px (see `.workspace-code-line`). */
const LINE_X_PADDING = 32; // 16px each side

/**
 * Expand `line`'s tab characters (`\t`) per `tabSize` so a wrapped line's
 * visual column count can be estimated. A tab advances to the next multiple of
 * `tabSize` columns. Purely functional and exported for unit tests.
 */
export function visualCols(line: string, tabSize: number): number {
  if (!line) return 0;
  let cols = 0;
  for (const ch of line) {
    if (ch === "\t") {
      cols += tabSize - (cols % tabSize);
    } else {
      cols += 1;
    }
  }
  return cols;
}

/**
 * Estimated rendered height (px) of a single wrapped source line: how many
 * rows it wraps to (ceil of visual columns / columns-per-row), times the line
 * height. Always at least one row. Exported for unit tests.
 */
export function estimateRowHeight(
  line: string,
  colsPerRow: number,
  lh: number,
  tabSize: number,
): number {
  const safeLh = Number.isFinite(lh) && lh > 0 ? lh : DEFAULT_LH;
  const safeCols = colsPerRow > 0 ? colsPerRow : 1;
  const rows = Math.max(1, Math.ceil(visualCols(line, tabSize) / safeCols));
  return rows * safeLh;
}

export interface UseCodeVirtualizerOptions {
  lines: string[];
  scrollEl: HTMLElement | null;
  enabled: boolean;
  /** 1-based target line to force into the rendered range (jump-to-line). */
  highlightLine: number | null;
  tabSize: number;
}

export interface UseCodeVirtualizerResult {
  virtualizer: Virtualizer<HTMLElement, Element>;
  scrollMargin: number;
  lh: number;
  /** Attach to the sizer div so `scrollMargin` can be measured. */
  sizerRef: RefObject<HTMLDivElement | null>;
  /** Attach to the hidden one-line measure span (observes LH + char width). */
  measureRef: RefObject<HTMLSpanElement | null>;
}

/**
 * Virtual-scroll wrapper for the code viewer (Decisions 7–9). Owns:
 * - a hidden one-line measure `<span>` (via `measureRef`) whose `ResizeObserver`
 *   yields the effective line-height `LH` and monospace character width `chW`,
 *   surviving font-scale changes that a viewport observer would miss;
 * - the `colsPerRow` / per-line height estimates that keep the scrollbar sane
 *   before rows are measured (`measureElement` corrects each mounted row);
 * - `scrollMargin` (distance from the scroller top to the sizer top);
 * - a `rangeExtractor` that unions the default visible range with the
 *   jump-to-line target so the target row is in the DOM in the same commit;
 * - scroll-position preservation across an `LH`/`chW`/width change.
 */
export function useCodeVirtualizer({
  lines,
  scrollEl,
  enabled,
  highlightLine,
  tabSize,
}: UseCodeVirtualizerOptions): UseCodeVirtualizerResult {
  const measureRef = useRef<HTMLSpanElement | null>(null);
  const [lh, setLh] = useState(DEFAULT_LH);
  const [chW, setChW] = useState(DEFAULT_CHW);
  const [contentWidth, setContentWidth] = useState(0);

  // Measure the one-line span (line-height + char width + content width). The
  // span carries a single `0` glyph and the same font as the code viewer.
  useLayoutEffect(() => {
    const el = measureRef.current;
    if (!enabled || !el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);
      const lhVal = parseFloat(cs.lineHeight);
      setLh(Number.isFinite(lhVal) && lhVal > 0 ? lhVal : rect.height > 0 ? rect.height : DEFAULT_LH);
      const w = rect.width;
      setChW(Number.isFinite(w) && w > 0 ? w : DEFAULT_CHW);
      // Content width of the scroller, if any.
      if (scrollEl) setContentWidth(scrollEl.clientWidth);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (scrollEl) ro.observe(scrollEl);
    return () => ro.disconnect();
  }, [scrollEl, enabled]);

  const lhValue = Number.isFinite(lh) && lh > 0 ? lh : DEFAULT_LH;
  const chWValue = Number.isFinite(chW) && chW > 0 ? chW : DEFAULT_CHW;
  // Before the first measured update lands, read the scroller's width straight
  // from the DOM so a scroll restore on the very first pass already estimates
  // wrapped rows with the real column count (not "no wrap").
  const liveWidth = enabled && scrollEl ? scrollEl.clientWidth : 0;
  const contentW = Number.isFinite(contentWidth) && contentWidth > 0 ? contentWidth : liveWidth;

  // Gutter width: digits of the last line number × char width + the gutter's
  // right padding (16px) + line padding (32px). Never negative.
  const gutterDigits = Math.max(1, String(lines.length).length);
  const gutterWidth = gutterDigits * chWValue + 16;
  // Unknown width (before the first measure) means "no wrap", not 1 col/row.
  const colsPerRow =
    contentW > 0
      ? Math.max(1, Math.floor((contentW - gutterWidth - LINE_X_PADDING) / chWValue))
      : Number.POSITIVE_INFINITY;

  // scrollMargin: distance from the scroller's content top to the sizer top.
  const [scrollMargin, setScrollMargin] = useState(0);
  const sizerRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!enabled || !scrollEl || !sizerRef.current) return;
    const sizer = sizerRef.current;
    setScrollMargin(sizer.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop);
  }, [enabled, scrollEl, lines.length]);

  const virtualizer = useVirtualizer({
    count: lines.length,
    enabled,
    getScrollElement: () => scrollEl,
    estimateSize: (i) => estimateRowHeight(lines[i] ?? "", colsPerRow, lhValue, tabSize),
    overscan: 20,
    // A 0px measurement means "not laid out" (display:none pane, no layout in
    // jsdom), never a real 0-height line. Trusting it would collapse the total
    // size and mount ever more rows each commit — fall back to the estimate.
    measureElement: (el, entry, instance) => {
      const size = defaultMeasureElement(el, entry, instance);
      return size > 0 ? size : instance.options.estimateSize(instance.indexFromElement(el));
    },
    scrollMargin,
    useFlushSync: false,
    rangeExtractor: (range) => {
      const idxs = defaultRangeExtractor(range);
      const set = new Set(idxs);
      if (highlightLine != null && highlightLine >= 1 && highlightLine <= lines.length) {
        set.add(highlightLine - 1);
      }
      return Array.from(set).sort((a, b) => a - b);
    },
  });

  // Preserve the viewport when LH/chW/contentWidth changes (font bump, resize).
  // The anchor (first row ending below the scroll offset + the offset into it)
  // is captured continuously from the OLD layout — by the time this effect
  // sees new metrics the virtualizer's cache is already a mix of old measured
  // sizes and new estimates, so reading the anchor here would be wrong.
  const anchorRef = useRef<{ index: number; offset: number } | null>(null);
  const captureAnchor = () => {
    if (!enabled || !scrollEl) return;
    const top = scrollEl.scrollTop;
    const first = virtualizer.getVirtualItems().find((it) => it.end > top);
    if (first) anchorRef.current = { index: first.index, offset: top - first.start };
  };
  const captureAnchorRef = useRef(captureAnchor);
  captureAnchorRef.current = captureAnchor;
  useEffect(() => {
    if (!enabled || !scrollEl) return;
    const onScroll = () => captureAnchorRef.current();
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollEl.removeEventListener("scroll", onScroll);
  }, [enabled, scrollEl]);

  const pendingAnchorRef = useRef<{ index: number; offset: number; passes: number } | null>(null);
  const applyPendingAnchor = () => {
    const pending = pendingAnchorRef.current;
    if (!pending || !scrollEl) return;
    virtualizer.getTotalSize();
    const [start] = virtualizer.getOffsetForIndex(pending.index, "start") ?? [scrollEl.scrollTop];
    scrollEl.scrollTop = start + pending.offset;
    if (--pending.passes <= 0) {
      pendingAnchorRef.current = null;
      captureAnchor();
    }
  };

  const prevMetricsRef = useRef({ lh: lhValue, chW: chWValue, width: contentW });
  useLayoutEffect(() => {
    const prev = prevMetricsRef.current;
    const changed =
      prev.lh !== lhValue || prev.chW !== chWValue || prev.width !== contentW;
    prevMetricsRef.current = { lh: lhValue, chW: chWValue, width: contentW };
    if (!enabled || !scrollEl) return;
    if (!changed) {
      captureAnchor();
      return;
    }
    const anchor = anchorRef.current;
    if (!anchor) return;
    virtualizer.measure();
    // getOffsetForIndex reads the cached measurements without recomputing;
    // getTotalSize() forces the post-measure() recompute (NEW layout).
    virtualizer.getTotalSize();
    // The sizer's DOM height still reflects the OLD total in this commit, so a
    // far scrollTop assignment would be clamped. Keep the anchor pending and
    // re-apply on the next commits (after the sizer has its new height).
    pendingAnchorRef.current = {
      index: anchor.index,
      offset: anchor.offset * (lhValue / prev.lh),
      passes: 3,
    };
    applyPendingAnchor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lhValue, chWValue, contentW, enabled, scrollEl, virtualizer]);

  // Runs after every commit: finish a pending post-metrics anchor restore once
  // the sizer height has caught up with the new layout.
  useLayoutEffect(() => {
    if (pendingAnchorRef.current) applyPendingAnchor();
  });

  return { virtualizer, scrollMargin, lh: lhValue, sizerRef, measureRef };
}
