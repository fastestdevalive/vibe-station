import type { GutterMarkKind } from "@/components/preview/CodeView";
import type { DiffHunk } from "@/preview/diffParser";

export type MarkKind = "comment" | "deleted" | "modified" | "added" | "target";

export interface Mark {
  kind: MarkKind;
  startLine: number; // 1-based, inclusive
  endLine: number;   // 1-based, inclusive
}

export interface PixelMark {
  topPx: number;
  heightPx: number;
  kind: MarkKind;
  all: Mark[];
}

export interface BuildMarksOptions {
  gutter?: Map<number, ReadonlySet<GutterMarkKind>> | null;
  commentLines?: Array<[number, number]>;
  targetLine?: number | null;
  lineCount: number;
}

const KIND_PRIORITY: Record<MarkKind, number> = {
  comment: 1,
  deleted: 2,
  modified: 3,
  added: 4,
  target: 5,
};

function mergeRanges(ranges: Array<{ start: number; end: number; kind: MarkKind }>): Mark[] {
  if (ranges.length === 0) return [];
  // Group by kind, merge adjacent ranges, then combine
  const byKind = new Map<MarkKind, Array<{ start: number; end: number }>>();
  for (const r of ranges) {
    const list = byKind.get(r.kind) ?? [];
    list.push({ start: r.start, end: r.end });
    byKind.set(r.kind, list);
  }

  const result: Mark[] = [];
  for (const [kind, list] of byKind.entries()) {
    list.sort((a, b) => a.start - b.start);
    const first = list[0];
    if (!first) continue;
    let current = { start: first.start, end: first.end };
    for (let i = 1; i < list.length; i++) {
      const next = list[i];
      if (!next) continue;
      if (next.start <= current.end + 1) {
        current.end = Math.max(current.end, next.end);
      } else {
        result.push({ kind, startLine: current.start, endLine: current.end });
        current = { start: next.start, end: next.end };
      }
    }
    result.push({ kind, startLine: current.start, endLine: current.end });
  }

  result.sort((a, b) => a.startLine - b.startLine || KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]);
  return result;
}

/**
 * Pure mark builder for code views.
 * 1-based lines, adjacent same-kind lines merged.
 */
export function buildMarks(options: BuildMarksOptions): Mark[] {
  const { gutter, commentLines, targetLine, lineCount } = options;
  const raw: Array<{ start: number; end: number; kind: MarkKind }> = [];

  // Gutter marks
  if (gutter) {
    for (const [lineNum, kinds] of gutter.entries()) {
      if (lineCount > 0 && (lineNum < 1 || lineNum > lineCount)) continue;
      if (kinds.has("deleted") || kinds.has("deleted-top")) {
        raw.push({ start: lineNum, end: lineNum, kind: "deleted" });
      } else if (kinds.has("modified")) {
        raw.push({ start: lineNum, end: lineNum, kind: "modified" });
      } else if (kinds.has("added")) {
        raw.push({ start: lineNum, end: lineNum, kind: "added" });
      }
    }
  }

  // Comment line ranges
  if (commentLines) {
    for (const [start, end] of commentLines) {
      const s = Math.max(1, start);
      const e = lineCount > 0 ? Math.min(lineCount, Math.max(s, end)) : Math.max(s, end);
      raw.push({ start: s, end: e, kind: "comment" });
    }
  }

  // Target line (opened line / jump target)
  if (targetLine != null && targetLine >= 1 && (lineCount <= 0 || targetLine <= lineCount)) {
    raw.push({ start: targetLine, end: targetLine, kind: "target" });
  }

  return mergeRanges(raw);
}

/**
 * Projects marks onto a track pixel height in one lane.
 * Priority: comment > deleted > modified > added > target.
 * Each pixel mark keeps all merged marks.
 */
export function layoutMarks(marks: Mark[], lineCount: number, trackPx: number): PixelMark[] {
  if (lineCount <= 0 || trackPx <= 0 || marks.length === 0) return [];

  const rawPixelMarks = marks.map((m) => {
    const top = ((m.startLine - 1) / lineCount) * trackPx;
    let height: number;
    if (m.kind === "target") {
      height = 2;
    } else {
      const rawH = ((m.endLine - m.startLine + 1) / lineCount) * trackPx;
      height = Math.max(2, rawH);
    }
    return {
      top: Math.max(0, Math.min(trackPx - height, top)),
      height,
      mark: m,
    };
  });

  rawPixelMarks.sort((a, b) => a.top - b.top);

  const clustered: Array<{ top: number; bottom: number; all: Mark[] }> = [];
  let current: { top: number; bottom: number; all: Mark[] } | null = null;

  for (const item of rawPixelMarks) {
    const bottom = item.top + item.height;
    if (!current) {
      current = { top: item.top, bottom, all: [item.mark] };
    } else if (item.top <= current.bottom) {
      current.bottom = Math.max(current.bottom, bottom);
      current.all.push(item.mark);
    } else {
      clustered.push(current);
      current = { top: item.top, bottom, all: [item.mark] };
    }
  }
  if (current) {
    clustered.push(current);
  }

  return clustered.map((c) => {
    const firstMark = c.all[0];
    let bestKind: MarkKind = firstMark ? firstMark.kind : "added";
    for (let i = 1; i < c.all.length; i++) {
      const m = c.all[i];
      if (m && KIND_PRIORITY[m.kind] < KIND_PRIORITY[bestKind]) {
        bestKind = m.kind;
      }
    }
    return {
      topPx: c.top,
      heightPx: Math.max(2, c.bottom - c.top),
      kind: bestKind,
      all: c.all,
    };
  });
}

/**
 * Position diff hunk additions and deletions by flattened row index.
 */
export function buildDiffMarks(hunks: DiffHunk[]): Mark[] {
  const marks: Mark[] = [];
  let rowCount = 0;
  let currentKind: "added" | "deleted" | null = null;
  let rangeStart = 0;

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      rowCount++;
      const kind: "added" | "deleted" | null =
        line.type === "added" ? "added" : line.type === "removed" ? "deleted" : null;

      if (kind === currentKind) {
        // Continue current range
      } else {
        if (currentKind !== null) {
          marks.push({
            kind: currentKind,
            startLine: rangeStart,
            endLine: rowCount - 1,
          });
        }
        currentKind = kind;
        rangeStart = rowCount;
      }
    }
  }

  if (currentKind !== null) {
    marks.push({
      kind: currentKind,
      startLine: rangeStart,
      endLine: rowCount,
    });
  }

  return marks;
}
