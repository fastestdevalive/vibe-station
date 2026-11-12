import { useEffect, useMemo, useState, type RefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { RenderItem } from "./MessageList";
import type { RowUiStore } from "./rowUiState";
import { createJumpFlash } from "./jumpFlash";
import { groupAnchorMarks } from "./find/anchorMarks";

/** Animation frames to wait for a virtualized row to mount after `scrollToIndex`. */
const NAV_MOUNT_FRAMES = 10;

export interface MessageNav {
  seqAnchor(seq: number): string | undefined;
  /** Whether a row for `anchor` is in the loaded window. */
  hasAnchor?(anchor: string): boolean;
  anchorWhere(anchor: string): "in-view" | "above" | "below";
  /** Scrolls to the `ordinal`-th distinct find mark inside `anchor` and returns
   *  its key, or scrolls the row and returns null when that mark is missing or
   *  the row renders a different number of marks than `expectedMarks`. */
  scrollToAnchor(
    anchor: string,
    opts?: { ordinal?: number; expectedMarks?: number },
  ): Promise<string | null>;
  visibleItemRange(): [number, number];
  /** This pane's row holding `anchor`, or null. Never another pane's row. */
  rowFor(anchor: string): HTMLElement | null;
  jumpTurn(direction: -1 | 1): void;
  /** Tints the row holding `anchor` for a moment after a jump (one flash at a time). */
  flashAnchor(anchor: string): void;
}

export function itemAnchorKey(item: RenderItem): string | undefined {
  switch (item.type) {
    case "user":
      return `u:${item.turnId ?? item.id}`;
    case "assistant":
      return `a:${item.id}`;
    case "thinking":
      return `th:${item.id}`;
    case "tool":
      return `t:${item.id}`;
    case "toolRun": {
      const ids: string[] = [];
      const collect = (tools: typeof item.tools) => {
        for (const t of tools) {
          ids.push(`t:${t.id}`);
          if (t.children) collect(t.children);
        }
      };
      collect(item.tools);
      return ids.join(" ");
    }
    case "error":
    case "status":
    case "system_event":
    case "session_break":
      return `i:${item.id}`;
    default:
      return undefined;
  }
}

export function matchItemAnchor(item: RenderItem, anchor: string): boolean {
  const key = itemAnchorKey(item);
  return key ? key.split(" ").includes(anchor) : false;
}

interface UseMessageNavParams {
  items: RenderItem[];
  seqIndex: Map<number, string>;
  virtualizer: Virtualizer<HTMLElement, Element>;
  virtualized: boolean;
  listRef: RefObject<HTMLDivElement | null>;
  rowUiStore?: RowUiStore | null;
}

export function useMessageNav({
  items,
  seqIndex,
  virtualizer,
  virtualized,
  listRef,
  rowUiStore,
}: UseMessageNavParams): MessageNav {
  const [jumpFlash] = useState(createJumpFlash);
  useEffect(() => () => jumpFlash.clear(), [jumpFlash]);

  return useMemo<MessageNav>(() => {
    /**
     * Index of the first row that reaches below the line a turn jump scrolls a
     * user row to: the scroller top plus that row's `scroll-margin-top` (the
     * open find bar sets one). Measured from the bare top, the row just above a
     * jumped-to turn still overlaps the viewport and Alt+Down would pick the
     * same turn again. Undefined when no row reaches below the line.
     */
    const turnLineIndex = (): number | undefined => {
      const scroller = listRef.current?.parentElement ?? listRef.current;
      if (!scroller) return undefined;
      const userRow = listRef.current?.querySelector<HTMLElement>('[data-find-anchor^="u:"]');
      const margin = userRow ? parseFloat(getComputedStyle(userRow).scrollMarginTop) || 0 : 0;
      // Sub-pixel slack: a row that ends exactly on the line is above it.
      const line = margin + 1;
      if (virtualized) {
        const top = virtualizer.scrollOffset ?? 0;
        let index: number | undefined;
        for (const v of virtualizer.getVirtualItems()) {
          if (v.end - top > line && (index == null || v.index < index)) index = v.index;
        }
        return index;
      }
      const scrollerTop = scroller.getBoundingClientRect().top;
      const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-row-index]") ?? [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        if (row.getBoundingClientRect().bottom - scrollerTop > line) {
          return Number(row.dataset.rowIndex ?? i);
        }
      }
      return undefined;
    };

    function revealAnchor(anchor: string): void {
      if (!rowUiStore) return;
      if (anchor.startsWith("th:")) {
        rowUiStore.set(`think:${anchor.slice(3)}`, true, false);
        return;
      }
      if (anchor.startsWith("t:")) {
        const toolId = anchor.slice(2);
        rowUiStore.set(`tool:${toolId}`, true, false);
        for (const it of items) {
          if (it.type === "toolRun") {
            const contains = (tools: typeof it.tools): boolean => {
              for (const t of tools) {
                if (t.id === toolId) return true;
                if (t.children && contains(t.children)) return true;
              }
              return false;
            };
            if (contains(it.tools)) {
              rowUiStore.set(`run:${it.id}`, true, false);
              break;
            }
          }
        }
      }
    }

    const rowFor = (anchor: string): HTMLElement | null =>
      listRef.current?.querySelector<HTMLElement>(`[data-find-anchor~="${CSS.escape(anchor)}"]`) ?? null;

    const nav: MessageNav = {
      seqAnchor(seq: number): string | undefined {
        return seqIndex.get(seq);
      },

      hasAnchor(anchor: string): boolean {
        return items.some((it) => matchItemAnchor(it, anchor));
      },

      anchorWhere(anchor: string): "in-view" | "above" | "below" {
        const scroller = listRef.current?.parentElement ?? listRef.current;
        if (!scroller) return "below";

        const el = rowFor(anchor);

        if (el) {
          const scrollerRect = scroller.getBoundingClientRect();
          const elRect = el.getBoundingClientRect();
          if (elRect.bottom < scrollerRect.top) return "above";
          if (elRect.top > scrollerRect.bottom) return "below";
          return "in-view";
        }

        const itemIndex = items.findIndex((it) => matchItemAnchor(it, anchor));
        if (itemIndex === -1) return "below";

        if (virtualized) {
          const vItems = virtualizer.getVirtualItems();
          if (vItems.length > 0 && itemIndex < vItems[0]!.index) {
            return "above";
          }
        }

        return "below";
      },

      async scrollToAnchor(
        anchor: string,
        opts: { ordinal?: number; expectedMarks?: number } = {},
      ): Promise<string | null> {
        const itemIndex = items.findIndex((it) => matchItemAnchor(it, anchor));
        if (itemIndex === -1) return null;

        revealAnchor(anchor);

        const findKeyInElement = (el: HTMLElement): string | null => {
          const { distinctKeys, keyFirstMark } = groupAnchorMarks(el, anchor);

          // A row whose rendered marks do not line up with the indexed
          // occurrences cannot say which mark is the match: outline the row.
          const countsAgree = opts.expectedMarks == null || opts.expectedMarks === distinctKeys.length;
          const targetKey = countsAgree ? distinctKeys[opts.ordinal ?? 0] : undefined;
          if (targetKey && keyFirstMark.has(targetKey)) {
            const mark = keyFirstMark.get(targetKey)!;
            mark.scrollIntoView({ block: "start" });
            return targetKey;
          }

          el.scrollIntoView({ block: "start" });
          return null;
        };

        if (!virtualized) {
          const el = rowFor(anchor);
          if (el) {
            return findKeyInElement(el);
          }
          return null;
        }

        virtualizer.scrollToIndex(itemIndex, { align: "start" });

        return new Promise<string | null>((resolve) => {
          let framesLeft = NAV_MOUNT_FRAMES;

          const check = () => {
            const el = rowFor(anchor);
            if (el) {
              resolve(findKeyInElement(el));
              return;
            }

            framesLeft--;
            if (framesLeft > 0) {
              requestAnimationFrame(check);
            } else {
              resolve(null);
            }
          };

          requestAnimationFrame(check);
        });
      },

      rowFor,

      visibleItemRange(): [number, number] {
        if (items.length === 0) return [0, 0];
        if (virtualized) {
          // The virtualizer's items include overscan and pinned rows, so keep
          // only those overlapping the scroll viewport.
          const vItems = virtualizer.getVirtualItems();
          if (vItems.length === 0) return [0, 0];
          const top = virtualizer.scrollOffset ?? 0;
          const height = virtualizer.scrollRect?.height ?? 0;
          const inView = height > 0 ? vItems.filter((v) => v.end > top && v.start < top + height) : vItems;
          if (inView.length === 0) return [0, 0];
          let first = inView[0]!.index;
          let last = first;
          for (const v of inView) {
            first = Math.min(first, v.index);
            last = Math.max(last, v.index);
          }
          return [first, last];
        }

        const scroller = listRef.current?.parentElement ?? listRef.current;
        if (!scroller) return [0, Math.max(0, items.length - 1)];

        const scrollerRect = scroller.getBoundingClientRect();
        const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-row-index]");
        if (!rows || rows.length === 0) return [0, Math.max(0, items.length - 1)];

        let first = -1;
        let last = -1;
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]!;
          const rect = row.getBoundingClientRect();
          if (rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom) {
            const idx = Number(row.dataset.rowIndex ?? i);
            if (first === -1) first = idx;
            last = idx;
          }
        }

        if (first === -1) return [0, 0];
        return [first, last];
      },

      jumpTurn(direction: -1 | 1): void {
        const firstVisible = turnLineIndex() ?? nav.visibleItemRange()[0];
        const userItemIndices: number[] = [];
        for (let i = 0; i < items.length; i++) {
          if (items[i]!.type === "user") {
            userItemIndices.push(i);
          }
        }
        if (userItemIndices.length === 0) return;

        if (direction === -1) {
          let target = userItemIndices[0]!;
          for (let i = userItemIndices.length - 1; i >= 0; i--) {
            if (userItemIndices[i]! < firstVisible) {
              target = userItemIndices[i]!;
              break;
            }
          }
          const it = items[target];
          if (it && it.type === "user") {
            void nav.scrollToAnchor(`u:${it.turnId ?? it.id}`);
          }
        } else {
          // No later turn: stay put rather than scrolling back up to the last one.
          const target = userItemIndices.find((idx) => idx > firstVisible);
          if (target == null) return;
          const it = items[target];
          if (it && it.type === "user") {
            void nav.scrollToAnchor(`u:${it.turnId ?? it.id}`);
          }
        }
      },

      flashAnchor(anchor: string): void {
        const el = rowFor(anchor);
        if (el) jumpFlash.flash(el);
      },
    };

    return nav;
  }, [items, seqIndex, virtualizer, virtualized, listRef, rowUiStore, jumpFlash]);
}
