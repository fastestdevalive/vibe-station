import { describe, expect, it } from "vitest";
import { describeCodeRow, describeSelection, quoteContextFromLines, quoteContextFromText, occurrenceAt, wholeLineContext, anchorLabel, CONTEXT_CHARS } from "./anchorGeometry";
import { MAX_QUOTE_BYTES, utf8Bytes } from "./reviewLimits";

const lines = (...t: string[]) => t.map((text, i) => ({ n: i + 1, text }));

describe("quoteContext (4.T1)", () => {
  it("single line: quote, prefix, suffix and occurrence 0", () => {
    const qc = quoteContextFromLines(lines("alpha beta gamma"), { n: 1, col: 6 }, { n: 1, col: 10 });
    expect(qc).toEqual({ quote: "beta", prefix: "alpha ", suffix: " gamma", occurrence: 0 });
  });

  it("multi line quote spans the joined corpus", () => {
    const qc = quoteContextFromLines(lines("one", "two", "three"), { n: 1, col: 1 }, { n: 3, col: 2 });
    expect(qc.quote).toBe("ne\ntwo\nth");
    expect(qc.prefix).toBe("o");
    expect(qc.suffix).toBe("ree");
  });

  it("duplicate quotes get the index of the one that was selected", () => {
    const corpus = "x foo y foo z foo";
    expect(quoteContextFromText(corpus, 8, 11).occurrence).toBe(1);
    expect(quoteContextFromText(corpus, 14, 17).occurrence).toBe(2);
    expect(occurrenceAt(corpus, "foo", 2)).toBe(0);
  });

  it("caps the quote at 2 KB of UTF-8 on a code point boundary", () => {
    const long = "é".repeat(2000); // 4000 bytes
    const qc = quoteContextFromText(long, 0, long.length);
    expect(utf8Bytes(qc.quote)).toBeLessThanOrEqual(MAX_QUOTE_BYTES);
    expect(qc.quote).toBe("é".repeat(1024));
    expect(qc.suffix.startsWith("é")).toBe(true);
  });

  it("limits prefix and suffix to 160 characters", () => {
    const corpus = `${"a".repeat(500)}Q${"b".repeat(500)}`;
    const qc = quoteContextFromText(corpus, 500, 501);
    expect(qc.prefix).toHaveLength(160);
    expect(qc.suffix).toHaveLength(160);
  });

  it("a whole-line anchor quotes the line", () => {
    expect(wholeLineContext(lines("a", "  b();"), 2).quote).toBe("  b();");
    expect(describeCodeRow(2, { root: document.body, surface: "file", fileLines: ["a", "  b();"] })).toMatchObject({
      surface: "file",
      lineStart: 2,
      lineEnd: 2,
      quote: "  b();",
    });
  });

  it("anchorLabel", () => {
    expect(anchorLabel({ surface: "diff", side: "new", lineStart: 129, lineEnd: 129 })).toBe("L129 · +");
    expect(anchorLabel({ surface: "diff", side: "old", lineStart: 3, lineEnd: 5 })).toBe("L3–5 · −");
    expect(anchorLabel({ surface: "file", lineStart: 7, lineEnd: 7 })).toBe("L7");
  });
});

function diffDom(sideBySide: boolean): HTMLElement {
  const root = document.createElement("div");
  const row = (side: "old" | "new", cls: string, o: number | null, n: number | null, text: string) =>
    `<div class="diff-line diff-line--${cls}" data-side="${side}"${o != null ? ` data-old-line="${o}"` : ""}${n != null && side === "new" ? ` data-line="${n}"` : ""}><span class="diff-gutter">${o ?? ""}</span><span class="diff-gutter">${n ?? ""}</span><span class="diff-marker">x</span><span class="diff-line-text">${text}</span></div>`;
  root.innerHTML = sideBySide
    ? `<div class="preview-diff-side-by-side"><div class="hunk">${row("old", "context", 10, 10, "keep")}${row("new", "context", 10, 10, "keep")}${row("old", "removed", 11, null, "gone line")}${row("new", "added", null, 11, "fresh line")}</div></div>`
    : `<pre class="preview-diff-root">${row("new", "context", 10, 10, "keep")}${row("old", "removed", 11, null, "gone line")}${row("new", "added", null, 11, "fresh line")}${row("new", "added", null, 12, "second add")}</pre>`;
  document.body.appendChild(root);
  return root;
}
const textNode = (el: Element) => el.querySelector(".diff-line-text")!.firstChild!;

describe("describeSelection on a diff (5.T3, 5.T11)", () => {
  it("across context, removed and added rows records old and new ranges (removed row has no data-line)", () => {
    const root = diffDom(false);
    const rows = root.querySelectorAll(".diff-line");
    const range = document.createRange();
    range.setStart(textNode(rows[0]!), 2);
    range.setEnd(textNode(rows[2]!), 5);
    const res = describeSelection(range, {
      root,
      surface: "diff",
      diffScope: "local",
      fileLines: Array.from({ length: 12 }, (_, i) => (i === 9 ? "keep" : i === 10 ? "fresh line" : `l${i}`)),
      oldRows: [
        { n: 10, text: "keep" },
        { n: 11, text: "gone line" },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.anchor.quote).toBe("ep\ngone line\nfresh");
    expect(res.anchor).toMatchObject({ surface: "diff", diffScope: "local", side: "new", oldStart: 10, oldEnd: 11, newStart: 10, newEnd: 11 });
    root.remove();
  });

  it("a selection inside only a removed row anchors to the old side with old numbers", () => {
    const root = diffDom(false);
    const row = root.querySelectorAll(".diff-line")[1]!;
    const range = document.createRange();
    range.setStart(textNode(row), 0);
    range.setEnd(textNode(row), 4);
    const res = describeSelection(range, { root, surface: "diff", diffScope: "branch", oldRows: [{ n: 11, text: "gone line" }] });
    expect(res.ok && res.anchor).toMatchObject({ side: "old", lineStart: 11, lineEnd: 11, oldStart: 11, quote: "gone" });
    expect(res.ok && res.anchor.newStart).toBeUndefined();
    root.remove();
  });

  it("side-by-side: a selection with endpoints in different columns is rejected", () => {
    const root = diffDom(true);
    const rows = root.querySelectorAll(".diff-line");
    const range = document.createRange();
    range.setStart(textNode(rows[2]!), 1); // left (old) removed
    range.setEnd(textNode(rows[3]!), 3); // right (new) added
    const res = describeSelection(range, { root, surface: "diff", diffScope: "local" });
    expect(res).toEqual({ ok: false, reason: "mixed_side" });
    root.remove();
  });

  it("side-by-side: a left-cell selection records the old side and old line numbers", () => {
    const root = diffDom(true);
    const left = root.querySelectorAll(".diff-line")[2]!;
    const range = document.createRange();
    range.setStart(textNode(left), 0);
    range.setEnd(textNode(left), 4);
    const res = describeSelection(range, { root, surface: "diff", diffScope: "local", oldRows: [{ n: 11, text: "gone line" }] });
    expect(res.ok && res.anchor).toMatchObject({ side: "old", lineStart: 11, lineEnd: 11, oldStart: 11, oldEnd: 11 });
    root.remove();
  });

  it("a collapsed range and a range outside the surface are rejected", () => {
    const root = diffDom(false);
    const r = document.createRange();
    r.setStart(textNode(root.querySelector(".diff-line")!), 1);
    expect(describeSelection(r, { root, surface: "diff" })).toEqual({ ok: false, reason: "empty" });
    const outside = document.createElement("p");
    outside.textContent = "zzz";
    document.body.appendChild(outside);
    const r2 = document.createRange();
    r2.selectNodeContents(outside);
    expect(describeSelection(r2, { root, surface: "diff" })).toEqual({ ok: false, reason: "outside" });
    root.remove();
    outside.remove();
  });
});

describe("describeSelection on code and markdown", () => {
  it("code: maps line + column from .workspace-code-line rows", () => {
    const root = document.createElement("pre");
    root.innerHTML = `<div class="workspace-code-line" data-line="1"><span class="workspace-code-gutter">1</span><span class="workspace-code-content">const a = 1;</span></div><div class="workspace-code-line" data-line="2"><span class="workspace-code-gutter">2</span><span class="workspace-code-content">const b = 2;</span></div>`;
    document.body.appendChild(root);
    const t = root.querySelectorAll(".workspace-code-content");
    const range = document.createRange();
    range.setStart(t[0]!.firstChild!, 6);
    range.setEnd(t[1]!.firstChild!, 7);
    const res = describeSelection(range, { root, surface: "file", fileLines: ["const a = 1;", "const b = 2;"] });
    expect(res.ok && res.anchor).toMatchObject({ surface: "file", lineStart: 1, lineEnd: 2, quote: "a = 1;\nconst b" });
    root.remove();
  });

  it("markdown: block range from data-sl/data-el, quote is the selected text", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div class="workspace-markdown-preview"><p data-sl="3" data-el="4">soft wrapped paragraph text</p><p data-sl="6" data-el="6">second block</p></div>`;
    document.body.appendChild(root);
    const ps = root.querySelectorAll("p");
    const range = document.createRange();
    range.setStart(ps[0]!.firstChild!, 5);
    range.setEnd(ps[0]!.firstChild!, 12);
    const res = describeSelection(range, { root, surface: "markdown" });
    expect(res.ok && res.anchor).toMatchObject({ surface: "markdown", lineStart: 3, lineEnd: 4, quote: "wrapped" });
    const across = document.createRange();
    across.setStart(ps[0]!.firstChild!, 5);
    across.setEnd(ps[1]!.firstChild!, 6);
    const res2 = describeSelection(across, { root, surface: "markdown" });
    expect(res2.ok && res2.anchor).toMatchObject({ lineStart: 3, lineEnd: 6 });
    root.remove();
  });

  describe("markdown: whitespace around a block selection (triple-click shape)", () => {
    const setup = () => {
      const root = document.createElement("div");
      root.innerHTML = `<div class="workspace-markdown-preview"><ul><li data-sl="9" data-el="9">Markdown-first authoring</li>\n<li data-sl="10" data-el="10">Version-controlled</li></ul></div>`;
      document.body.appendChild(root);
      return { root, lis: root.querySelectorAll("li") };
    };

    it("range ending at offset 0 of the next <li> anchors to the first item only", () => {
      const { root, lis } = setup();
      const range = document.createRange();
      range.setStart(lis[0]!.firstChild!, 0);
      range.setEnd(lis[1]!.firstChild!, 0);
      const res = describeSelection(range, { root, surface: "markdown" });
      expect(res.ok && res.anchor).toMatchObject({ lineStart: 9, lineEnd: 9, quote: "Markdown-first authoring" });
      expect(res.ok && res.endEl).toBe(lis[0]);
      root.remove();
    });

    it("range ending in the newline text node between the <li>s anchors to the first item only", () => {
      const { root, lis } = setup();
      const range = document.createRange();
      range.setStart(lis[0]!.firstChild!, 0);
      range.setEnd(lis[0]!.nextSibling!, 1);
      const res = describeSelection(range, { root, surface: "markdown" });
      expect(res.ok && res.anchor).toMatchObject({ lineStart: 9, lineEnd: 9, quote: "Markdown-first authoring" });
      expect(res.ok && res.endEl).toBe(lis[0]);
      root.remove();
    });
  });
});

describe("quoteContext surrogate safety (review 6)", () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  it("a context cut through an emoji never leaves a lone surrogate (prefix and suffix)", () => {
    // prefix window starts exactly between the emoji's two code units
    const before = "😀" + "a".repeat(CONTEXT_CHARS - 1);
    const after = "b".repeat(CONTEXT_CHARS - 1) + "😀";
    const corpus = `${before}QUOTE${after}tail`;
    const start = before.length;
    const qc = quoteContextFromText(corpus, start, start + 5);
    expect(qc.quote).toBe("QUOTE");
    expect(lone.test(qc.prefix)).toBe(false);
    expect(lone.test(qc.suffix)).toBe(false);
    expect(() => JSON.parse(JSON.stringify(qc))).not.toThrow();
    expect(qc.prefix.length).toBe(CONTEXT_CHARS - 1);
    expect(qc.suffix.length).toBe(CONTEXT_CHARS - 1);
  });
});
