import { useEffect, type RefObject } from "react";

const TEXT = ".diff-line-text";

/**
 * Side-by-side column clamp (task 5.10, spike D1): the grid's DOM order interleaves left and right cells, so a
 * native drag selects both columns. On `mousedown` in a `.diff-line-text` the OTHER side's text cells get
 * `user-select: none` (inline), so the drag stays in the column it started in. The clamp is kept after
 * `mouseup` (restoring then would let the browser repaint the range across both columns) and is restored on the
 * next `mousedown`, on Esc with a collapsed selection, when the selection collapses or clears, and on unmount.
 * The selection mapper additionally rejects mixed-side selections.
 */
export function useColumnClamp(rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let clamped: HTMLElement[] = [];

    const restore = () => {
      for (const el of clamped) el.style.removeProperty("user-select");
      clamped = [];
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target instanceof Element ? e.target : null;
      const cell = target?.closest<HTMLElement>(".diff-line[data-side]");
      if (!cell || !target?.closest(TEXT)) return;
      const side = cell.getAttribute("data-side");
      restore();
      clamped = [...root.querySelectorAll<HTMLElement>(`.diff-line[data-side]:not([data-side="${side}"]) ${TEXT}`)];
      for (const el of clamped) el.style.setProperty("user-select", "none");
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && (document.getSelection()?.isCollapsed ?? true)) restore();
    };
    const onSelection = () => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed) restore();
    };

    root.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("selectionchange", onSelection);
    return () => {
      restore();
      root.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("selectionchange", onSelection);
    };
  }, [rootRef]);
}
