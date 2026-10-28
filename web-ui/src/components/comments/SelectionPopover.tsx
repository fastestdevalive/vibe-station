import { MessageSquare } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePortalRoot } from "@/context/DemoEnv";
import { useIsTouch } from "@/hooks/useIsTouch";
import { copyText } from "@/lib/copyText";
import type { CommentSurfaceValue } from "./CommentSurfaceContext";
import type { CommentAnchor } from "./types";

const POP_W = 168;
const POP_H = 32;
/** Touch: the buttons are 36px tall (`Mobile` board) and the popover keeps clear of the native callout. */
const TOUCH_POP_H = 44;
/** The native callout sits just above a selection and the drag handles just under it. */
const TOUCH_CLEARANCE = 52;

/** Rect of the selection end that is on screen (`content-visibility:auto` rows skip layout off-screen). */
export function pickVisibleRect(range: Range, bounds: DOMRect): DOMRect {
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  const visible = rects.filter((r) => r.bottom >= bounds.top && r.top <= bounds.bottom);
  return visible[0] ?? rects[0] ?? range.getBoundingClientRect();
}

/**
 * Above the selection when there is room, else below; clamped into the viewport. On touch it sits clear of the
 * native selection callout (above the text) and the drag handles (just below it): under the handles when there
 * is room, else above the callout.
 */
export function popoverPosition(
  rect: DOMRect,
  bounds: DOMRect,
  vw: number,
  vh: number,
  touch = false,
): { top: number; left: number } {
  let top: number;
  if (touch) {
    top = rect.bottom + TOUCH_CLEARANCE;
    if (top + TOUCH_POP_H > vh - 4) top = rect.top - TOUCH_CLEARANCE - TOUCH_POP_H;
    top = Math.max(4, Math.min(top, vh - TOUCH_POP_H - 4));
  } else {
    top = rect.top - POP_H - 6;
    if (top < Math.max(4, bounds.top)) top = rect.bottom + 6;
    top = Math.max(4, Math.min(top, vh - POP_H - 4));
  }
  const left = Math.max(8, Math.min(rect.left, vw - POP_W - 8));
  return { top, left };
}

export interface SelectionAnchor {
  anchor: CommentAnchor;
  endEl: HTMLElement | null;
  text: string;
  top: number;
  left: number;
  /** Hide the popover and drop the selection (after Comment / Copy). */
  dismiss: () => void;
}

/**
 * The current selection inside a comment surface as an anchor + popover position, or null (collapsed, outside
 * the surface, or straddling the two columns of a side-by-side diff). Settles after the pointer is released
 * or a keyboard selection ends, and follows scroll / resize.
 */
export function useSelectionAnchor(surface: CommentSurfaceValue, rootEl: HTMLElement | null): SelectionAnchor | null {
  const [shown, setShown] = useState<SelectionAnchor | null>(null);
  const touch = useIsTouch();
  const touchRef = useRef(touch);
  touchRef.current = touch;
  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;
  const pointerDown = useRef(false);

  const update = useCallback(() => {
    const s = surfaceRef.current;
    const sel = document.getSelection();
    if (!rootEl || !s.enabled || !sel || sel.rangeCount === 0 || sel.isCollapsed) {
      setShown(null);
      return;
    }
    const range = sel.getRangeAt(0);
    const res = s.describe(range);
    if (!res.ok) {
      setShown(null);
      return;
    }
    const bounds = rootEl.getBoundingClientRect();
    const rect = pickVisibleRect(range, bounds);
    const pos = popoverPosition(rect, bounds, window.innerWidth, window.innerHeight, touchRef.current);
    setShown({
      anchor: res.anchor,
      endEl: res.endEl,
      text: sel.toString(),
      ...pos,
      dismiss: () => {
        document.getSelection()?.removeAllRanges();
        setShown(null);
      },
    });
  }, [rootEl]);

  useEffect(() => {
    if (!rootEl) return;
    let raf = 0;
    const schedule = () => {
      if (pointerDown.current) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    const down = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-selection-popover]")) return;
      pointerDown.current = true;
      setShown(null);
    };
    const up = () => {
      pointerDown.current = false;
      schedule();
    };
    rootEl.addEventListener("pointerdown", down);
    document.addEventListener("pointerup", up);
    document.addEventListener("keyup", schedule);
    document.addEventListener("selectionchange", schedule);
    rootEl.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(raf);
      rootEl.removeEventListener("pointerdown", down);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("keyup", schedule);
      document.removeEventListener("selectionchange", schedule);
      rootEl.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [rootEl, update]);

  return shown;
}

/**
 * `Comment [C]` / `Copy` popover for the current selection inside a comment surface (`Rendered` board
 * `.sel-pop`).
 */
export function SelectionPopover({ surface, rootEl }: { surface: CommentSurfaceValue; rootEl: HTMLElement | null }) {
  const portal = usePortalRoot();
  const shown = useSelectionAnchor(surface, rootEl);
  const touch = useIsTouch();
  if (!shown) return null;
  return createPortal(
    <div
      className={`comment-selpop${touch ? " comment-selpop--touch" : ""}`}
      data-selection-popover
      role="toolbar"
      aria-label="Selection actions"
      style={{ top: shown.top, left: shown.left }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        className="comment-btn comment-btn--ghost"
        onClick={() => {
          surface.openNew(shown.anchor, { anchorEl: shown.endEl });
          shown.dismiss();
        }}
      >
        <MessageSquare size={14} aria-hidden />
        Comment{touch ? null : <> <kbd className="comment-kbd">C</kbd></>}
      </button>
      <button type="button" className="comment-btn comment-btn--ghost" onClick={() => void copyText(shown.text)}>
        Copy
      </button>
    </div>,
    portal,
  );
}
