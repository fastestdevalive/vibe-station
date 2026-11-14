import { createElement, useCallback, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { ArtifactPopover } from "@/components/artifacts/ArtifactPopover";
import { useLongPress } from "@/hooks/useLongPress";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { RectLike } from "@/lib/popupPosition";

export interface RowHit<T> {
  /** What the row stands for. */
  t: T;
  /** The row element: focus returns to it when the menu closes, and keyboard-opened menus anchor to it. */
  row: HTMLElement;
}

export interface RowContextMenuOptions<T> {
  /** Resolves the menu target from the element the event hit (null: not a menu row). */
  resolve: (el: HTMLElement) => RowHit<T> | null;
  /** The menu's rows; `close(refocus)` dismisses it after a pick. */
  items: (t: T, close: (refocus: boolean) => void) => ReactNode;
  width?: number;
  /** Number of rows, used to keep the popover on screen. */
  itemCount?: number;
  label?: string;
}

interface OpenState<T> {
  t: T;
  row: HTMLElement;
  anchorRect: () => RectLike;
}

const ITEM_H = 30;

/**
 * One context menu for a list of rows (tools-pane-rework B7.1). Right-click, the Menu key or Shift+F10 on a focused
 * row, and a touch long-press all open it: at the pointer for mouse and touch, anchored to the row for the keyboard.
 * A bottom sheet on phones. Esc or a pick returns focus to the row.
 */
export function useRowContextMenu<T>({ resolve, items, width = 200, itemCount = 4, label = "Actions" }: RowContextMenuOptions<T>) {
  const mobile = useIsMobile();
  const [open, setOpen] = useState<OpenState<T> | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const watch = useRef<HTMLElement | null>(null);

  const show = useCallback((t: T, row: HTMLElement, anchorRect: () => RectLike) => {
    watch.current = row;
    setOpen({ t, row, anchorRect });
  }, []);

  const close = useCallback((refocus: boolean) => {
    const row = openRef.current?.row;
    setOpen(null);
    if (refocus && row?.isConnected) row.focus();
  }, []);

  const longPress = useLongPress({
    enabled: true,
    onLongPress: (target, point) => {
      const hit = resolve(target);
      if (!hit) return false;
      show(hit.t, hit.row, () => ({ top: point.y, bottom: point.y, left: point.x, right: point.x }));
      return true;
    },
  });
  const { onContextMenu: suppressNativeTouchMenu, ...longPressProps } = longPress;

  const onContextMenu = (e: MouseEvent<HTMLElement>) => {
    const hit = resolve(e.target as HTMLElement);
    if (!hit) {
      suppressNativeTouchMenu(e);
      return;
    }
    e.preventDefault();
    const x = e.clientX;
    const y = e.clientY;
    show(hit.t, hit.row, () => ({ top: y, bottom: y, left: x, right: x }));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!(e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) return;
    const hit = resolve(e.target as HTMLElement);
    if (!hit) return;
    e.preventDefault();
    const row = hit.row;
    show(hit.t, row, () => {
      const r = row.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    });
  };

  // `.ts` (no JSX): the popover is built with createElement.
  const menu: ReactNode = open
    ? createElement(
        ArtifactPopover,
        {
          label,
          mobile,
          className: "rail-menu",
          width,
          height: itemCount * ITEM_H + 8,
          anchorRect: open.anchorRect,
          watchRef: watch,
          onClose: close,
          children: items(open.t, close),
        },
      )
    : null;

  return {
    rowProps: { onContextMenu, onKeyDown },
    longPressProps,
    menu,
  };
}
