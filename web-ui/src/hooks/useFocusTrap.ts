import { useEffect, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/**
 * Keep Tab inside `ref` while `active` (the send picker, bottom sheets; R101) and, unless `restoreFocus` is off,
 * give focus back to whatever had it when the layer closes. Initial focus is the caller's: it knows which field should take it.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, restoreFocus = true): void {
  useEffect(() => {
    if (!active) return undefined;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (e: KeyboardEvent) => {
      const root = ref.current;
      if (e.key !== "Tab" || !root) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
        if (el.closest("[hidden]")) return false;
        const style = getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden";
      });
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const at = document.activeElement;
      if (e.shiftKey && (at === first || !root.contains(at))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !root.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (restoreFocus && previous && document.contains(previous)) previous.focus();
    };
  }, [ref, active, restoreFocus]);
}
