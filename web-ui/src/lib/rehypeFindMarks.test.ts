import { describe, it, expect } from "vitest";
import { rehypeFindMarks, type HastNode } from "./rehypeFindMarks";

describe("rehypeFindMarks", () => {
  it("splits a match across token spans inside a code block into marks that share the occurrence key", () => {
    // Simulating highlight.js AST: <pre><code><span class="hljs-keyword">res</span><span class="hljs-title">ume</span> resume</code></pre>
    const span1: HastNode = {
      type: "element",
      tagName: "span",
      properties: { className: ["hljs-keyword"] },
      children: [{ type: "text", value: "res" }],
    };
    const span2: HastNode = {
      type: "element",
      tagName: "span",
      properties: { className: ["hljs-title"] },
      children: [{ type: "text", value: "ume" }],
    };
    const span3: HastNode = {
      type: "text",
      value: " resume",
    };
    const code: HastNode = {
      type: "element",
      tagName: "code",
      children: [span1, span2, span3],
    };
    const tree: HastNode = {
      type: "element",
      tagName: "pre",
      children: [code],
    };

    const plugin = rehypeFindMarks({ terms: ["resume"], keyPrefix: "test/0" });
    plugin()(tree);

    // Both pieces of ONE occurrence carry the same key, so the ordinal walk
    // in `messageNav` counts the occurrence once instead of once per token span.
    expect(span1.children).toHaveLength(1);
    const mark1 = span1.children![0]!;
    expect(mark1.tagName).toBe("mark");
    expect(mark1.properties?.className).toEqual(["find-hit"]);
    expect(mark1.properties?.dataFindKey).toBe("test/0:0");
    expect(mark1.children?.[0]?.value).toBe("res");

    expect(span2.children).toHaveLength(1);
    const mark2 = span2.children![0]!;
    expect(mark2.tagName).toBe("mark");
    expect(mark2.properties?.className).toEqual(["find-hit"]);
    expect(mark2.properties?.dataFindKey).toBe("test/0:0");
    expect(mark2.children?.[0]?.value).toBe("ume");

    // The NEXT occurrence gets the next key (consecutive per occurrence). The
    // third child was a bare text node, so it is split in place inside `code`.
    const mark3 = code.children!.find((c) => c.tagName === "mark");
    expect(mark3?.properties?.dataFindKey).toBe("test/0:1");
    expect(mark3?.children?.[0]?.value).toBe("resume");
  });

  it("produces no marks when corpus is missing one of the terms", () => {
    const tree: HastNode = {
      type: "element",
      tagName: "p",
      children: [{ type: "text", value: "The token has expired" }],
    };

    // Searching for "token" AND "refresh" — only "token" is present in corpus
    const plugin = rehypeFindMarks({ terms: ["token", "refresh"], keyPrefix: "test/1" });
    plugin()(tree);

    // Nothing marked, text node remains unchanged
    expect(tree.children).toHaveLength(1);
    expect(tree.children![0]!.type).toBe("text");
    expect(tree.children![0]!.value).toBe("The token has expired");
  });

  it("marks multiple matches with sequential keys in document order", () => {
    const tree: HastNode = {
      type: "element",
      tagName: "div",
      children: [
        {
          type: "element",
          tagName: "p",
          children: [{ type: "text", value: "First token here." }],
        },
        {
          type: "element",
          tagName: "p",
          children: [{ type: "text", value: "Second token here." }],
        },
      ],
    };

    const plugin = rehypeFindMarks({ terms: ["token"], keyPrefix: "hit" });
    plugin()(tree);

    const p1 = tree.children![0]!;
    const mark1 = p1.children!.find((c) => c.tagName === "mark");
    expect(mark1?.properties?.dataFindKey).toBe("hit:0");

    const p2 = tree.children![1]!;
    const mark2 = p2.children!.find((c) => c.tagName === "mark");
    expect(mark2?.properties?.dataFindKey).toBe("hit:1");
  });
});
