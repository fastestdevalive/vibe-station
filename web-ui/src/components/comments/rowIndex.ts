import type { CommentDiffScope, CommentSurface, ReviewComment } from "@/api/types";
import { DRAFT_ID } from "./draftComment";
import type { HtmlMarkRange } from "./markHtmlRanges";
import { MAX_QUOTE_BYTES, utf8Bytes } from "./reviewLimits";

export type RowSide = "old" | "new";

/** Row identity inside a surface: the side's own line number (non-diff surfaces are always `new`). */
export const rowKey = (side: RowSide, n: number): string => `${side}:${n}`;

export interface CommentSpan {
  side: RowSide;
  start: number;
  end: number;
}

/** Where a comment sits NOW: the re-anchored span if the daemon found one, else the last known span. */
export function commentSpan(c: Pick<ReviewComment, "surface" | "side" | "current" | "lineStart" | "lineEnd">): CommentSpan | null {
  const start = c.current?.start ?? c.lineStart;
  if (start == null) return null;
  const end = c.current?.end ?? c.lineEnd ?? start;
  return { side: c.surface === "diff" ? (c.side ?? "new") : "new", start, end: Math.max(start, end) };
}

export interface SurfaceComments {
  list: ReviewComment[];
  /** Comments whose LAST row is this one (their card, pin and Add row render after it). */
  ends: Map<string, ReviewComment[]>;
  /**
   * Every comment covering a row (row highlight + text marks). Answers `get(rowKey)` from the spans, so a span
   * of any length covers every one of its rows (no walk, no cap); results are memoised per row.
   */
  covers: { get: (key: string) => ReviewComment[] | undefined };
}

const NO_COVERS = { get: (): ReviewComment[] | undefined => undefined };
const EMPTY: SurfaceComments = { list: [], ends: new Map(), covers: NO_COVERS };

/** Does this comment belong on this surface (diff comments are scope-bound, R41)? */
export function onSurface(c: ReviewComment, surface: CommentSurface, diffScope?: CommentDiffScope): boolean {
  if (c.anchor === "file_missing") return false;
  if (c.surface !== surface) return false;
  return surface !== "diff" || c.diffScope === diffScope;
}

export function buildSurfaceComments(
  comments: readonly ReviewComment[],
  surface: CommentSurface,
  diffScope?: CommentDiffScope,
): SurfaceComments {
  const list = comments.filter((c) => onSurface(c, surface, diffScope));
  if (list.length === 0) return EMPTY;
  const ends = new Map<string, ReviewComment[]>();
  const spans: Array<{ c: ReviewComment; side: RowSide; start: number; end: number }> = [];
  for (const c of list) {
    const span = commentSpan(c);
    if (!span) continue;
    const k = rowKey(span.side, span.end);
    const arr = ends.get(k);
    if (arr) arr.push(c);
    else ends.set(k, [c]);
    spans.push({ c, ...span });
  }
  const cache = new Map<string, ReviewComment[] | undefined>();
  const covers = {
    get(key: string): ReviewComment[] | undefined {
      if (cache.has(key)) return cache.get(key);
      const at = key.indexOf(":");
      const side = key.slice(0, at);
      const n = Number(key.slice(at + 1));
      const hit = spans.filter((s) => s.side === side && s.start <= n && n <= s.end).map((s) => s.c);
      const out = hit.length ? hit : undefined;
      cache.set(key, out);
      return out;
    },
  };
  return { list, ends, covers };
}

/** The part of a comment the row mark pass needs (a real comment, or the open box's anchor). */
export type MarkSource = Pick<ReviewComment, "id" | "surface" | "side" | "current" | "lineStart" | "lineEnd" | "quote" | "anchor">;

/**
 * Column range of the quote inside one row, for the `<mark>` text highlight. The comment's LINE SPAN decides
 * which rows are marked; the quote only trims the first row (its tail) and the last row (its head), so every row
 * between them is marked in full even when the quote is truncated or the file uses CRLF. A trailing `\r` is not
 * part of the row. A blank row has nothing to mark (the row bar covers it). A single-line quote that is not in
 * the row any more (outdated / edited) marks the whole row. Null when the row is outside the span.
 */
export function rowMarkRange(c: MarkSource, rowTextRaw: string, rowN: number): { start: number; end: number } | null {
  const span = commentSpan(c);
  if (!span || rowN < span.start || rowN > span.end) return null;
  const row = rowTextRaw.replace(/\r$/, "");
  if (row.length === 0) return null;
  const q = c.quote.replace(/\r\n?/g, "\n").split("\n");
  if (span.start === span.end) {
    const at = q.length === 1 && q[0] ? row.indexOf(q[0]) : -1;
    return at >= 0 ? { start: at, end: at + q[0]!.length } : { start: 0, end: row.length };
  }
  const truncated = utf8Bytes(c.quote) >= MAX_QUOTE_BYTES - 4;
  let start = 0;
  let end = row.length;
  if (rowN === span.start && q[0] && row.endsWith(q[0])) start = row.length - q[0].length;
  if (rowN === span.end && !truncated) {
    const tail = q[q.length - 1];
    if (tail && row.startsWith(tail)) end = tail.length;
  }
  return start < end ? { start, end } : null;
}

/** Marks for one row from every comment covering it. */
export function rowMarks(comments: readonly MarkSource[] | undefined, rowText: string, rowN: number): HtmlMarkRange[] {
  if (!comments) return [];
  const out: HtmlMarkRange[] = [];
  for (const c of comments) {
    const r = rowMarkRange(c, rowText, rowN);
    if (r) out.push({ ...r, id: c.id, outdated: c.anchor === "outdated", draft: c.id === DRAFT_ID });
  }
  return out;
}

/** Quote is still in the file at the anchored span (false = the text changed while the box was open). */
export function quoteStillAt(
  a: { surface: CommentSurface; side?: RowSide; lineStart?: number; lineEnd?: number; quote: string; oldStart?: number },
  fileLines: readonly string[] | null,
): boolean {
  if (a.surface === "markdown" || !fileLines || a.lineStart == null || !a.quote) return true;
  if (a.surface === "diff" && (a.side === "old" || a.oldStart != null)) return true;
  const slice = fileLines.slice(a.lineStart - 1, a.lineEnd ?? a.lineStart).join("\n");
  return slice.includes(a.quote);
}
