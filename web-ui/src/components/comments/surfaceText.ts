/**
 * One text corpus for a comment surface, shared by the anchor pass (`describeMarkdown`), the highlight pass
 * (`rehypeCommentMarks`) and the pin measurer. It is the concatenation of the DOM text nodes under an element,
 * skipping every subtree marked `data-comment-ignore` (UI chrome such as the code block header: "ts" / "Copy").
 */
export const COMMENT_IGNORE_ATTR = "data-comment-ignore";

/** Text nodes under `root` in document order, minus the ignored subtrees. */
export function surfaceTextNodes(root: Element): Text[] {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      return (n as Element).hasAttribute(COMMENT_IGNORE_ATTR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
    },
  });
  const out: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/** The text of `el` without ignored subtrees. */
export function surfaceText(el: Element): string {
  let s = "";
  for (const t of surfaceTextNodes(el)) s += t.data;
  return s;
}

/**
 * UTF-16 length of `surfaceText(el)` before the boundary `(node, offset)`. A boundary outside `el` clamps to
 * 0 (it precedes the element) or the full length (it follows it); one inside an ignored subtree counts the
 * text before that subtree.
 */
export function surfaceOffset(el: Element, node: Node, offset: number): number {
  const nodes = surfaceTextNodes(el);
  const total = nodes.reduce((n, t) => n + t.data.length, 0);
  if (node !== el && !el.contains(node)) {
    return el.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING ? 0 : total;
  }
  const boundary = el.ownerDocument.createRange();
  boundary.setStart(node, offset);
  boundary.collapse(true);
  let seen = 0;
  for (const t of nodes) {
    if (t === node) return seen + Math.min(offset, t.data.length);
    // `comparePoint(t, 0)` < 0: the start of `t` lies before the boundary; the boundary is not inside a Text
    // other than `node`, so the whole node precedes it.
    if (boundary.comparePoint(t, 0) < 0) seen += t.data.length;
    else break;
  }
  return seen;
}

export interface TextPos {
  node: Text;
  offset: number;
}

/**
 * The DOM position of character offset `at` of `surfaceText(el)`. `forward` picks the node that STARTS at a
 * node boundary (the first character of the next run); `backward` stays in the node that ENDS there (so the
 * end of a range stays in the character's own node). Null when `el` has no text.
 */
export function surfaceTextPos(el: Element, at: number, affinity: "forward" | "backward"): TextPos | null {
  const nodes = surfaceTextNodes(el);
  if (nodes.length === 0) return null;
  let seen = 0;
  for (const t of nodes) {
    const end = seen + t.data.length;
    if (affinity === "forward" ? at < end : at <= end && t.data.length > 0) {
      return { node: t, offset: Math.max(0, Math.min(at - seen, t.data.length)) };
    }
    seen = end;
  }
  const last = nodes[nodes.length - 1]!;
  return { node: last, offset: last.data.length };
}
