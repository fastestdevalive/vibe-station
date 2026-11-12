import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { centeredTopLine, lineAtFraction } from "./codeLines";

/** Pointer travel (px) from the press point before a move counts as a drag. */
const DRAG_SLOP_PX = 3;

export interface TrackDragOptions {
  /** The track the thumb moves in; pointer positions are measured against it. */
  trackRef: RefObject<HTMLElement | null>;
  trackHeight: number;
  lineCount: number;
  /** Current top of the thumb/band in track pixels. */
  thumbTop: number;
  /** Current height of the thumb/band in track pixels. */
  thumbHeight: number;
  /** Number of lines currently visible in the viewport. */
  visibleLines: number;
  onJump?: (line: number) => void;
  /** Drag is ignored while false (read-only track, no jump target). */
  enabled: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  /**
   * Optional custom resolver for the synchronous pointer-down jump on the track
   * before centering (e.g. mark snapping in TrackMarks).
   */
  pressLine?: (y: number) => number | undefined;
}

export interface TrackDragHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  onLostPointerCapture: (e: ReactPointerEvent<HTMLElement>) => void;
}

/**
 * Drag behaviour shared by the marks track and the minimap container.
 * Pressing on the band grabs it (retaining offset so the move delta scrolls
 * without jump), while pressing on empty area jumps centered and begins a drag.
 * Handlers attach to the track container element. Only the pointer that started
 * the drag drives it; moves within DRAG_SLOP_PX of the press point are ignored.
 * Moves are coalesced to at most one jump per animation frame, and the drag ends
 * on pointerup/cancel, on lost pointer capture, or when the track unmounts.
 */
export function useTrackDrag({
  trackRef,
  trackHeight,
  lineCount,
  thumbTop,
  thumbHeight,
  visibleLines,
  onJump,
  enabled,
  onDragStart,
  onDragEnd,
  pressLine,
}: TrackDragOptions): {
  handlers: TrackDragHandlers;
  isDraggingRef: RefObject<boolean>;
} {
  const modeRef = useRef<"grab" | "center" | null>(null);
  const isDraggingRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const pressYRef = useRef(0);
  const movedRef = useRef(false);
  const grabOffsetRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<number | null>(null);

  const optionsRef = useRef({ trackHeight, lineCount, visibleLines, onJump, onDragEnd });
  optionsRef.current = { trackHeight, lineCount, visibleLines, onJump, onDragEnd };

  const cancelFrame = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  /** Resets the gesture; returns false when no drag was active. */
  const finish = useCallback((): boolean => {
    if (modeRef.current === null) return false;
    modeRef.current = null;
    pointerIdRef.current = null;
    isDraggingRef.current = false;
    cancelFrame();
    return true;
  }, [cancelFrame]);

  useEffect(() => {
    return () => {
      if (finish()) {
        pendingRef.current = null;
        optionsRef.current.onDragEnd?.();
      }
      cancelFrame();
    };
  }, [finish, cancelFrame]);

  const endDrag = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (e.pointerId !== pointerIdRef.current || !finish()) return;
      const t = pendingRef.current;
      pendingRef.current = null;
      if (t != null) optionsRef.current.onJump?.(t);
      optionsRef.current.onDragEnd?.();
      try {
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      } catch {
        // The capture already ended with the pointer.
      }
    },
    [finish],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || !onJump || e.button !== 0) return;
      if (modeRef.current !== null) {
        // A second pointer never steals a drag; the same pointer pressing again means its end
        // event was missed (capture failed and it was released off the track), so restart cleanly.
        if (e.pointerId !== pointerIdRef.current) return;
        endDrag(e);
      }
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const h = trackHeight > 0 ? trackHeight : (el.clientHeight || rect.height);
      if (h <= 0) return;

      const isGrab = thumbHeight > 0 && y >= thumbTop && y <= thumbTop + thumbHeight;
      if (isGrab) {
        modeRef.current = "grab";
        grabOffsetRef.current = y - thumbTop;
      } else {
        modeRef.current = "center";
        const rawLine = pressLine?.(y) ?? lineAtFraction(y / h, lineCount);
        onJump(centeredTopLine(rawLine, visibleLines, lineCount));
      }

      pointerIdRef.current = e.pointerId;
      pressYRef.current = e.clientY;
      movedRef.current = false;
      isDraggingRef.current = true;
      onDragStart?.();
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId);
      } catch {
        // Pointer capture may fail in mock environments
      }
      e.preventDefault();
    },
    [enabled, onJump, trackRef, trackHeight, lineCount, thumbTop, thumbHeight, visibleLines, onDragStart, pressLine, endDrag],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (modeRef.current === null || e.pointerId !== pointerIdRef.current) return;
      if (!movedRef.current) {
        if (Math.abs(e.clientY - pressYRef.current) < DRAG_SLOP_PX) return;
        movedRef.current = true;
      }
      const el = trackRef.current;
      if (!el) return;
      const { trackHeight: th, lineCount: lc, visibleLines: vl, onJump: oj } = optionsRef.current;
      if (!oj) return;
      const h = th > 0 ? th : (el.clientHeight || el.getBoundingClientRect().height);
      if (h <= 0) return;

      const y = e.clientY - el.getBoundingClientRect().top;
      let target: number;
      if (modeRef.current === "grab") {
        const top = y - grabOffsetRef.current;
        const raw = lineAtFraction(top / h, lc);
        const maxTop = vl > 0 ? Math.max(1, lc - vl + 1) : lc;
        target = Math.min(maxTop, raw);
      } else {
        const candidate = lineAtFraction(y / h, lc);
        target = centeredTopLine(candidate, vl, lc);
      }

      pendingRef.current = target;
      if (rafRef.current != null) return;
      const id = requestAnimationFrame(() => {
        rafRef.current = null;
        const t = pendingRef.current;
        pendingRef.current = null;
        if (t != null) optionsRef.current.onJump?.(t);
      });
      // A frame that already ran synchronously leaves nothing pending to track.
      if (pendingRef.current != null) rafRef.current = id;
    },
    [trackRef],
  );

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onLostPointerCapture: endDrag,
    },
    isDraggingRef,
  };
}
