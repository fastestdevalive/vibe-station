import { useCallback, useEffect, type RefObject } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useIsTouch } from "@/hooks/useIsTouch";

const MARGIN = 8;

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll") return p;
  }
  return null;
}

/**
 * Keep the picker's Message field clear of the sticky Send bar and of the on-screen keyboard.
 *
 * `keep()` (sync, for the field's focus) sets the field's scroll margin to the bar's height and scrolls it into view.
 * A keyboard resizes the viewport AFTER that (and the sheet re-fits on its own later state update), so the same
 * correction re-runs two animation frames after every change that can move the field: visual-viewport and window
 * resize, the scroll box or the field itself resizing (editor growth, a popover opening), and typing in the field.
 * The second pass measures against the visual viewport's bottom, so it also holds when the container did not shrink
 * (a phone wider than the sheet breakpoint, e.g. landscape, gets the desktop popover: V-04). It is keyed on a touch
 * device or the phone breakpoint, never on the width alone.
 */
export function useKeepFieldAboveBar(
  rootRef: RefObject<HTMLElement | null>,
  fieldRef: RefObject<HTMLElement | null>,
): () => void {
  const isMobile = useIsMobile();
  const isTouch = useIsTouch();
  const enabled = isMobile || isTouch;

  const keep = useCallback(() => {
    const field = fieldRef.current;
    const bar = rootRef.current?.querySelector<HTMLElement>(".comment-picker__bar");
    if (!field) return;
    field.style.scrollMarginBottom = `${(bar?.offsetHeight ?? 0) + MARGIN}px`;
    field.scrollIntoView?.({ block: "nearest" });
  }, [rootRef, fieldRef]);

  /** Post-layout pass: whatever the container did, the field's bottom must end above the bar and the visible viewport. */
  const settle = useCallback(() => {
    const field = fieldRef.current;
    if (!field || !field.contains(document.activeElement)) return;
    keep();
    const vv = window.visualViewport;
    const bar = rootRef.current?.querySelector<HTMLElement>(".comment-picker__bar");
    const scroller = scrollParent(field);
    if (!scroller) return;
    const visibleBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    const limit = Math.min(bar?.getBoundingClientRect().top ?? Infinity, visibleBottom) - MARGIN;
    const rect = field.getBoundingClientRect();
    if (rect.height === 0 || rect.bottom <= limit) return;
    // Never push the field's top out of the scroll box: it must stay reachable.
    const room = Math.max(0, rect.top - scroller.getBoundingClientRect().top);
    scroller.scrollTop += Math.min(rect.bottom - limit, room);
  }, [keep, rootRef, fieldRef]);

  useEffect(() => {
    if (!enabled) return undefined;
    const field = fieldRef.current;
    let raf1 = 0;
    let raf2 = 0;
    const schedule = () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(settle);
      });
    };
    const vv = window.visualViewport;
    vv?.addEventListener("resize", schedule);
    vv?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    field?.addEventListener("input", schedule);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    if (ro && field) {
      ro.observe(field);
      const scroller = scrollParent(field);
      if (scroller) ro.observe(scroller);
    }
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      vv?.removeEventListener("resize", schedule);
      vv?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      field?.removeEventListener("input", schedule);
      ro?.disconnect();
    };
  }, [enabled, settle, fieldRef]);

  return keep;
}
