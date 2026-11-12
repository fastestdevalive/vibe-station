import { useCallback, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { Mark, MarkKind, PixelMark } from "./buildMarks";
import { layoutMarks } from "./buildMarks";
import { lineAtFraction, type LineRange } from "./codeLines";
import { useTrackDrag } from "./useTrackDrag";
import { useTrackHeight } from "./useTrackHeight";

interface TrackMarksProps {
  lineCount: number;
  marks: Mark[];
  visibleRange: LineRange | null;
  code?: string;
  onJump?: (line: number) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  readOnly?: boolean;
}

interface HoverCardData {
  top: number;
  kindLabel: string;
  meta: string;
  codeSnippet?: string;
  foot: string;
}

function colorForKind(kind: MarkKind): string {
  switch (kind) {
    case "comment":
      return "var(--ruler-comment)";
    case "deleted":
      return "var(--ruler-deleted)";
    case "modified":
      return "var(--ruler-modified)";
    case "added":
      return "var(--ruler-added)";
    case "target":
      return "var(--ruler-search)";
  }
}

function labelForSingleKind(kind: MarkKind): string {
  switch (kind) {
    case "added":
      return "Added";
    case "modified":
      return "Modified";
    case "deleted":
      return "Deleted";
    case "comment":
      return "Comment";
    case "target":
      return "Opened line";
  }
}

function getLineAt(text: string | undefined, lineNum: number): string | undefined {
  if (!text || lineNum < 1) return undefined;
  let start = 0;
  for (let l = 1; l < lineNum; l++) {
    const nextNewline = text.indexOf("\n", start);
    if (nextNewline === -1) return undefined;
    start = nextNewline + 1;
  }
  const end = text.indexOf("\n", start);
  const rawLine = end === -1 ? text.slice(start) : text.slice(start, end);
  return rawLine.replace(/\r$/, "");
}

export function TrackMarks({
  lineCount,
  marks,
  visibleRange,
  code,
  onJump,
  onDragStart,
  onDragEnd,
  readOnly = false,
}: TrackMarksProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverCard, setHoverCard] = useState<HoverCardData | null>(null);
  const effectiveTrackHeight = useTrackHeight(containerRef);

  const pixelMarks = useMemo<PixelMark[]>(() => {
    return lineCount > 0 && effectiveTrackHeight > 0
      ? layoutMarks(marks, lineCount, effectiveTrackHeight)
      : [];
  }, [marks, lineCount, effectiveTrackHeight]);

  let thumbTop = 0;
  let thumbHeight = 0;
  if (visibleRange && lineCount > 0 && effectiveTrackHeight > 0) {
    thumbTop = Math.max(0, ((visibleRange.first - 1) / lineCount) * effectiveTrackHeight);
    const rawH = ((visibleRange.last - visibleRange.first + 1) / lineCount) * effectiveTrackHeight;
    thumbHeight = Math.max(16, rawH);
    if (thumbTop + thumbHeight > effectiveTrackHeight) {
      thumbTop = Math.max(0, effectiveTrackHeight - thumbHeight);
    }
  }

  const getMarkAtY = useCallback(
    (y: number): PixelMark | null => {
      for (const pm of pixelMarks) {
        if (y >= pm.topPx && y <= pm.topPx + pm.heightPx) {
          return pm;
        }
      }
      return null;
    },
    [pixelMarks],
  );

  const visibleLines = visibleRange ? visibleRange.last - visibleRange.first + 1 : 0;

  const resolve = useCallback(
    (y: number): number | undefined => {
      const el = containerRef.current;
      const h =
        effectiveTrackHeight > 0
          ? effectiveTrackHeight
          : el
            ? el.clientHeight || el.getBoundingClientRect().height
            : 0;
      if (h <= 0) return undefined;
      const candidate = lineAtFraction(y / h, lineCount);
      const pm = getMarkAtY(y);
      const inside = pm?.all.some((m) => candidate >= m.startLine && candidate <= m.endLine);
      if (pm && !inside) {
        return pm.all[0]!.startLine;
      }
      return undefined;
    },
    [effectiveTrackHeight, lineCount, getMarkAtY],
  );

  const clearHoverCard = useCallback(() => setHoverCard(null), []);
  const handleDragStart = useCallback(() => {
    clearHoverCard();
    onDragStart?.();
  }, [clearHoverCard, onDragStart]);

  const { handlers, isDraggingRef } = useTrackDrag({
    trackRef: containerRef,
    trackHeight: effectiveTrackHeight,
    lineCount,
    thumbTop,
    thumbHeight,
    visibleLines,
    onJump,
    enabled: !readOnly,
    onDragStart: handleDragStart,
    onDragEnd,
    pressLine: resolve,
  });

  const handleMouseMove = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (readOnly || isDraggingRef.current) {
        setHoverCard(null);
        return;
      }
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const y = e.clientY - rect.top;

      const pm = getMarkAtY(y);
      if (pm && pm.all.length > 0) {
        const firstMark = pm.all[0];
        if (!firstMark) return;

        const counts: Partial<Record<MarkKind, number>> = {};
        for (const m of pm.all) {
          counts[m.kind] = (counts[m.kind] ?? 0) + 1;
        }
        const distinctKinds = Object.keys(counts) as MarkKind[];

        if (distinctKinds.length > 1) {
          const parts: string[] = [];
          if (counts.modified) parts.push(`${counts.modified} modified`);
          if (counts.added) parts.push(`${counts.added} added`);
          if (counts.deleted) parts.push(`${counts.deleted} deleted`);
          if (counts.comment) parts.push(`${counts.comment} comment`);
          if (counts.target) parts.push(`${counts.target} opened`);

          setHoverCard({
            top: pm.topPx,
            kindLabel: "Merged",
            meta: `${parts.join(" · ")} ranges`,
            codeSnippet: getLineAt(code, firstMark.startLine),
            foot: "Click: first of them",
          });
        } else {
          const m = firstMark;
          const lines = m.endLine - m.startLine + 1;
          const rangeStr =
            m.startLine === m.endLine
              ? `· L${m.startLine} (1 line)`
              : `· L${m.startLine}–${m.endLine} (${lines} lines)`;

          setHoverCard({
            top: pm.topPx,
            kindLabel: labelForSingleKind(m.kind),
            meta: rangeStr,
            codeSnippet: getLineAt(code, m.startLine),
            foot: "Click to jump",
          });
        }
        return;
      }

      // Check if over thumb
      if (thumbHeight > 0 && y >= thumbTop && y <= thumbTop + thumbHeight && visibleRange) {
        const lines = visibleRange.last - visibleRange.first + 1;
        setHoverCard({
          top: thumbTop,
          kindLabel: "Viewport",
          meta: `· L${visibleRange.first}–${visibleRange.last} (${lines} lines)`,
          foot: "Drag the thumb to scroll",
        });
        return;
      }

      setHoverCard(null);
    },
    [readOnly, getMarkAtY, code, thumbHeight, thumbTop, visibleRange, isDraggingRef],
  );

  const handleMouseLeave = useCallback(() => {
    if (!isDraggingRef.current) {
      setHoverCard(null);
    }
  }, [isDraggingRef]);

  return (
    <div
      ref={containerRef}
      className="scrollmap-track-container"
      aria-hidden="true"
      data-readonly={readOnly ? "true" : undefined}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      {...handlers}
    >
      <div className="scrollmap-track">
        {pixelMarks.map((pm, idx) => (
          <div
            key={idx}
            className="scrollmap-pixel-mark"
            data-kind={pm.kind}
            style={{
              top: `${pm.topPx}px`,
              height: `${pm.heightPx}px`,
              backgroundColor: colorForKind(pm.kind),
            }}
          />
        ))}
      </div>

      {thumbHeight > 0 && (
        <div
          className="scrollmap-thumb"
          style={{
            top: `${thumbTop}px`,
            height: `${thumbHeight}px`,
          }}
        />
      )}

      {hoverCard && (
        <div
          className="scrollmap-hover-card"
          style={{ top: `${Math.max(0, hoverCard.top - 10)}px` }}
        >
          <div className="scrollmap-hover-card__head">
            <span className="scrollmap-hover-card__kind">{hoverCard.kindLabel}</span>
            <span className="scrollmap-hover-card__meta">{hoverCard.meta}</span>
          </div>
          {hoverCard.codeSnippet ? (
            <div className="scrollmap-hover-card__code">{hoverCard.codeSnippet}</div>
          ) : null}
          <div className="scrollmap-hover-card__foot">{hoverCard.foot}</div>
        </div>
      )}
    </div>
  );
}
