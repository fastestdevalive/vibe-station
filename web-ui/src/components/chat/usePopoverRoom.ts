import { useLayoutEffect, type RefObject } from "react";

/** Never shrink a popover below this, however little room there is (its rows scroll inside). */
export const POPOVER_MIN_ROOM = 96;
/** With less than POPOVER_MIN_ROOM on BOTH sides, the larger side is used but never below this (about two rows). */
export const POPOVER_TINY_ROOM = 48;
const GAP = 4;
const EDGE = 8;

/** The nearest ancestor that clips or scrolls its content: an upward popover cannot be seen past its top edge. */
function clippingAncestor(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") return p;
  }
  return null;
}

/**
 * The editor's `/` and `@` popovers open UPWARD from the shell (`bottom: calc(100% + 4px)`), so an ancestor that
 * clips (the send picker's scroll box, a bottom sheet) cuts off the top of a tall popover and upward overflow
 * cannot be scrolled to. While `active`, measure the room between the shell and the VISIBLE edges (the clipping
 * ancestor's top and the visual viewport, so an on-screen keyboard counts) and publish it as `--chat-popover-room`
 * on the shell; the popovers cap their `max-height` with it. When there is no room above but enough below (down to
 * the visual viewport or an element marked `data-popover-floor`, such as a sticky action bar), the shell gets
 * `data-popover-side="below"` and the popover opens downward instead. Not set without layout (jsdom), so the plain
 * caps apply there.
 *
 * A layout effect, so the cap exists before the popover's own mount effects (it scrolls its active option into
 * view, which would otherwise scroll a clipping ancestor and push the shell under a sticky bar). The clipping
 * ancestor is found once per activation; later measurements are coalesced into one animation frame and re-run on
 * resize / scroll / visual-viewport resize and when the shell or the ancestor changes size (the editor growing).
 */
export function usePopoverRoom(shellRef: RefObject<HTMLElement | null>, active: boolean): void {
  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell || !active) return undefined;
    const ancestor = clippingAncestor(shell);
    const clear = () => {
      shell.style.removeProperty("--chat-popover-room");
      delete shell.dataset.popoverSide;
    };
    const measure = () => {
      const r = shell.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        clear();
        return;
      }
      const vv = window.visualViewport;
      const visTop = Math.max(ancestor?.getBoundingClientRect().top ?? 0, vv?.offsetTop ?? 0);
      const visBottom = Math.min(
        vv ? vv.offsetTop + vv.height : window.innerHeight,
        ancestor?.querySelector("[data-popover-floor]")?.getBoundingClientRect().top ?? Infinity,
      );
      const above = Math.floor(r.top - visTop - GAP - EDGE);
      const below = Math.floor(visBottom - r.bottom - GAP - EDGE);
      const useBelow = above >= POPOVER_MIN_ROOM ? false : below >= POPOVER_MIN_ROOM || below > above;
      const room = useBelow ? below : above;
      if (useBelow) shell.dataset.popoverSide = "below";
      else delete shell.dataset.popoverSide;
      const floor = Math.max(room, room >= POPOVER_MIN_ROOM ? 0 : POPOVER_TINY_ROOM);
      shell.style.setProperty("--chat-popover-room", `${floor}px`);
    };
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    measure();
    window.addEventListener("resize", schedule);
    // Capture: scrolling any ancestor (the picker's scroll box) moves the shell inside it.
    window.addEventListener("scroll", schedule, true);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", schedule);
    vv?.addEventListener("scroll", schedule);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    ro?.observe(shell);
    if (ancestor) ro?.observe(ancestor);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      vv?.removeEventListener("resize", schedule);
      vv?.removeEventListener("scroll", schedule);
      ro?.disconnect();
      clear();
    };
  }, [shellRef, active]);
}
