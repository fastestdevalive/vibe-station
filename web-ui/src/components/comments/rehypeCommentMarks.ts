import type { ReviewComment } from "@/api/types";
import { DRAFT_ID } from "./draftComment";
import { locateQuote } from "./locateQuote";
import type { HastNode } from "./rehypeSourceLines";

export interface MarkComment {
  comment: ReviewComment;
}

interface TextRef {
  node: HastNode;
  parent: HastNode;
  index: number;
  start: number;
}

const text = (value: string): HastNode => ({ type: "text", value });

/** The `<mark>` element wrapping `children` (one comment's share of a text run). */
function mark(c: ReviewComment, children: HastNode[], end: boolean): HastNode {
  const cls = ["comment-hl"];
  if (c.anchor === "outdated") cls.push("comment-hl--outdated");
  if (c.id === DRAFT_ID) cls.push("comment-hl--draft");
  return {
    type: "element",
    tagName: "mark",
    properties: { className: cls, dataCommentId: c.id, ...(end ? { dataCommentEnd: "" } : {}) },
    children,
  };
}

/** react-markdown drops whitespace-only text directly inside table sections; the DOM corpus never has it. */
const TABLE_PARENTS = new Set(["table", "thead", "tbody", "tfoot", "tr"]);

/** Text of the rendered hast, in the order and with the whitespace rule of `surfaceText` over the rendered DOM. */
function collectText(root: HastNode): { refs: TextRef[]; corpus: string } {
  const refs: TextRef[] = [];
  let corpus = "";
  const walk = (parent: HastNode) => {
    parent.children?.forEach((child, index) => {
      if (child.type === "text") {
        const value = child.value ?? "";
        if (TABLE_PARENTS.has(parent.tagName ?? "") && value.trim() === "") return;
        refs.push({ node: child, parent, index, start: corpus.length });
        corpus += value;
      } else if (child.type === "element") {
        walk(child);
      }
    });
  };
  walk(root);
  return { refs, corpus };
}

/** Block whose source span contains `line` (innermost wins), for pins whose quote is gone. */
function blockAtLine(root: HastNode, line: number, offset: number): HastNode | null {
  let best: HastNode | null = null;
  const walk = (n: HastNode) => {
    const p = n.position;
    if (n.type === "element" && p && p.start.line + offset <= line && line <= p.end.line + offset) {
      if (["p", "li", "td", "th", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote"].includes(n.tagName ?? "")) best = n;
    }
    n.children?.forEach(walk);
  };
  walk(root);
  return best;
}

/**
 * Rehype plugin: highlight each comment's quote in rendered markdown with `<mark data-comment-id>`. Works on the
 * hast, so React owns the result (no post-hoc DOM wrapping). A quote that spans bold or links becomes one mark per
 * text run; overlapping quotes NEST (lowest pin outermost), so every comment owns marks over its whole quote.
 * The LAST mark of each comment carries `data-comment-end` (the pin measurer lines the gutter pin up with it).
 * A quote that is no longer found (outdated) marks nothing: the block that held its last known line gets
 * `data-comment-fallback="<id> ..."` instead. Pins themselves are not part of the hast.
 */
export function rehypeCommentMarks(options: { comments: readonly MarkComment[]; startLine: number }): () => (tree: HastNode) => void {
  return () => (tree) => {
    if (options.comments.length === 0) return;
    const { refs, corpus } = collectText(tree);
    // Edits per parent are applied back to front so earlier indexes stay valid.
    const edits = new Map<HastNode, Array<{ index: number; replace: HastNode[] }>>();

    // Pass 1: which comments mark which slices of which text nodes.
    const slices = new Map<TextRef, Array<{ from: number; to: number; c: MarkComment }>>();
    const lastRefOf = new Map<string, TextRef>();
    const unplaced: MarkComment[] = [];
    for (const mc of options.comments) {
      const c = mc.comment;
      if (c.surface !== "markdown" || c.anchor === "file_missing") continue;
      const hit = locateQuote(corpus, c);
      if (!hit) {
        unplaced.push(mc);
        continue;
      }
      let lastRef: TextRef | null = null;
      for (const ref of refs) {
        const len = ref.node.value?.length ?? 0;
        const from = Math.max(hit.start, ref.start) - ref.start;
        const to = Math.min(hit.end, ref.start + len) - ref.start;
        // A whitespace-only run (e.g. the "\n" between two <li>s) is never marked.
        if (to > from && ref.node.value!.slice(from, to).trim() !== "") {
          const list = slices.get(ref) ?? [];
          list.push({ from, to, c: mc });
          slices.set(ref, list);
          lastRef = ref;
        }
      }
      if (lastRef) lastRefOf.set(c.id, lastRef);
      else unplaced.push(mc);
    }

    // Pass 2: split text nodes. Overlapping quotes nest, the lowest pin outermost.
    for (const [ref, list] of slices) {
      const value = ref.node.value ?? "";
      const cuts = [...new Set([0, value.length, ...list.flatMap((s) => [s.from, s.to])])].sort((a, b) => a - b);
      const pieces: HastNode[] = [];
      for (let i = 0; i + 1 < cuts.length; i++) {
        const a = cuts[i]!;
        const b = cuts[i + 1]!;
        const active = list.filter((s) => s.from <= a && b <= s.to).sort((x, y) => x.c.comment.pin - y.c.comment.pin);
        let node: HastNode = text(value.slice(a, b));
        for (let k = active.length - 1; k >= 0; k--) {
          const s = active[k]!;
          node = mark(s.c.comment, [node], lastRefOf.get(s.c.comment.id) === ref && b === s.to);
        }
        pieces.push(node);
      }
      const arr = edits.get(ref.parent) ?? [];
      arr.push({ index: ref.index, replace: pieces });
      edits.set(ref.parent, arr);
    }
    for (const [parent, list] of edits) {
      for (const e of list.sort((a, b) => b.index - a.index)) parent.children!.splice(e.index, 1, ...e.replace);
    }

    // Outdated / unplaced: the block that held the last known line is the pin's anchor; no highlight.
    for (const mc of unplaced) {
      const c = mc.comment;
      const line = c.current?.start ?? c.lineStart;
      if (line == null) continue;
      const block = blockAtLine(tree, line, options.startLine - 1);
      if (!block) continue;
      const prev = typeof block.properties?.dataCommentFallback === "string" ? `${block.properties.dataCommentFallback} ` : "";
      block.properties = { ...block.properties, dataCommentFallback: `${prev}${c.id}` };
    }
  };
}
