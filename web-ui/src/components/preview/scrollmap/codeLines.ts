import type { CodeViewHandle } from "@/components/preview/CodeView";

export interface LineRange {
  first: number;
  last: number;
}

function parseRowNumber(value: string | null): number | null {
  if (value == null) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Diff rows carry `data-diff-row` (DiffView/DiffSideBySide): the 1-based index
 * of the row in the flattened hunk order, which is the scale marks, the thumb
 * and jumps are all drawn on. `data-line` is the new-file line number and must
 * never be used here — a hunk at line 800 in a 40-row diff would put the thumb
 * off the track. Rows without the attribute (expanded context-gap rows) are
 * not part of the scale.
 */
function diffRowIndex(row: HTMLElement): number | null {
  const n = parseRowNumber(row.getAttribute("data-diff-row"));
  return n != null && n > 0 ? n : null;
}

function codeRowLine(row: HTMLElement, indexInList: number): number {
  const lineAttr = parseRowNumber(row.getAttribute("data-line"));
  if (lineAttr != null) return lineAttr;
  const indexAttr = parseRowNumber(row.getAttribute("data-index"));
  if (indexAttr != null) return indexAttr + 1;
  const childLine = row.querySelector("[data-line]");
  if (childLine) {
    const childAttr = parseRowNumber(childLine.getAttribute("data-line"));
    if (childAttr != null) return childAttr;
  }
  return indexInList + 1;
}

/**
 * Binary search over mounted row rects to find visible line range: positions come from line
 * numbers, never from the raw `scrollTop / scrollHeight` ratio.
 * 1-based line numbers in code mode, 1-based diff row indices in diff mode.
 */
export function visibleLineRange(scrollEl: HTMLElement, mode: "code" | "diff" = "code"): LineRange | null {
  let rows: NodeListOf<HTMLElement>;
  if (mode === "diff") {
    rows = scrollEl.querySelectorAll<HTMLElement>(".diff-line[data-diff-row]");
  } else {
    const vrows = scrollEl.querySelectorAll<HTMLElement>(".workspace-code-vrow[data-index]");
    rows = vrows.length > 0 ? vrows : scrollEl.querySelectorAll<HTMLElement>(".workspace-code-line[data-line]");
  }

  if (rows.length === 0) return null;

  const scrollerRect = scrollEl.getBoundingClientRect();
  const scrollerTop = scrollerRect.top;
  const scrollerBottom = scrollerRect.bottom;

  // Binary search for first visible row (first whose bottom > scrollerTop)
  let low = 0;
  let high = rows.length - 1;
  let firstIdx = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const row = rows[mid];
    if (!row) break;
    if (row.getBoundingClientRect().bottom > scrollerTop) {
      firstIdx = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  if (firstIdx === -1) return null;

  // Binary search for last visible row (last whose top < scrollerBottom)
  low = firstIdx;
  high = rows.length - 1;
  let lastIdx = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const row = rows[mid];
    if (!row) break;
    if (row.getBoundingClientRect().top < scrollerBottom) {
      lastIdx = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (lastIdx === -1 || lastIdx < firstIdx) return null;

  const firstRow = rows[firstIdx];
  const lastRow = rows[lastIdx];
  if (!firstRow || !lastRow) return null;

  if (mode === "diff") {
    const first = diffRowIndex(firstRow);
    const last = diffRowIndex(lastRow);
    if (first == null || last == null || last < first) return null;
    return { first, last };
  }

  return {
    first: codeRowLine(firstRow, firstIdx),
    last: codeRowLine(lastRow, lastIdx),
  };
}

/**
 * Scroll to line (1-based) without modifying CodeView, by line index rather than
 * by scroll ratio.
 */
export function scrollToLine(scrollEl: HTMLElement, handle: CodeViewHandle | null, line: number /* 1-based */): void {
  if (handle?.isVirtualized()) {
    handle.scrollToLine(line - 1);
    return;
  }
  const row = scrollEl.querySelector<HTMLElement>(`.workspace-code-line[data-line="${line}"]`);
  if (row) {
    scrollEl.scrollTop += row.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top;
  }
}

/**
 * Convert fraction f (0..1) to 1-based line number.
 */
export function lineAtFraction(f: number, lineCount: number): number {
  if (lineCount <= 0) return 1;
  const clamped = Math.max(0, Math.min(1, f));
  return Math.min(lineCount, Math.max(1, Math.floor(clamped * lineCount) + 1));
}

/**
 * Given a pointer line, visible lines in the viewport, and total line count,
 * computes the 1-based top line so the pointer line is centred in the viewport.
 */
export function centeredTopLine(pointerLine: number, visibleLines: number, lineCount: number): number {
  const maxTop = Math.max(1, lineCount - visibleLines + 1);
  const target = pointerLine - Math.floor(visibleLines / 2);
  return Math.min(maxTop, Math.max(1, target));
}
