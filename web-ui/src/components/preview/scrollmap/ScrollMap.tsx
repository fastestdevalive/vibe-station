import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GutterMarkKind } from "@/components/preview/CodeView";
import type { DiffHunk } from "@/preview/diffParser";
import { useFileScrollMap } from "@/hooks/useFileScrollMap";
import { useIsMobile } from "@/hooks/useIsMobile";
import { buildMarks, buildDiffMarks } from "./buildMarks";
import { visibleLineRange, type LineRange } from "./codeLines";
import { Minimap } from "./Minimap";
import { TrackMarks } from "./TrackMarks";
import { effectiveScrollMapMode, type EffectiveScrollMap } from "./effectiveScrollMapMode";

interface ScrollMapProps {
  scrollEl: HTMLElement | null;
  mode: "code" | "diff";
  code?: string;
  lineCount: number;
  gutter?: Map<number, ReadonlySet<GutterMarkKind>> | null;
  commentLines?: Array<[number, number]>;
  targetLine?: number | null;
  diffHunks?: DiffHunk[];
  /**
   * Scrolls so `line` (1-based code line, or diff row index) is the first visible row.
   * Centring is the caller's job (`centeredTopLine`).
   */
  onJump?: (line: number) => void;
  onDisplayChange?: (display: EffectiveScrollMap) => void;
}

/**
 * The scroller's border-box width. Unlike `clientWidth` it does not change with the mode it
 * decides (marks hide the scrollbar, the minimap shows it), so a pane near the threshold
 * cannot flip between the two on every resize tick.
 */
function paneWidthOf(el: HTMLElement): number {
  return el.getBoundingClientRect().width;
}

export function ScrollMap({
  scrollEl,
  mode,
  code = "",
  lineCount,
  gutter,
  commentLines,
  targetLine,
  diffHunks,
  onJump,
  onDisplayChange,
}: ScrollMapProps) {
  const [fileScrollMap] = useFileScrollMap();
  const isMobile = useIsMobile();

  const [paneWidth, setPaneWidth] = useState<number>(() => (scrollEl ? paneWidthOf(scrollEl) : 0));
  const [fits, setFits] = useState<boolean>(() => {
    if (!scrollEl) return false;
    return scrollEl.scrollHeight <= scrollEl.clientHeight;
  });

  const [visibleRange, setVisibleRange] = useState<LineRange | null>(null);
  const [optimisticRange, setOptimisticRangeState] = useState<LineRange | null>(null);
  const optimisticRangeRef = useRef<LineRange | null>(null);
  const visibleRangeRef = useRef<LineRange | null>(null);
  const isJumpingRef = useRef(false);
  const isDraggingRef = useRef(false);
  const optimisticTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jumpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setOptimisticRange = useCallback((range: LineRange | null) => {
    optimisticRangeRef.current = range;
    setOptimisticRangeState(range);
  }, []);

  const clearOptimisticTimeout = useCallback(() => {
    if (optimisticTimerRef.current != null) {
      clearTimeout(optimisticTimerRef.current);
      optimisticTimerRef.current = null;
    }
  }, []);

  const clearJumpTimeout = useCallback(() => {
    if (jumpTimerRef.current != null) {
      clearTimeout(jumpTimerRef.current);
      jumpTimerRef.current = null;
    }
  }, []);

  const resetRanges = useCallback(() => {
    visibleRangeRef.current = null;
    setVisibleRange(null);
    clearOptimisticTimeout();
    setOptimisticRange(null);
  }, [clearOptimisticTimeout, setOptimisticRange]);

  const byteLength = useMemo(() => (code ? new Blob([code]).size : 0), [code]);

  const marks = useMemo(() => {
    if (mode === "diff" && diffHunks) {
      return buildDiffMarks(diffHunks);
    }
    return buildMarks({ gutter, commentLines, targetLine, lineCount });
  }, [mode, diffHunks, gutter, commentLines, targetLine, lineCount]);

  const showTargetRange = useCallback(
    (range: LineRange) => {
      setOptimisticRange(range);
      clearOptimisticTimeout();
      optimisticTimerRef.current = setTimeout(() => {
        setOptimisticRange(null);
      }, 1500);
    },
    [setOptimisticRange, clearOptimisticTimeout],
  );

  const handleJump = useCallback(
    (line: number) => {
      const current = optimisticRangeRef.current ?? visibleRangeRef.current;
      const vl = current ? current.last - current.first + 1 : 0;
      const last = Math.min(lineCount, line + Math.max(0, vl - 1));
      showTargetRange({ first: line, last });

      isJumpingRef.current = true;
      clearJumpTimeout();
      jumpTimerRef.current = setTimeout(() => {
        if (!isDraggingRef.current) {
          isJumpingRef.current = false;
        }
      }, 200);

      onJump?.(line);
    },
    [lineCount, showTargetRange, clearJumpTimeout, onJump],
  );

  const handleDragStart = useCallback(() => {
    isDraggingRef.current = true;
    isJumpingRef.current = true;
  }, []);

  const handleDragEnd = useCallback(() => {
    isDraggingRef.current = false;
    clearJumpTimeout();
    jumpTimerRef.current = setTimeout(() => {
      isJumpingRef.current = false;
    }, 200);
  }, [clearJumpTimeout]);

  useEffect(() => {
    return () => {
      clearOptimisticTimeout();
      clearJumpTimeout();
    };
  }, [clearOptimisticTimeout, clearJumpTimeout]);

  // Measure fits, paneWidth & visible line range
  const updateMetrics = useCallback(() => {
    if (!scrollEl) {
      setFits(false);
      setPaneWidth(0);
      resetRanges();
      return;
    }
    setPaneWidth(paneWidthOf(scrollEl));
    if (lineCount === 0) {
      setFits(true);
      resetRanges();
      return;
    }
    const contentFits = scrollEl.scrollHeight <= scrollEl.clientHeight;
    setFits(contentFits);
    if (!contentFits) {
      const range = visibleLineRange(scrollEl, mode);
      if (range) {
        visibleRangeRef.current = range;
        setVisibleRange((prev) => {
          if (prev && prev.first === range.first && prev.last === range.last) {
            return prev;
          }
          return range;
        });
        if (optimisticRangeRef.current) {
          if (Math.abs(range.first - optimisticRangeRef.current.first) <= 3) {
            clearOptimisticTimeout();
            setOptimisticRange(null);
          }
        }
      }
    } else {
      resetRanges();
    }
  }, [scrollEl, mode, lineCount, resetRanges, clearOptimisticTimeout, setOptimisticRange]);

  // A swapped scroller starts with no range: its rows may not be mounted yet, and
  // the old scroller's range must not stand in for it until they are measured.
  useEffect(() => {
    resetRanges();
  }, [scrollEl, resetRanges]);

  useEffect(() => {
    updateMetrics();
    if (!scrollEl) return;

    // `visibleLineRange` queries the rendered rows, so measure at most once per frame.
    let frame: number | null = null;
    const scheduleMeasure = () => {
      if (frame != null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        updateMetrics();
      });
    };

    const handleScroll = () => {
      if (!isJumpingRef.current && !isDraggingRef.current && optimisticRangeRef.current != null) {
        clearOptimisticTimeout();
        setOptimisticRange(null);
      }
      scheduleMeasure();
    };

    scrollEl.addEventListener("scroll", handleScroll, { passive: true });
    const observer = new ResizeObserver(updateMetrics);
    observer.observe(scrollEl);
    const rows = new MutationObserver(scheduleMeasure);
    rows.observe(scrollEl, { childList: true, subtree: true });

    return () => {
      scrollEl.removeEventListener("scroll", handleScroll);
      if (frame != null) cancelAnimationFrame(frame);
      observer.disconnect();
      rows.disconnect();
    };
  }, [scrollEl, updateMetrics, lineCount, clearOptimisticTimeout, setOptimisticRange]);

  // The minimap needs its summary worker; without one (or once it fails for
  // this file's content) the file gets marks instead. A new file retries it.
  const [minimapFailedFor, setMinimapFailedFor] = useState<string | null>(null);
  const markMinimapUnavailable = useCallback(() => setMinimapFailedFor(code), [code]);
  const minimapUnavailable = typeof Worker === "undefined" || minimapFailedFor === code;

  const scrollable = Boolean(scrollEl && !fits && lineCount > 0);
  const effective = effectiveScrollMapMode(fileScrollMap, {
    view: mode,
    scrollable,
    isPhone: isMobile,
    paneWidth,
    lineCount,
    byteLength,
    minimapAvailable: !minimapUnavailable,
  });

  const active = effective.display !== "none";
  const useMinimap = effective.display === "minimap";

  // Notify parent of effective display mode changes
  useEffect(() => {
    onDisplayChange?.(effective);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onDisplayChange, effective.display, effective.forced]);

  const renderedRange = optimisticRange ?? visibleRange;

  // Sync scrollbar class onto scrollEl
  useEffect(() => {
    if (!scrollEl) return;
    if (!active) {
      scrollEl.classList.remove("preview-body--tracked", "preview-body--minimap");
      return;
    }

    if (useMinimap) {
      scrollEl.classList.add("preview-body--minimap");
      scrollEl.classList.remove("preview-body--tracked");
    } else if (!isMobile && renderedRange !== null) {
      scrollEl.classList.add("preview-body--tracked");
      scrollEl.classList.remove("preview-body--minimap");
    } else {
      scrollEl.classList.remove("preview-body--tracked", "preview-body--minimap");
    }

    return () => {
      scrollEl.classList.remove("preview-body--tracked", "preview-body--minimap");
    };
  }, [scrollEl, active, useMinimap, isMobile, renderedRange]);

  if (!active) {
    return null;
  }

  if (useMinimap) {
    return (
      <Minimap
        code={code}
        lineCount={lineCount}
        marks={marks}
        visibleRange={renderedRange}
        onJump={handleJump}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onUnavailable={markMinimapUnavailable}
      />
    );
  }

  return (
    <TrackMarks
      lineCount={lineCount}
      marks={marks}
      visibleRange={renderedRange}
      code={mode === "diff" ? undefined : code}
      onJump={handleJump}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      readOnly={isMobile}
    />
  );
}
