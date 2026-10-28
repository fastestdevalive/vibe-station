import type { Options } from "react-markdown";

type RehypePlugin = NonNullable<Options["rehypePlugins"]>[number];

/** Minimal hast shapes (the packages' types are not direct dependencies). */
export interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
  position?: { start: { line: number; column: number }; end: { line: number; column: number } };
}

/** Block elements that carry a source span (`p`, list items, table cells, code fences, headings, quotes). */
const BLOCKS = new Set(["p", "li", "td", "th", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote"]);

/**
 * Rehype plugin: write the ORIGINAL source line span of every block element as `data-sl` / `data-el`
 * (`node.position` line + `startLine - 1`; positions are relative to the segment react-markdown was given).
 * Opt-in on `MarkdownView` (chat bubbles share the component and must stay clean). A soft-wrapped paragraph is
 * ONE block, so a selection inside it anchors to the whole paragraph's span.
 */
export function rehypeSourceLines(options: { startLine: number }): () => (tree: HastNode) => void {
  const offset = options.startLine - 1;
  return () => {
    const walk = (node: HastNode): void => {
      if (node.type === "element" && node.tagName && BLOCKS.has(node.tagName) && node.position) {
        node.properties = {
          ...node.properties,
          dataSl: node.position.start.line + offset,
          dataEl: node.position.end.line + offset,
        };
      }
      for (const child of node.children ?? []) walk(child);
    };
    return walk;
  };
}

/** The structural plugin as react-markdown's own `rehypePlugins` entry type. */
export const asRehypePlugin = (p: () => (tree: HastNode) => void): RehypePlugin => p as unknown as RehypePlugin;
