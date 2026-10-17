import { describe, expect, it } from "vitest";
import { segmentMarkdown, segmentMarkdownWithMermaid } from "./mdSegments";

describe("segmentMarkdownWithMermaid", () => {
  it("returns a single markdown segment when there are no mermaid blocks", () => {
    const src = "# Hello\n\nJust prose.";
    expect(segmentMarkdownWithMermaid(src)).toEqual([{ type: "markdown", content: src }]);
  });

  it("splits a single mermaid block out of surrounding prose", () => {
    const src = "Before\n\n```mermaid\ngraph TD; A-->B\n```\n\nAfter";
    const segs = segmentMarkdownWithMermaid(src);
    expect(segs).toHaveLength(3);
    expect(segs[0]).toEqual({ type: "markdown", content: "Before\n\n" });
    expect(segs[1]).toEqual({ type: "mermaid", content: "graph TD; A-->B" });
    expect(segs[2]).toEqual({ type: "markdown", content: "\n\nAfter" });
  });

  it("handles multiple mermaid blocks in one document", () => {
    const src = "A\n\n```mermaid\ngraph TD; A-->B\n```\n\nB\n\n```mermaid\nflowchart LR; X-->Y\n```\n\nC";
    const segs = segmentMarkdownWithMermaid(src);
    expect(segs.filter((s) => s.type === "mermaid")).toHaveLength(2);
    expect(segs.filter((s) => s.type === "markdown")).toHaveLength(3);
  });

  it("does not confuse plain code fences with mermaid fences", () => {
    const src = "```ts\nconst x = 1;\n```\n\n```mermaid\ngraph TD; A-->B\n```";
    const segs = segmentMarkdownWithMermaid(src);
    expect(segs.filter((s) => s.type === "mermaid")).toHaveLength(1);
    expect(segs[0]).toEqual({ type: "markdown", content: "```ts\nconst x = 1;\n```\n\n" });
    expect(segs[1]).toEqual({ type: "mermaid", content: "graph TD; A-->B" });
  });

  it("finds a mermaid block in a plan file with YAML frontmatter, HTML comments, and other code blocks", () => {
    // Mirrors the structure of a real plan file (e.g. the storage-management plan
    // from the management-ui-option branch) that originally failed to render because
    // the parse() pre-check was too conservative.
    const src = [
      "---",
      "Issue: N/A",
      "Status: planning",
      "---",
      "",
      "<!--",
      "RULES — no prose",
      "-->",
      "",
      "## Change Map",
      "",
      "```",
      "daemon/src/routes/",
      "  worktrees.ts  ~ add guard",
      "```",
      "",
      "## Architecture Diagram",
      "",
      "```mermaid",
      "flowchart LR",
      '    subgraph Browser',
      '        StorageSetting --> ClientDisk[api.getDiskUsage]',
      '    end',
      '    subgraph Daemon',
      '        DiskRoute["GET /worktrees/disk-usage"]',
      '    end',
      '    ClientDisk --"GET /worktrees/disk-usage"--> DiskRoute',
      '    DeleteRoute --> Guard{agents=done, terminals=done|exited?}',
      '    Guard --"no"--> 409',
      '    Guard --"yes"--> Purge[worktreeRemove]',
      "```",
      "",
      "## Details",
      "",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n");

    const segs = segmentMarkdownWithMermaid(src);
    const mermaidSegs = segs.filter((s) => s.type === "mermaid");
    expect(mermaidSegs).toHaveLength(1);
    expect(mermaidSegs[0]?.content).toContain("flowchart LR");
    // The special characters that confused the old parse() pre-check are present.
    expect(mermaidSegs[0]?.content).toContain("terminals=done|exited?");
    expect(mermaidSegs[0]?.content).toContain('"GET /worktrees/disk-usage"');
  });

  it("trims whitespace from the mermaid block content", () => {
    const src = "```mermaid\n  graph TD; A-->B  \n```";
    const segs = segmentMarkdownWithMermaid(src);
    expect(segs[0]?.type).toBe("mermaid");
    expect(segs[0]?.content).toBe("graph TD; A-->B");
  });
});

describe("segmentMarkdown (4.T1)", () => {
  it("splits a closed html fence into an html segment with html:true", () => {
    const segs = segmentMarkdown("a\n```html\n<b>x</b>\n```\nb", { html: true });
    expect(segs).toHaveLength(3);
    expect(segs[0]).toEqual({ type: "markdown", content: "a\n" });
    expect(segs[1]).toEqual({ type: "html", content: "<b>x</b>" });
    expect(segs[2]).toEqual({ type: "markdown", content: "\nb" });
  });

  it("keeps html fences as plain markdown with html:false and via segmentMarkdownWithMermaid", () => {
    const src = "a\n```html\n<b>x</b>\n```\nb";
    const viaFalse = segmentMarkdown(src, { html: false });
    const viaWith = segmentMarkdownWithMermaid(src);
    expect(viaFalse).toEqual([{ type: "markdown", content: src }]);
    expect(viaWith).toEqual([{ type: "markdown", content: src }]);
  });

  it("keeps an unclosed html fence as one markdown segment with html:true", () => {
    const src = "a\n```html\n<b>x</b>";
    const segs = segmentMarkdown(src, { html: true });
    expect(segs).toEqual([{ type: "markdown", content: src }]);
  });

  it("mixes mermaid and html fences, preserving order", () => {
    const src = "```mermaid\ngraph TD; A-->B\n```\n\n```html\n<h1>x</h1>\n```";
    const segs = segmentMarkdown(src, { html: true });
    expect(segs).toHaveLength(3);
    expect(segs[0]).toEqual({ type: "mermaid", content: "graph TD; A-->B" });
    expect(segs[1]).toEqual({ type: "markdown", content: "\n\n" });
    expect(segs[2]).toEqual({ type: "html", content: "<h1>x</h1>" });
  });

  it("removes exactly one trailing newline from html content", () => {
    const segs = segmentMarkdown("```html\n<p>a</p>\n```", { html: true });
    expect(segs[0]).toEqual({ type: "html", content: "<p>a</p>" });
  });

  it("leaves an html fence nested in a longer outer fence as markdown", () => {
    const src = "````md\n```html\n<h1>x</h1>\n```\n````\nafter";
    const segs = segmentMarkdown(src, { html: true });
    expect(segs.every((g) => g.type === "markdown")).toBe(true);
  });

  it("does not treat an indented or mid-line html fence as a block", () => {
    expect(segmentMarkdown("text ```html\n<b>x</b>\n```", { html: true })).toHaveLength(1);
    expect(segmentMarkdown("  ```html\n<b>x</b>\n```", { html: true })[0]?.type).toBe("markdown");
  });

  it("still renders an indented / list-nested mermaid fence (legacy behaviour)", () => {
    const src = "1. Diagram:\n   ```mermaid\n   graph TD; A-->B\n   ```\n";
    for (const html of [false, true]) {
      const segs = segmentMarkdown(src, { html });
      expect(segs.map((g) => g.type)).toEqual(["markdown", "mermaid", "markdown"]);
    }
  });

  it("tracks outer fences per CommonMark: inline-code line and info-string closer don't confuse it", () => {
    const a = segmentMarkdown("```npm i x```\n\n```html\n<p>hi</p>\n```", { html: true });
    expect(a.map((g) => g.type)).toEqual(["markdown", "html"]);
    const b = segmentMarkdown("```\ncode\n```js\nmore\n```\n```html\n<p>hi</p>\n```", { html: true });
    expect(b.map((g) => g.type)).toEqual(["markdown", "html"]);
  });

  it("a mid-line-closed html block doesn't poison later html fences", () => {
    const src = "```html\n<p>a</p>```\n\n```html\n<p>b</p>\n```";
    const segs = segmentMarkdown(src, { html: true });
    expect(segs.filter((g) => g.type === "html")).toHaveLength(2);
  });

  it("segments a large many-fence message quickly", () => {
    const src = Array.from({ length: 300 }, (_, i) => "text " + i + "\n```html\n<p>" + i + "</p>\n```\n").join("");
    const t = performance.now();
    const segs = segmentMarkdown(src, { html: true });
    expect(segs.filter((g) => g.type === "html")).toHaveLength(300);
    expect(performance.now() - t).toBeLessThan(200);
  });

  it("does not close an html block at a mid-line ``` inside its content", () => {
    const src = "```html\n<pre>```js</pre>\n<p>b</p>\n```\nafter\n```html\n<p>c</p>\n```\n";
    const segs = segmentMarkdown(src, { html: true });
    expect(segs.map((g) => g.type)).toEqual(["html", "markdown", "html", "markdown"]);
    expect(segs[0]).toEqual({ type: "html", content: "<pre>```js</pre>\n<p>b</p>" });
    expect(segs[1]?.content).toBe("\nafter\n");
  });

  it("a closer with trailing text is not a closer", () => {
    const segs = segmentMarkdown("```html\n<p>a</p>\n``` trailing\n```\n", { html: true });
    expect(segs[0]).toEqual({ type: "html", content: "<p>a</p>\n``` trailing" });
  });

  it("tracks an outer fence opened before a mermaid block", () => {
    const src = "~~~\n```mermaid\ng\n```\n```html\n<p>a</p>\n```\n~~~";
    expect(segmentMarkdown(src, { html: true }).some((g) => g.type === "html")).toBe(false);
    const src2 = "````md\n```mermaid\ng\n```\n````\n```html\n<p>a</p>\n```\n";
    expect(segmentMarkdown(src2, { html: true }).some((g) => g.type === "html")).toBe(true);
  });

  it("handles CRLF sources (outer fence closer and html closer)", () => {
    const src = "```js\r\nx\r\n```\r\n```html\r\n<p>a</p>\r\n```\r\n";
    const segs = segmentMarkdown(src, { html: true });
    expect(segs.filter((g) => g.type === "html")).toEqual([{ type: "html", content: "<p>a</p>" }]);
  });

  it("html:false is identical to the pre-feature mermaid-only splitter (differential)", () => {
    const legacy = (source: string) => {
      const re = /```(mermaid)\n([\s\S]*?)```/g;
      const out: unknown[] = [];
      let last = 0;
      let m = re.exec(source);
      while (m !== null) {
        if (m.index > last) out.push({ type: "markdown", content: source.slice(last, m.index) });
        out.push({ type: "mermaid", content: (m[2] ?? "").trim() });
        last = m.index + m[0].length;
        m = re.exec(source);
      }
      if (last < source.length) out.push({ type: "markdown", content: source.slice(last) });
      if (out.length === 0) out.push({ type: "markdown", content: source });
      return out;
    };
    const atoms = ["```mermaid\n", "```html\n", "```", "\n", "x", " ", "~~~", "````", "  ", "g-->h"];
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 2000; i++) {
      let src = "";
      for (let j = Math.floor(rnd() * 14); j > 0; j--) src += atoms[Math.floor(rnd() * atoms.length)];
      expect(segmentMarkdown(src, { html: false })).toEqual(legacy(src));
      expect(segmentMarkdown(src, { html: true }).map((g) => g.content ?? "").join("").length).toBeGreaterThanOrEqual(0);
    }
  });

  it("stays linear on pathological input (many unclosed / rejected openers)", () => {
    const t = performance.now();
    segmentMarkdown("x```html\nfoo\n".repeat(20000), { html: true });
    segmentMarkdown("```html\nfoo\n".repeat(20000), { html: true });
    segmentMarkdown("```\n".repeat(20000) + "```html\n<p>a</p>\n```\n", { html: true });
    expect(performance.now() - t).toBeLessThan(1500);
  });

  it("stays linear on a very long backtick run inside an html block", () => {
    const t = performance.now();
    const segs = segmentMarkdown("```html\n" + "`".repeat(200_000) + "x", { html: true });
    expect(performance.now() - t).toBeLessThan(500);
    expect(segs.every((g) => g.type === "markdown")).toBe(true);
  });
});
