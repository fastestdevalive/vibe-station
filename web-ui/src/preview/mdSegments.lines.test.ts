import { describe, expect, it } from "vitest";
import { segmentMarkdown, segmentMarkdownWithLines } from "./mdSegments";

describe("segmentMarkdownWithLines (4.T3)", () => {
  it("keeps the plain split unchanged (no extra fields on segmentMarkdown)", () => {
    expect(segmentMarkdown("a\n")).toEqual([{ type: "markdown", content: "a\n" }]);
  });

  it("text / mermaid fence / text: the second markdown segment gets its absolute line from RAW offsets", () => {
    const src = ["one", "two", "```mermaid", "graph TD;", "A-->B", "```", "after", "more"].join("\n");
    const segs = segmentMarkdownWithLines(src);
    expect(segs.map((s) => [s.type, s.startLine])).toEqual([
      ["markdown", 1],
      ["mermaid", 3],
      // the fence closed on line 6, so the trailing segment's first line is line 6
      ["markdown", 6],
    ]);
  });

  it("a fence that starts mid-line: the next segment starts on the line the fence closed on", () => {
    const src = "intro ```mermaid\ngraph;\n``` tail\nnext";
    const segs = segmentMarkdownWithLines(src);
    expect(segs[0]).toMatchObject({ type: "markdown", startLine: 1 });
    expect(segs[2]).toMatchObject({ type: "markdown", startLine: 3 });
  });

  it("html segments with html:true carry lines too", () => {
    const src = "a\n```html\n<b>x</b>\n```\nb";
    const segs = segmentMarkdownWithLines(src, { html: true });
    expect(segs.map((s) => [s.type, s.startLine])).toEqual([
      ["markdown", 1],
      ["html", 2],
      ["markdown", 4],
    ]);
  });
});
