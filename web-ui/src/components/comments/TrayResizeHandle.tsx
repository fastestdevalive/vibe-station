import { useEffect, useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useDemoEnv } from "@/context/DemoEnv";
import { clampTrayHeight, type TrayHeight } from "./useTrayHeight";

const KEY_STEP = 16;
const PAGE_STEP = 64;
const DOUBLE_TAP_MS = 300;
const TAP_SLOP = 6;

/**
 * The top-edge resize handle of the expanded comments list: a `separator` you drag (mouse, touch, pen via
 * Pointer Events) or move with the keyboard; a double-click or double tap resets to the default. Dragging up
 * makes the list taller. Lives inside `CommentsTray`, so the agent pane's tree path is never touched.
 */
export function TrayResizeHandle({ height }: { height: TrayHeight }) {
  const { shown, min, max, setDraft, commit, reset } = height;
  const env = useDemoEnv();
  const k = env.demo && env.scale > 0 ? env.scale : 1;
  const cleanupRef = useRef<(() => void) | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);

  // A collapse or unmount mid-drag restores the body styles and drops the listeners.
  useEffect(() => () => cleanupRef.current?.(), []);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== undefined && e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    const target = e.currentTarget;
    const startY = e.clientY;
    const startX = e.clientX;
    const start = shown;
    const prevSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    if (!env.demo) {
      document.body.style.userSelect = "none";
      document.body.style.cursor = "row-resize";
    }
    target.setPointerCapture?.(e.pointerId);
    target.dataset.dragging = "true";
    let raf = 0;
    let pending: number | null = null;
    const flush = () => {
      raf = 0;
      if (pending != null) setDraft(pending);
    };
    const valueAt = (y: number) => clampTrayHeight(start + (startY - y) / k, min, max);

    function onMove(ev: PointerEvent) {
      pending = valueAt(ev.clientY);
      if (!raf) raf = window.requestAnimationFrame(flush);
    }
    function cleanup() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      if (raf) window.cancelAnimationFrame(raf);
      if (!env.demo) {
        document.body.style.userSelect = prevSelect;
        document.body.style.cursor = prevCursor;
      }
      delete target.dataset.dragging;
      cleanupRef.current = null;
    }
    function onUp(ev: PointerEvent) {
      cleanup();
      const moved = Math.hypot(ev.clientX - startX, ev.clientY - startY);
      if (moved < TAP_SLOP) {
        // A tap, not a drag: two within 300ms reset (touch `dblclick` is unreliable with `touch-action: none`).
        const prev = lastTap.current;
        const now = ev.timeStamp || Date.now();
        if (prev && now - prev.t <= DOUBLE_TAP_MS && Math.hypot(ev.clientX - prev.x, ev.clientY - prev.y) < TAP_SLOP * 2) {
          lastTap.current = null;
          setDraft(null);
          reset();
          return;
        }
        lastTap.current = { t: now, x: ev.clientX, y: ev.clientY };
        setDraft(null);
        return;
      }
      lastTap.current = null;
      const final = valueAt(ev.clientY);
      setDraft(null);
      commit(final);
    }
    function onCancel() {
      cleanup();
      setDraft(null);
    }
    cleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    let next: number;
    switch (e.key) {
      case "ArrowUp":
        next = shown + KEY_STEP;
        break;
      case "ArrowDown":
        next = shown - KEY_STEP;
        break;
      case "PageUp":
        next = shown + PAGE_STEP;
        break;
      case "PageDown":
        next = shown - PAGE_STEP;
        break;
      case "Home":
        next = min;
        break;
      case "End":
        next = max;
        break;
      default:
        return;
    }
    e.preventDefault();
    commit(next);
  }

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize comments list"
      aria-valuenow={shown}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      className="comment-tray__handle"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        setDraft(null);
        reset();
      }}
    >
      <span className="comment-tray__grabber" aria-hidden />
    </div>
  );
}
