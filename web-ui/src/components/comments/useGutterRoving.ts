import { useEffect } from "react";

const PLUS = "[data-comment-plus]";

/**
 * Roving focus over the gutter `+` buttons of a comment surface (R85): exactly one is a tab stop, ArrowDown /
 * ArrowUp move between the visible ones (DOM order), Home / End jump to the first / last. Buttons are
 * rendered with `tabIndex={-1}`; this effect promotes one (the last focused, else the first) and keeps it so
 * as rows mount and unmount (virtualised code, hunk expand).
 */
export function useGutterRoving(root: HTMLElement | null, enabled: boolean): void {
  useEffect(() => {
    if (!root || !enabled) return;
    let current: HTMLElement | null = null;

    const all = () => [...root.querySelectorAll<HTMLElement>(PLUS)];
    const sync = () => {
      const list = all();
      if (list.length === 0) return;
      const stop = current && list.includes(current) ? current : list[0]!;
      for (const el of list) el.tabIndex = el === stop ? 0 : -1;
    };

    const onFocusIn = (e: FocusEvent) => {
      const t = e.target instanceof Element ? e.target.closest<HTMLElement>(PLUS) : null;
      if (!t) return;
      current = t;
      sync();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target.closest<HTMLElement>(PLUS) : null;
      if (!t || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const list = all();
      const i = list.indexOf(t);
      let next: HTMLElement | undefined;
      if (e.key === "ArrowDown") next = list[Math.min(i + 1, list.length - 1)];
      else if (e.key === "ArrowUp") next = list[Math.max(i - 1, 0)];
      else if (e.key === "Home") next = list[0];
      else if (e.key === "End") next = list[list.length - 1];
      if (!next) return;
      e.preventDefault();
      next.focus();
    };

    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("keydown", onKeyDown);
    let raf = 0;
    const observer = new MutationObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        sync();
      });
    });
    observer.observe(root, { childList: true, subtree: true });
    sync();
    return () => {
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("keydown", onKeyDown);
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [root, enabled]);
}
