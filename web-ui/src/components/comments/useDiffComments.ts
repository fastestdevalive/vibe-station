import { useCallback, useEffect, useMemo } from "react";
import type { ReviewComment } from "@/api/types";
import type { DiffHunk, DiffLine } from "@/preview/diffParser";
import { focusCommentCard } from "./commentJump";
import { useCommentSurface, type CommentSurfaceValue } from "./CommentSurfaceContext";
import { commentSpan, rowKey, rowMarks, type RowSide, type SurfaceComments } from "./rowIndex";
import type { PinMeasurer } from "./pinMeasurer";
import type { DiffGap } from "@/preview/diffGaps";
import type { HtmlMarkRange } from "./markHtmlRanges";

/** The comment rows a diff line answers to: removed = old side, added = new side, context = both. */
export function diffRowKeys(line: DiffLine, inline: boolean): Array<{ side: RowSide; n: number }> {
  const out: Array<{ side: RowSide; n: number }> = [];
  if (line.type !== "removed" && line.newLineNumber != null) out.push({ side: "new", n: line.newLineNumber });
  if (line.oldLineNumber != null && (line.type === "removed" || inline)) out.push({ side: "old", n: line.oldLineNumber });
  return out;
}

export interface DiffComments {
  surface: CommentSurfaceValue;
  view: SurfaceComments;
  /** Comments whose last line is in this hunk (the collapsed-hunk chip). */
  countInHunk: (hunk: DiffHunk) => number;
  covers: (keys: Array<{ side: RowSide; n: number }>) => ReviewComment[] | undefined;
  pins: (keys: Array<{ side: RowSide; n: number }>) => ReviewComment[] | undefined;
  marks: (keys: Array<{ side: RowSide; n: number }>, text: string) => HtmlMarkRange[];
  /**
   * INLINE diff only: per row of `lines`, the comments whose span runs through it. Rows between a comment's first
   * and last row that belong to the other side (a removed row inside a new-side span) get the row tint and bar,
   * never text marks (their text is not part of the quote).
   */
  inlineCovers: (lines: readonly DiffLine[]) => Array<ReviewComment[] | undefined>;
  /** The open box's span when it covers one of these rows (dashed marks). */
  draftFor: (keys: Array<{ side: RowSide; n: number }>) => ReviewComment | undefined;
  /** The open box's span when its LAST row is one of these (the draft pin). */
  draftEndsAt: (keys: Array<{ side: RowSide; n: number }>) => ReviewComment | undefined;
  /** A collapsed gap whose hidden lines a comment span runs through (its header shows the span bar). */
  gapCommented: (gap: DiffGap) => boolean;
  activeId: string | null;
  measurer: PinMeasurer;
  onPlus: (plus: HTMLElement) => void;
  onPinOpen: (id: string, el: HTMLElement) => void;
}

const merge = (
  m: { get: (key: string) => ReviewComment[] | undefined },
  keys: Array<{ side: RowSide; n: number }>,
): ReviewComment[] | undefined => {
  let out: ReviewComment[] | undefined;
  for (const k of keys) {
    const a = m.get(rowKey(k.side, k.n));
    if (!a) continue;
    out = out ? [...out, ...a.filter((c) => !out!.includes(c))] : a;
  }
  return out;
};

/**
 * `DiffView`'s window onto the comment surface (inline and side-by-side): per-row covers / pins / marks, the
 * gutter `+` handler, the collapsed-hunk count, and publishing the hunk rows so selections get their context
 * from the diff. Null outside a comment surface, for another file, or for a non-interactive diff.
 */
export function useDiffComments(
  filePath: string | undefined,
  enabled: boolean,
  hunks: DiffHunk[],
  surfaceName: "diff" | "markdown" = "diff",
): DiffComments | null {
  const cs = useCommentSurface();
  const active = enabled && !!cs && cs.enabled && filePath === cs.path && (surfaceName !== "diff" || cs.diffScope !== undefined);
  const view = active ? cs.forSurface(surfaceName) : null;

  const setCorpus = cs?.setDiffCorpus;
  useEffect(() => {
    if (!active || !setCorpus || surfaceName !== "diff") return;
    const oldRows: { n: number; text: string }[] = [];
    const newRows: { n: number; text: string }[] = [];
    for (const h of hunks) {
      for (const l of h.lines) {
        if (l.oldLineNumber != null && l.type !== "added") oldRows.push({ n: l.oldLineNumber, text: l.content });
        if (l.newLineNumber != null && l.type !== "removed") newRows.push({ n: l.newLineNumber, text: l.content });
      }
    }
    setCorpus({ oldRows, newRows });
    return () => setCorpus(null);
  }, [active, setCorpus, hunks, surfaceName]);

  const onPlus = useCallback(
    (plus: HTMLElement) => {
      const row = plus.closest<HTMLElement>(".diff-line");
      const anchor = row && cs ? cs.describeRowEl(row) : null;
      if (anchor && cs) cs.openNew(anchor, { returnFocus: plus });
    },
    [cs],
  );

  return useMemo(() => {
    if (!cs || !view) return null;
    const draft = cs.draft?.surface === surfaceName ? cs.draft : null;
    const draftSpan = draft ? commentSpan(draft) : null;
    const hasKey = (keys: Array<{ side: RowSide; n: number }>, pick: (n: number) => boolean) =>
      !!draftSpan && keys.some((k) => k.side === draftSpan.side && pick(k.n));
    const inlineCache = new WeakMap<readonly DiffLine[], Array<ReviewComment[] | undefined>>();
    return {
      surface: cs,
      view,
      countInHunk: (hunk) => {
        let n = 0;
        const seen = new Set<string>();
        for (const l of hunk.lines) {
          for (const k of diffRowKeys(l, true)) {
            for (const c of view.ends.get(rowKey(k.side, k.n)) ?? []) {
              if (!seen.has(c.id)) {
                seen.add(c.id);
                n += 1;
              }
            }
          }
        }
        return n;
      },
      covers: (keys) => merge(view.covers, keys),
      pins: (keys) => merge(view.ends, keys),
      marks: (keys, text) => {
        const d = draft && draftSpan && keys.some((k) => k.side === draftSpan.side && draftSpan.start <= k.n && k.n <= draftSpan.end);
        return keys.flatMap((k) => {
          const base = view.covers.get(rowKey(k.side, k.n));
          return rowMarks(d && draft && draftSpan?.side === k.side ? [...(base ?? []), draft] : base, text, k.n);
        });
      },
      inlineCovers: (lines) => {
        const hit = inlineCache.get(lines);
        if (hit) return hit;
        const index = new Map<string, number>();
        lines.forEach((l, i) => diffRowKeys(l, true).forEach((k) => index.set(rowKey(k.side, k.n), i)));
        const out: Array<ReviewComment[] | undefined> = new Array(lines.length).fill(undefined);
        for (const c of view.list) {
          const span = commentSpan(c);
          if (!span) continue;
          const a = index.get(rowKey(span.side, span.start));
          const b = index.get(rowKey(span.side, span.end));
          if (a == null || b == null) continue;
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) (out[i] ??= []).push(c);
        }
        inlineCache.set(lines, out);
        return out;
      },
      draftFor: (keys) => (draft && draftSpan && hasKey(keys, (n) => draftSpan.start <= n && n <= draftSpan.end) ? draft : undefined),
      draftEndsAt: (keys) => (draft && hasKey(keys, (n) => n === draftSpan!.end) ? draft : undefined),
      gapCommented: (gap) =>
        view.list.some((c) => {
          const span = commentSpan(c);
          if (!span) return false;
          const lo = span.side === "old" ? gap.startLine + gap.oldOffset : gap.startLine;
          const hi = span.side === "old" ? gap.endLine + gap.oldOffset : gap.endLine;
          return span.start <= hi && span.end >= lo;
        }),
      activeId: cs.activeId,
      measurer: cs.pinMeasurer,
      onPlus,
      onPinOpen: focusCommentCard,
    };
  }, [cs, view, onPlus, surfaceName]);
}
