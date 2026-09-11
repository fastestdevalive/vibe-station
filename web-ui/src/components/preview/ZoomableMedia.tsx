import { useCallback, useEffect, useRef, useState } from "react";

const MIN_SCALE = 1;
const MAX_SCALE = 12;

interface ZoomableMediaProps {
  /** Image URL (blob or remote) to render and zoom. */
  src: string;
  alt?: string;
  className?: string;
  /** When true, renders filling the viewport (used by `ImageZoomOverlay`). */
  fullscreen?: boolean;
  /** Called on single tap/click — fires on pointerUp when pointer travel < 5 px
   *  (inline mode only). */
  onOpenFullscreen?: () => void;
  /** Called on single tap/click — fires on pointerUp when pointer travel < 5 px
   *  (fullscreen mode only). Lets the overlay dismiss on a tap of the image. */
  onTap?: () => void;
  /** Increment to trigger a zoom/pan reset from outside (used by ImageZoomOverlay controls). */
  resetTrigger?: number;
}

interface Transform {
  scale: number;
  tx: number;
  ty: number;
}

const IDENTITY: Transform = { scale: 1, tx: 0, ty: 0 };

/**
 * Shared mouse + touch zoom/pan renderer for `<img>` — the single
 * implementation reused by markdown images, the file preview, and the
 * fullscreen overlay (wheel zooms to cursor, drag pans, pinch zooms about the
 * midpoint, single tap opens fullscreen inline / closes fullscreen).
 */
export function ZoomableMedia({ src, alt, className, fullscreen = false, onOpenFullscreen, onTap, resetTrigger }: ZoomableMediaProps) {
  const [t, setT] = useState<Transform>(IDENTITY);
  const containerRef = useRef<HTMLDivElement>(null);
  const tRef = useRef(t);
  tRef.current = t;
  const dragRef = useRef<{ startX: number; startY: number; tx: number; ty: number } | null>(null);
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ startDist: number; startScale: number } | null>(null);

  const reset = useCallback(() => setT(IDENTITY), []);
  const apply = useCallback((next: Partial<Transform>) => {
    setT((prev) => ({ ...prev, ...next }));
  }, []);
  const clamp = useCallback((scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale)), []);

  // Reset transform whenever the image source changes or the overlay fires a refit.
  useEffect(() => {
    reset();
  }, [src, reset, resetTrigger]);

  const onWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const cur = tRef.current;
      const newScale = clamp(cur.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
      const ratio = newScale / cur.scale;
      const cx = e.clientX - (rect.left ?? 0) - (rect.width ?? 0) / 2;
      const cy = e.clientY - (rect.top ?? 0) - (rect.height ?? 0) / 2;
      apply({ scale: newScale, tx: cx - (cx - cur.tx) * ratio, ty: cy - (cy - cur.ty) * ratio });
    },
    [apply, clamp],
  );

  // Wheel zoom must call preventDefault(), but React's synthetic onWheel is
  // attached as a passive listener, so the page scrolls anyway. Attach a
  // native non-passive listener directly instead.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 1) {
      dragRef.current = { startX: e.clientX, startY: e.clientY, tx: tRef.current.tx, ty: tRef.current.ty };
    } else if (pointersRef.current.size === 2) {
      dragRef.current = null;
      const pts = [...pointersRef.current.values()];
      const dist = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
      pinchRef.current = { startDist: dist || 1, startScale: tRef.current.scale };
    }
    // Optional — not implemented in jsdom; in browsers it keeps the drag
    // gesture owned by this element even when the pointer leaves it.
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!pointersRef.current.has(e.pointerId)) return;
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pts = [...pointersRef.current.values()];
      if (pts.length === 2 && pinchRef.current) {
        const dist = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
        const cur = tRef.current;
        const newScale = clamp(pinchRef.current.startScale * (dist / pinchRef.current.startDist));
        const ratio = newScale / cur.scale;
        const midX = (pts[0]!.x + pts[1]!.x) / 2;
        const midY = (pts[0]!.y + pts[1]!.y) / 2;
        const rect = containerRef.current?.getBoundingClientRect();
        const cx = rect ? midX - (rect.left ?? 0) - (rect.width ?? 0) / 2 : 0;
        const cy = rect ? midY - (rect.top ?? 0) - (rect.height ?? 0) / 2 : 0;
        apply({ scale: newScale, tx: cx - (cx - cur.tx) * ratio, ty: cy - (cy - cur.ty) * ratio });
      } else if (dragRef.current) {
        const dx = e.clientX - dragRef.current.startX;
        const dy = e.clientY - dragRef.current.startY;
        apply({ tx: dragRef.current.tx + dx, ty: dragRef.current.ty + dy });
      }
    },
    [apply, clamp],
  );

  const onPointerEnd = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      pointersRef.current.delete(e.pointerId);
      if (pointersRef.current.size < 2) pinchRef.current = null;
      if (pointersRef.current.size === 0) dragRef.current = null;
      // Single-tap/click fires only when the pointer didn't travel (i.e. it was
      // a tap, not a pan). 5 px threshold covers natural jitter. Inline mode it
      // opens the fullscreen overlay; in fullscreen mode it dismisses it.
      const isTap =
        pointersRef.current.size === 0 &&
        drag &&
        Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 5;
      if (!isTap) return;
      if (fullscreen) {
        onTap?.();
      } else {
        onOpenFullscreen?.();
      }
    },
    [fullscreen, onTap, onOpenFullscreen],
  );

  const zoomed = t.scale > 1;

  return (
    <div
      ref={containerRef}
      className={`zoomable-media${fullscreen ? " zoomable-media--fullscreen" : ""}${className ? ` ${className}` : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}

      style={{ touchAction: zoomed ? "none" : "pan-x pan-y" }}
    >
      <img
        src={src}
        alt={alt ?? ""}
        draggable={false}
        className="zoomable-media__img"
        style={{ transform: `translate(${t.tx}px, ${t.ty}px) scale(${t.scale})` }}
      />
      {zoomed && !fullscreen ? (
        <button
          type="button"
          className="zoomable-media__reset"
          onClick={reset}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          aria-label="Reset zoom"
          title="Reset zoom"
        >
          ⤾
        </button>
      ) : null}
    </div>
  );
}
