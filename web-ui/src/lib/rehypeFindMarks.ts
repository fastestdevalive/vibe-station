import { locate } from "./findTerms";

export interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
}

interface TextRef {
  node: HastNode;
  parent: HastNode;
  index: number;
  start: number;
}

const TABLE_PARENTS = new Set(["table", "thead", "tbody", "tfoot", "tr"]);

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

function textNode(value: string): HastNode {
  return { type: "text", value };
}

function markNode(key: string, child: HastNode): HastNode {
  return {
    type: "element",
    tagName: "mark",
    properties: {
      className: ["find-hit"],
      dataFindKey: key,
    },
    children: [child],
  };
}

export interface RehypeFindMarksOptions {
  terms: string[];
  keyPrefix: string;
}

/**
 * Rehype plugin: wraps each located term occurrence in `<mark class="find-hit" data-find-key="{keyPrefix}:{n}">`.
 * Skipped entirely when the corpus lacks any term.
 */
export function rehypeFindMarks(options: RehypeFindMarksOptions): () => (tree: HastNode) => void {
  return () => (tree) => {
    if (!options.terms || options.terms.length === 0) return;

    const { refs, corpus } = collectText(tree);
    if (!corpus || refs.length === 0) return;

    // Skipped entirely when the corpus lacks a term. `locate()` returns [] if any term is missing.
    const ranges = locate(corpus, options.terms);
    if (ranges.length === 0) return;

    // Pass 1: find slices for each TextRef in document order
    const slices = new Map<TextRef, Array<{ from: number; to: number }>>();
    for (const [start, end] of ranges) {
      for (const ref of refs) {
        const len = ref.node.value?.length ?? 0;
        const from = Math.max(start, ref.start) - ref.start;
        const to = Math.min(end, ref.start + len) - ref.start;
        if (to > from) {
          const list = slices.get(ref) ?? [];
          list.push({ from, to });
          slices.set(ref, list);
        }
      }
    }

    if (slices.size === 0) return;

    // Pass 2: split text nodes into plain text and <mark> elements
    const edits = new Map<HastNode, Array<{ index: number; replace: HastNode[] }>>();

    for (const ref of refs) {
      const list = slices.get(ref);
      if (!list || list.length === 0) continue;

      const value = ref.node.value ?? "";
      const cuts = [...new Set([0, value.length, ...list.flatMap((s) => [s.from, s.to])])].sort((a, b) => a - b);
      const pieces: HastNode[] = [];

      for (let i = 0; i + 1 < cuts.length; i++) {
        const a = cuts[i]!;
        const b = cuts[i + 1]!;
        if (a === b) continue;

        const isHit = list.some((s) => s.from <= a && b <= s.to);
        const sliceText = value.slice(a, b);

        if (isHit) {
          const absStart = ref.start + a;
          const absEnd = ref.start + b;
          const hitRangeIdx = ranges.findIndex(([rStart, rEnd]) => rStart <= absStart && absEnd <= rEnd);
          const key = `${options.keyPrefix}:${hitRangeIdx}`;
          pieces.push(markNode(key, textNode(sliceText)));
        } else {
          pieces.push(textNode(sliceText));
        }
      }

      const arr = edits.get(ref.parent) ?? [];
      arr.push({ index: ref.index, replace: pieces });
      edits.set(ref.parent, arr);
    }

    // Apply edits back to front per parent so indexes remain valid
    for (const [parent, list] of edits) {
      for (const e of list.sort((a, b) => b.index - a.index)) {
        parent.children!.splice(e.index, 1, ...e.replace);
      }
    }
  };
}
