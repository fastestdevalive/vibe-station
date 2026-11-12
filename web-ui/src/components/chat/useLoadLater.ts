import { useEffect, useRef, type RefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";

/** Distance (px) from the bottom of a detached window within which scrolling
 *  loads the next newer page. Larger than the near-top band so the page is
 *  usually in place before the reader reaches the last loaded row. */
export const NEAR_BOTTOM_LOAD_PX = 400;

interface UseLoadLaterArgs<T> {
  /** The list root; its parent is the scroll container. */
  listRef: RefObject<HTMLDivElement | null>;
  virtualizerRef: RefObject<Virtualizer<HTMLElement, Element> | null>;
  itemsRef: RefObject<T[]>;
  itemKey: (item: T) => string;
  /** True while the list shows a window that stops short of the live tail. */
  detached: boolean;
  /** Appends the next newer page; resolves true when the window moved forward. */
  onLoadLater?: () => Promise<boolean>;
}

interface Anchor {
  key: string;
  /** The row's top relative to the scroller's top, in px. */
  top: number;
}

/**
 * Forward paging for a detached window: while the reader is near its bottom
 * the next newer page is appended (one load in flight), and the row they were
 * reading is put back where it was once the page has rendered. A load that
 * moved the window chains into the next one while the reader is still near the
 * bottom; one that did not (failed, or nothing newer) waits for the next
 * scroll or wheel, so it never spins.
 */
export function useLoadLater<T>({
  listRef,
  virtualizerRef,
  itemsRef,
  itemKey,
  detached,
  onLoadLater,
}: UseLoadLaterArgs<T>): void {
  const live = useRef({ detached, onLoadLater, itemKey });
  live.current = { detached, onLoadLater, itemKey };
  const startRef = useRef<() => void>(() => {});

  useEffect(() => {
    const container = listRef.current?.parentElement;
    if (!container) return;
    let disposed = false;
    let pending = false;
    let anchor: Anchor | null = null;

    const rowTop = (row: Element) => row.getBoundingClientRect().top - container.getBoundingClientRect().top;

    /** First row whose bottom edge is inside the viewport. */
    const capture = () => {
      anchor = null;
      const top = container.getBoundingClientRect().top;
      for (const row of container.querySelectorAll<HTMLElement>("[data-row-index]")) {
        if (row.getBoundingClientRect().bottom <= top) continue;
        const item = itemsRef.current?.[Number(row.dataset.rowIndex)];
        if (item !== undefined) anchor = { key: live.current.itemKey(item), top: rowTop(row) };
        return;
      }
    };

    const restore = () => {
      const a = anchor;
      anchor = null;
      const items = itemsRef.current;
      if (!a || !items) return;
      const idx = items.findIndex((it) => live.current.itemKey(it) === a.key);
      if (idx < 0) return;
      const row = container.querySelector(`[data-row-index="${idx}"]`);
      if (row) {
        const delta = rowTop(row) - a.top;
        if (delta !== 0) container.scrollTop += delta;
        return;
      }
      // The row left the rendered range (the list just switched to windowing).
      const offset = virtualizerRef.current?.getOffsetForIndex(idx, "start")?.[0];
      if (offset != null) container.scrollTop = offset - a.top;
    };

    const start = () => {
      const { detached: isDetached, onLoadLater: load } = live.current;
      if (disposed || pending || !isDetached || !load) return;
      if (container.scrollHeight - container.scrollTop - container.clientHeight >= NEAR_BOTTOM_LOAD_PX) return;
      pending = true;
      capture();
      const settle = (moved: boolean) => {
        pending = false;
        if (disposed || !moved) return;
        restore();
        start();
      };
      Promise.resolve()
        .then(load)
        .then(settle, () => settle(false));
    };
    startRef.current = start;

    const onScroll = () => {
      if (pending) capture();
      else start();
    };
    // At the very bottom a wheel moves nothing, so no `scroll` event follows.
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY > 0) start();
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    container.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      disposed = true;
      startRef.current = () => {};
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener("wheel", onWheel);
    };
  }, [listRef, virtualizerRef, itemsRef]);

  // A window that fits in the viewport cannot be scrolled: check once the jump
  // that opened it has placed its target.
  useEffect(() => {
    if (!detached) return;
    const id = requestAnimationFrame(() => startRef.current());
    return () => cancelAnimationFrame(id);
  }, [detached]);
}
