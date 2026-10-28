import type { CommentSurface } from "@/api/types";
import { MAX_QUOTE_BYTES, truncateUtf8, utf8Bytes } from "./reviewLimits";
import { surfaceOffset, surfaceText, surfaceTextPos } from "./surfaceText";
import type { CommentAnchor, LineText } from "./types";

/** How much text before / after the quote is stored (matches the daemon's 160-char cap). */
export const CONTEXT_CHARS = 160;

export interface QuoteContext {
  quote: string;
  prefix: string;
  suffix: string;
  occurrence: number;
}

/** A position inside a line corpus: line number on its side + UTF-16 column in that line's text. */
export interface LinePoint {
  n: number;
  col: number;
}

function joinLines(lines: readonly LineText[]): { text: string; starts: number[] } {
  const starts: number[] = [];
  let at = 0;
  for (const l of lines) {
    starts.push(at);
    at += l.text.length + 1;
  }
  return { text: lines.map((l) => l.text).join("\n"), starts };
}

/** Offset of `point` in the joined corpus, or -1 when the line is not part of it. */
function offsetOf(lines: readonly LineText[], starts: readonly number[], point: LinePoint): number {
  const i = lines.findIndex((l) => l.n === point.n);
  if (i < 0) return -1;
  return starts[i]! + Math.min(point.col, lines[i]!.text.length);
}

/** Index of the `quote` match starting at `at` among all non-overlapping matches in `corpus`. */
export function occurrenceAt(corpus: string, quote: string, at: number): number {
  if (!quote) return 0;
  let n = 0;
  for (let i = corpus.indexOf(quote); i !== -1 && i < at; i = corpus.indexOf(quote, i + quote.length)) n += 1;
  return n;
}

/** Drop a leading low / trailing high surrogate: a cut through an emoji would serialise as invalid JSON (the daemon 400s). */
function wholeCodePoints(s: string, side: "prefix" | "suffix"): string {
  return side === "prefix" ? s.replace(/^[\uDC00-\uDFFF]/, "") : s.replace(/[\uD800-\uDBFF]$/, "");
}

/**
 * Quote + context for the selected text `[start, end)` of `corpus`. The quote is capped at 2 KB of UTF-8 (the
 * daemon rejects more), cut on a code-point boundary; `occurrence` counts the identical matches before it so a
 * duplicate quote re-anchors to the right one.
 */
export function quoteContextFromText(corpus: string, start: number, end: number, selected?: string): QuoteContext {
  const os = Math.max(0, Math.min(start, corpus.length));
  const oe = Math.max(os, Math.min(end, corpus.length));
  const raw = selected ?? corpus.slice(os, oe);
  const quote = wholeCodePoints(wholeCodePoints(truncateUtf8(raw, MAX_QUOTE_BYTES), "prefix"), "suffix");
  const matched = corpus.slice(os, os + quote.length) === quote;
  const qEnd = matched ? os + quote.length : oe;
  return {
    quote,
    prefix: wholeCodePoints(corpus.slice(Math.max(0, os - CONTEXT_CHARS), os), "prefix"),
    suffix: wholeCodePoints(corpus.slice(qEnd, qEnd + CONTEXT_CHARS), "suffix"),
    occurrence: matched ? occurrenceAt(corpus, quote, os) : 0,
  };
}

/**
 * Quote + context between two line points of a line corpus. `selected` is the text the user actually
 * selected when it differs from a plain corpus slice (an inline selection across removed and added rows);
 * then the context is taken around the anchored side and `occurrence` falls back to 0.
 */
export function quoteContextFromLines(
  lines: readonly LineText[],
  from: LinePoint,
  to: LinePoint,
  selected?: string,
): QuoteContext {
  const { text, starts } = joinLines(lines);
  const os = offsetOf(lines, starts, from);
  const oe = offsetOf(lines, starts, to);
  if (os < 0 || oe < 0) {
    const quote = truncateUtf8(selected ?? "", MAX_QUOTE_BYTES);
    return { quote, prefix: "", suffix: "", occurrence: 0 };
  }
  return quoteContextFromText(text, os, oe, selected);
}

/** Whole-line anchor (the gutter `+`): the line's own text is the quote. */
export function wholeLineContext(lines: readonly LineText[], n: number): QuoteContext {
  const line = lines.find((l) => l.n === n);
  if (!line) return { quote: "", prefix: "", suffix: "", occurrence: 0 };
  return quoteContextFromLines(lines, { n, col: 0 }, { n, col: line.text.length });
}

/** `[min, max]` of the defined values, or undefined when none. */
function span(values: Array<number | null>): { start: number; end: number } | undefined {
  const v = values.filter((x): x is number => x != null);
  return v.length ? { start: Math.min(...v), end: Math.max(...v) } : undefined;
}

// ── DOM mapping ────────────────────────────────────────────────────────────────

export type SelectionResult =
  | { ok: true; anchor: CommentAnchor; /** Last row / block the selection touches (the comment row goes after it). */ endEl: HTMLElement | null }
  | { ok: false; reason: "empty" | "outside" | "mixed_side" | "unsupported" };

export interface DescribeContext {
  /** The `[data-comment-surface]` element (`.preview-body`). */
  root: HTMLElement;
  /** `diff` for the diff views; `file` / `html-source` for the code view; `markdown` for rendered markdown. */
  surface: CommentSurface;
  diffScope?: CommentAnchor["diffScope"];
  baseSha?: string;
  /** Full text lines of the file as it is now (code view, and the diff's new side). */
  fileLines?: readonly string[];
  /** Diff rows' new-side text (used when the full file is unavailable). */
  newRows?: readonly LineText[];
  /** Diff rows' old-side text (hunk context + removed rows). */
  oldRows?: readonly LineText[];
}

const ROW_DIFF = ".diff-line[data-side]";
const ROW_CODE = ".workspace-code-line[data-line]";

function contains(el: Node, node: Node): boolean {
  return el === node || el.contains(node);
}

/** UTF-16 length of the text of `el` before the boundary `(node, offset)`. */
export function textOffsetIn(el: Element, node: Node, offset: number): number {
  if (!contains(el, node)) {
    const pos = el.compareDocumentPosition(node);
    return pos & Node.DOCUMENT_POSITION_PRECEDING ? 0 : (el.textContent ?? "").length;
  }
  const r = el.ownerDocument.createRange();
  r.selectNodeContents(el);
  r.setEnd(node, offset);
  return r.toString().length;
}

const num = (el: Element, attr: string): number | null => {
  const v = el.getAttribute(attr);
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function diffRowText(row: HTMLElement): HTMLElement | null {
  return row.querySelector<HTMLElement>(".diff-line-text");
}

function sideOfRow(row: Element): "old" | "new" {
  return row.getAttribute("data-side") === "old" ? "old" : "new";
}

function closestRow(node: Node | null, root: HTMLElement, selector: string): HTMLElement | null {
  const el = node instanceof Element ? node : node?.parentElement;
  const row = el?.closest<HTMLElement>(selector) ?? null;
  return row && root.contains(row) ? row : null;
}

function describeDiff(range: Range, ctx: DescribeContext): SelectionResult {
  const all = [...ctx.root.querySelectorAll<HTMLElement>(ROW_DIFF)].filter((r) => !r.classList.contains("diff-line--empty"));
  const hit = all.filter((r) => range.intersectsNode(r));
  if (hit.length === 0) return { ok: false, reason: "outside" };
  const sideBySide = ctx.root.querySelector(".preview-diff-side-by-side") != null;

  let rows = hit;
  if (sideBySide) {
    // Nothing clamps a native drag, so reject a selection whose endpoints sit in different columns (D1).
    const a = closestRow(range.startContainer, ctx.root, ROW_DIFF);
    const b = closestRow(range.endContainer, ctx.root, ROW_DIFF);
    if (a && b && sideOfRow(a) !== sideOfRow(b)) return { ok: false, reason: "mixed_side" };
    const side = sideOfRow(a ?? b ?? hit[0]!);
    rows = hit.filter((r) => sideOfRow(r) === side);
    if (rows.length === 0) return { ok: false, reason: "outside" };
  }

  const texts = rows.map((r) => diffRowText(r)?.textContent ?? "");
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  let c1 = textOffsetIn(diffRowText(first) ?? first, range.startContainer, range.startOffset);
  let c2 = textOffsetIn(diffRowText(last) ?? last, range.endContainer, range.endOffset);
  // A triple-click ends at column 0 of the NEXT row, and a drag can start at the end of a row: those rows
  // hold none of the selection.
  while (rows.length > 1 && c2 === 0) {
    rows = rows.slice(0, -1);
    texts.pop();
    c2 = texts[texts.length - 1]!.length;
  }
  while (rows.length > 1 && c1 >= texts[0]!.length) {
    rows = rows.slice(1);
    texts.shift();
    c1 = 0;
  }
  const lastIdx = rows.length - 1;
  const parts = texts.map((t, i) => t.slice(i === 0 ? c1 : 0, i === lastIdx ? c2 : t.length));
  const selected = parts.join("\n");
  if (!selected.trim()) return { ok: false, reason: "empty" };

  const oldNs = rows.map((r) => num(r, "data-old-line"));
  const newNs = rows.map((r) => num(r, "data-line"));
  const oldSpan = span(oldNs);
  const newSpan = span(newNs);
  const side = sideOfRow(rows[0]!);
  const sideSpan = side === "old" ? oldSpan : newSpan;
  if (!sideSpan) return { ok: false, reason: "unsupported" };

  // Context around the anchored side's own rows.
  const sideN = side === "old" ? oldNs : newNs;
  const firstIdx = sideN.findIndex((n) => n != null);
  let lastIdxSide = -1;
  sideN.forEach((n, i) => {
    if (n != null) lastIdxSide = i;
  });
  const corpus = diffCorpus(side, ctx);
  const from: LinePoint = { n: sideN[firstIdx]!, col: firstIdx === 0 ? c1 : 0 };
  const to: LinePoint = { n: sideN[lastIdxSide]!, col: lastIdxSide === lastIdx ? c2 : texts[lastIdxSide]!.length };
  const sideOnly = sideN.every((n) => n != null);
  const qc = quoteContextFromLines(corpus, from, to, sideOnly ? undefined : selected);
  return {
    ok: true,
    endEl: last,
    anchor: {
      surface: "diff",
      diffScope: ctx.diffScope,
      baseSha: ctx.baseSha,
      side,
      lineStart: sideSpan.start,
      lineEnd: sideSpan.end,
      ...(oldSpan ? { oldStart: oldSpan.start, oldEnd: oldSpan.end } : {}),
      ...(newSpan ? { newStart: newSpan.start, newEnd: newSpan.end } : {}),
      ...qc,
    },
  };
}

function diffCorpus(side: "old" | "new", ctx: DescribeContext): readonly LineText[] {
  if (side === "old") return ctx.oldRows ?? [];
  if (ctx.fileLines) return ctx.fileLines.map((text, i) => ({ n: i + 1, text }));
  return ctx.newRows ?? [];
}

/** Resolve a range boundary to a code line + column (the line is the row the boundary sits in or next to). */
function codePoint(node: Node, offset: number, root: HTMLElement, lines: readonly string[]): LinePoint | null {
  const row = closestRow(node, root, ROW_CODE);
  if (row) {
    const n = num(row, "data-line")!;
    const content = row.querySelector<HTMLElement>(".workspace-code-content") ?? row;
    return { n, col: Math.min(textOffsetIn(content, node, offset), lines[n - 1]?.length ?? 0) };
  }
  // Boundary on a container (`<pre>`, the virtual sizer): `offset` indexes a child that is, or holds, a row.
  if (node instanceof Element && root.contains(node)) {
    const rowIn = (child: Node | undefined, pick: "first" | "last"): HTMLElement | null => {
      if (!(child instanceof Element)) return null;
      if (child.matches(ROW_CODE)) return child as HTMLElement;
      const rows = child.querySelectorAll<HTMLElement>(ROW_CODE);
      return (pick === "first" ? rows[0] : rows[rows.length - 1]) ?? null;
    };
    const after = rowIn(node.childNodes[offset], "first");
    if (after) return { n: num(after, "data-line")!, col: 0 };
    const before = rowIn(node.childNodes[offset - 1], "last");
    if (before) {
      const n = num(before, "data-line")!;
      return { n, col: lines[n - 1]?.length ?? 0 };
    }
  }
  return null;
}

function describeCode(range: Range, ctx: DescribeContext): SelectionResult {
  const lines = ctx.fileLines;
  if (!lines) return { ok: false, reason: "unsupported" };
  const a = codePoint(range.startContainer, range.startOffset, ctx.root, lines);
  const b = codePoint(range.endContainer, range.endOffset, ctx.root, lines);
  if (!a || !b) return { ok: false, reason: "outside" };
  let from = a;
  let to = b;
  if (to.n < from.n || (to.n === from.n && to.col < from.col)) [from, to] = [to, from];
  // Selection ending at column 0 of the next line holds nothing of that line.
  if (to.col === 0 && to.n > from.n) to = { n: to.n - 1, col: lines[to.n - 2]?.length ?? 0 };
  const corpus = lines.map((text, i) => ({ n: i + 1, text }));
  const qc = quoteContextFromLines(corpus, from, to);
  if (!qc.quote.trim()) return { ok: false, reason: "empty" };
  const endEl = ctx.root.querySelector<HTMLElement>(`${ROW_CODE}[data-line="${to.n}"]`);
  return {
    ok: true,
    endEl,
    anchor: { surface: ctx.surface, lineStart: from.n, lineEnd: to.n, ...qc },
  };
}

/** Text node containing character `offset` of `el`'s comment text (null when out of range). */
function textPointAt(el: Element, offset: number): Text | null {
  if (offset < 0 || offset >= surfaceText(el).length) return null;
  return surfaceTextPos(el, offset, "forward")?.node ?? null;
}

function describeMarkdown(range: Range, ctx: DescribeContext): SelectionResult {
  const block = (node: Node): HTMLElement | null => {
    const el = node instanceof Element ? node : node.parentElement;
    const b = el?.closest<HTMLElement>("[data-sl]") ?? null;
    return b && ctx.root.contains(b) ? b : null;
  };
  // Corpus: the rendered text of the preview, so prefix / suffix / occurrence agree with the highlight pass.
  const startEl = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const preview = startEl?.closest<HTMLElement>(".workspace-markdown-preview") ?? ctx.root;
  // Offsets index the surface text (`surfaceText`: no `data-comment-ignore` chrome such as a code block's "ts" /
  // "Copy"), the same text `rehypeCommentMarks` searches. A triple-click range ends at offset 0 of the next block
  // (or in the "\n" between <li>s): anchor on the trimmed selection so surrounding whitespace picks neither the
  // block nor the quote.
  const corpus = surfaceText(preview);
  const s0 = surfaceOffset(preview, range.startContainer, range.startOffset);
  const e0 = Math.max(s0, surfaceOffset(preview, range.endContainer, range.endOffset));
  const raw = corpus.slice(s0, e0);
  const selected = raw.trim();
  if (!selected) return { ok: false, reason: "empty" };
  const lead = raw.length - raw.trimStart().length;
  const start = s0 + lead;
  const endOff = start + selected.length;
  const firstNode = textPointAt(preview, start);
  const lastNode = textPointAt(preview, endOff - 1);
  const a = (firstNode && block(firstNode)) ?? block(range.startContainer);
  const b = (lastNode && block(lastNode)) ?? block(range.endContainer);
  if (!a || !b) return { ok: false, reason: "outside" };
  const sl = (el: HTMLElement) => num(el, "data-sl");
  const el = (x: HTMLElement) => num(x, "data-el");
  const startLine = Math.min(sl(a) ?? Infinity, sl(b) ?? Infinity);
  const endLine = Math.max(el(a) ?? el(b) ?? 0, el(b) ?? el(a) ?? 0);
  if (!Number.isFinite(startLine) || endLine < startLine) return { ok: false, reason: "unsupported" };
  const qc = quoteContextFromText(corpus, start, endOff, selected);
  return {
    ok: true,
    endEl: b,
    anchor: { surface: "markdown", lineStart: startLine, lineEnd: endLine, ...qc },
  };
}

/**
 * Map a DOM `Range` inside a comment surface to an anchor. Returns `{ ok: false }` for an empty selection, one
 * outside the surface, or one that straddles the two columns of a side-by-side diff (R37, edge 49).
 */
export function describeSelection(range: Range, ctx: DescribeContext): SelectionResult {
  if (range.collapsed) return { ok: false, reason: "empty" };
  if (!contains(ctx.root, range.startContainer) || !contains(ctx.root, range.endContainer)) {
    return { ok: false, reason: "outside" };
  }
  switch (ctx.surface) {
    case "diff":
      return describeDiff(range, ctx);
    case "markdown":
      return describeMarkdown(range, ctx);
    default:
      return describeCode(range, ctx);
  }
}

/** Whole-line anchor for a gutter `+` on a diff row. */
export function describeDiffRow(row: HTMLElement, ctx: DescribeContext): CommentAnchor | null {
  const side = sideOfRow(row);
  const n = num(row, side === "old" ? "data-old-line" : "data-line");
  if (n == null) return null;
  const oldN = num(row, "data-old-line");
  const newN = num(row, "data-line");
  const text = diffRowText(row)?.textContent ?? "";
  const corpus = diffCorpus(side, ctx);
  const qc = corpus.some((l) => l.n === n) ? wholeLineContext(corpus, n) : { quote: truncateUtf8(text, MAX_QUOTE_BYTES), prefix: "", suffix: "", occurrence: 0 };
  return {
    surface: "diff",
    diffScope: ctx.diffScope,
    baseSha: ctx.baseSha,
    side,
    lineStart: n,
    lineEnd: n,
    ...(oldN != null ? { oldStart: oldN, oldEnd: oldN } : {}),
    ...(newN != null ? { newStart: newN, newEnd: newN } : {}),
    ...qc,
  };
}

/** Whole-line anchor for a gutter `+` on a code line. */
export function describeCodeRow(n: number, ctx: DescribeContext): CommentAnchor | null {
  const lines = ctx.fileLines;
  if (!lines || n < 1 || n > lines.length) return null;
  const qc = wholeLineContext(
    lines.map((text, i) => ({ n: i + 1, text })),
    n,
  );
  return { surface: ctx.surface, lineStart: n, lineEnd: n, ...qc };
}

/** Header label of the box: `L129 · +` / `L12–14 · −` (spec: quote header `L129 · +  <first line>`). */
export function anchorLabel(a: Pick<CommentAnchor, "surface" | "side" | "lineStart" | "lineEnd" | "oldStart" | "newStart" | "newEnd" | "oldEnd">): string {
  const lines =
    a.lineStart == null
      ? ""
      : a.lineEnd != null && a.lineEnd !== a.lineStart
        ? `L${a.lineStart}–${a.lineEnd}`
        : `L${a.lineStart}`;
  if (a.surface !== "diff") return lines;
  const mark = a.side === "old" ? "−" : "+";
  return lines ? `${lines} · ${mark}` : mark;
}
