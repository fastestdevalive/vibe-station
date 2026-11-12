import { useEffect, useRef, useState } from "react";
import type { Mark } from "./buildMarks";
import type { LineRange } from "./codeLines";
import { useTheme } from "@/hooks/useTheme";
import { useTrackDrag } from "./useTrackDrag";
import { useTrackHeight } from "./useTrackHeight";

interface MinimapProps {
  code: string;
  lineCount: number;
  marks: Mark[];
  visibleRange: LineRange | null;
  onJump?: (line: number) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  /** Called when the summary worker cannot run; the caller falls back to marks. */
  onUnavailable?: () => void;
}

interface WorkerMessageData {
  id: number;
  totalLines: number;
  lines: number;
  progressOnly?: boolean;
  bucketized?: boolean;
  startLine?: number;
  indent?: Uint8Array;
  length?: Uint8Array;
  maxLength?: Uint8Array;
  minIndent?: Uint8Array;
  nonBlankShare?: Uint8Array;
}

export function Minimap({
  code,
  lineCount,
  marks,
  visibleRange,
  onJump,
  onDragStart,
  onDragEnd,
  onUnavailable,
}: MinimapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasCodeRef = useRef<HTMLCanvasElement>(null);
  const canvasTintsRef = useRef<HTMLCanvasElement>(null);

  const [summarizedLines, setSummarizedLines] = useState<number>(0);
  const [workerFailed, setWorkerFailed] = useState(() => typeof Worker === "undefined");

  const chunksRef = useRef<Array<{ startLine: number; indent: Uint8Array; length: Uint8Array }>>([]);
  const bucketsRef = useRef<{ maxLength: Uint8Array; minIndent: Uint8Array; nonBlankShare: Uint8Array } | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef<number>(0);
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;

  const { themeId } = useTheme();

  const effectiveTrackHeight = useTrackHeight(containerRef);

  // Worker setup & re-summarize 300ms after code changes
  useEffect(() => {
    const fail = () => {
      setWorkerFailed(true);
      onUnavailableRef.current?.();
    };
    if (typeof Worker === "undefined") {
      fail();
      return;
    }

    try {
      if (!workerRef.current) {
        workerRef.current = new Worker(
          new URL("./minimapSummary.worker.ts", import.meta.url),
          { type: "module" },
        );
      }
    } catch {
      workerRef.current = null;
      fail();
      return;
    }

    const worker = workerRef.current;
    if (!worker) {
      fail();
      return;
    }

    const onMessage = (e: MessageEvent<WorkerMessageData>) => {
      if (e.data.id !== reqIdRef.current) return;
      if (e.data.progressOnly) {
        setSummarizedLines((prev) => prev + e.data.lines);
        return;
      }
      if (e.data.bucketized && e.data.maxLength && e.data.minIndent && e.data.nonBlankShare) {
        bucketsRef.current = {
          maxLength: new Uint8Array(e.data.maxLength),
          minIndent: new Uint8Array(e.data.minIndent),
          nonBlankShare: new Uint8Array(e.data.nonBlankShare),
        };
        setSummarizedLines(e.data.totalLines);
        return;
      }
      if (e.data.startLine != null && e.data.indent && e.data.length) {
        chunksRef.current.push({
          startLine: e.data.startLine,
          indent: new Uint8Array(e.data.indent),
          length: new Uint8Array(e.data.length),
        });
        setSummarizedLines((prev) => prev + e.data.lines);
      }
    };

    worker.onmessage = onMessage;
    // A worker that fails to load or throws never answers: fall back to marks
    // instead of leaving the minimap hatched forever.
    worker.onerror = (e) => {
      e.preventDefault();
      fail();
    };

    const id = ++reqIdRef.current;
    chunksRef.current = [];
    bucketsRef.current = null;
    setSummarizedLines(0);

    const timer = setTimeout(() => {
      worker.postMessage({ id, text: code });
    }, 300);

    return () => {
      clearTimeout(timer);
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, [code]);

  // Redraw code canvas when summary / theme / resize changes
  useEffect(() => {
    const canvas = canvasCodeRef.current;
    const container = containerRef.current;
    if (!canvas || !container || effectiveTrackHeight <= 0 || lineCount <= 0) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return; // Null 2D context in jsdom

    const style = getComputedStyle(container);
    const fgMuted = style.getPropertyValue("--fg-muted").trim() || style.color;

    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    canvas.width = Math.round(56 * dpr);
    canvas.height = Math.round(effectiveTrackHeight * dpr);

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, 56, effectiveTrackHeight);
    ctx.fillStyle = fgMuted;

    const buckets = bucketsRef.current;
    if (buckets) {
      const bucketCount = buckets.maxLength.length;
      const h = Math.max(1, effectiveTrackHeight / bucketCount);

      for (let b = 0; b < bucketCount; b++) {
        const maxL = buckets.maxLength[b] ?? 0;
        if (maxL === 0) continue;
        const minI = buckets.minIndent[b] ?? 0;
        const share = buckets.nonBlankShare[b] ?? 0;
        const y = (b / bucketCount) * effectiveTrackHeight;
        const w = (maxL / 255) * 44;
        const x = 4 + (minI / 255) * 30;

        ctx.globalAlpha = 0.4 * (share / 255);
        ctx.fillRect(x, y, Math.max(1, w), h);
      }
    } else {
      ctx.globalAlpha = 0.4;
      for (const chunk of chunksRef.current) {
        const len = chunk.length.length;
        for (let i = 0; i < len; i++) {
          const lineIdx = chunk.startLine - 1 + i;
          if (lineIdx >= lineCount) break;
          const lineLen = chunk.length[i] ?? 0;
          if (lineLen === 0) continue;

          const y = (lineIdx / lineCount) * effectiveTrackHeight;
          const w = (lineLen / 255) * 44;
          const indent = chunk.indent[i] ?? 0;
          const x = 4 + (indent / 255) * 30;
          ctx.fillRect(x, y, Math.max(1, w), 1);
        }
      }
    }

    ctx.restore();
  }, [effectiveTrackHeight, lineCount, summarizedLines, themeId]);

  // Redraw second canvas for git tints (full-width tint + 2px stripe) and comment / target ticks
  useEffect(() => {
    const canvas = canvasTintsRef.current;
    const container = containerRef.current;
    if (!canvas || !container || effectiveTrackHeight <= 0 || lineCount <= 0) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return; // Null 2D context in jsdom

    const style = getComputedStyle(container);
    const rulerAdded = style.getPropertyValue("--ruler-added").trim() || style.color;
    const rulerModified = style.getPropertyValue("--ruler-modified").trim() || style.color;
    const rulerDeleted = style.getPropertyValue("--ruler-deleted").trim() || style.color;
    const rulerComment = style.getPropertyValue("--ruler-comment").trim() || style.color;
    const rulerSearch = style.getPropertyValue("--ruler-search").trim() || style.color;

    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    canvas.width = Math.round(56 * dpr);
    canvas.height = Math.round(effectiveTrackHeight * dpr);

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, 56, effectiveTrackHeight);

    for (const m of marks) {
      const top = ((m.startLine - 1) / lineCount) * effectiveTrackHeight;
      const height = Math.max(2, ((m.endLine - m.startLine + 1) / lineCount) * effectiveTrackHeight);

      if (m.kind === "added") {
        ctx.globalAlpha = 0.15;
        ctx.fillStyle = rulerAdded;
        ctx.fillRect(0, top, 56, height);
        ctx.globalAlpha = 1.0;
        ctx.fillRect(0, top, 2, height);
      } else if (m.kind === "modified") {
        ctx.globalAlpha = 0.15;
        ctx.fillStyle = rulerModified;
        ctx.fillRect(0, top, 56, height);
        ctx.globalAlpha = 1.0;
        ctx.fillRect(0, top, 2, height);
      } else if (m.kind === "deleted") {
        ctx.globalAlpha = 1.0;
        ctx.fillStyle = rulerDeleted;
        ctx.fillRect(0, top, 2, 2);
      } else if (m.kind === "comment") {
        ctx.globalAlpha = 0.8;
        ctx.fillStyle = rulerComment;
        ctx.fillRect(0, top, 54, 2);
      } else if (m.kind === "target") {
        ctx.globalAlpha = 1.0;
        ctx.fillStyle = rulerSearch;
        ctx.fillRect(0, top, 56, 2);
      }
    }

    ctx.restore();
  }, [effectiveTrackHeight, lineCount, marks, themeId]);

  // Frame calculation from codeLines.visibleLineRange
  let frameTop = 0;
  let frameHeight = 0;
  if (visibleRange && lineCount > 0 && effectiveTrackHeight > 0) {
    frameTop = Math.max(0, ((visibleRange.first - 1) / lineCount) * effectiveTrackHeight);
    const rawH = ((visibleRange.last - visibleRange.first + 1) / lineCount) * effectiveTrackHeight;
    frameHeight = Math.max(6, rawH);
    if (frameTop + frameHeight > effectiveTrackHeight) {
      frameTop = Math.max(0, effectiveTrackHeight - frameHeight);
    }
  }

  const visibleLines = visibleRange ? visibleRange.last - visibleRange.first + 1 : 0;

  const { handlers } = useTrackDrag({
    trackRef: containerRef,
    trackHeight: effectiveTrackHeight,
    lineCount,
    thumbTop: frameTop,
    thumbHeight: frameHeight,
    visibleLines,
    onJump,
    onDragStart,
    onDragEnd,
    enabled: true,
  });

  const hatchTop =
    lineCount > 0 && effectiveTrackHeight > 0
      ? (summarizedLines / lineCount) * effectiveTrackHeight
      : 0;
  const showHatch = !workerFailed && summarizedLines < lineCount && lineCount > 0;

  return (
    <div
      ref={containerRef}
      className="scrollmap-minimap-container"
      aria-hidden="true"
      {...handlers}
    >
      <canvas ref={canvasCodeRef} className="scrollmap-minimap-canvas" />
      <canvas ref={canvasTintsRef} className="scrollmap-minimap-canvas" />

      {showHatch && (
        <div
          className="scrollmap-minimap-hatch"
          style={{
            top: `${hatchTop}px`,
            bottom: 0,
          }}
        />
      )}

      {frameHeight > 0 && (
        <div
          className="scrollmap-minimap-frame"
          style={{
            top: `${frameTop}px`,
            height: `${frameHeight}px`,
          }}
        />
      )}
    </div>
  );
}
