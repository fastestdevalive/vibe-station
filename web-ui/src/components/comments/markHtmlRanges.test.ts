import { describe, expect, it } from "vitest";
import { markHtmlRanges, markPlainRanges } from "./markHtmlRanges";

const r = (start: number, end: number, id = "c1", outdated = false) => ({ start, end, id, outdated });

describe("markHtmlRanges (4.T2)", () => {
  it("empty or inverted ranges are a no-op", () => {
    const html = '<span style="color:red">abc</span>';
    expect(markHtmlRanges(html, [])).toBe(html);
    expect(markHtmlRanges(html, [r(2, 2), r(3, 1)])).toBe(html);
  });

  it("marks inside a single text run", () => {
    expect(markHtmlRanges("<span>hello world</span>", [r(6, 11)])).toBe(
      '<span>hello <mark class="comment-hl" data-comment-id="c1">world</mark></span>',
    );
  });

  it("a range across spans closes and reopens the mark around every tag (valid nesting)", () => {
    const out = markHtmlRanges('<span class="a">ab</span><span class="b">cd</span>', [r(1, 3)]);
    expect(out).toBe(
      '<span class="a">a<mark class="comment-hl" data-comment-id="c1">b</mark></span><span class="b"><mark class="comment-hl" data-comment-id="c1">c</mark>d</span>',
    );
    const doc = new DOMParser().parseFromString(out, "text/html");
    expect(doc.body.textContent).toBe("abcd");
    expect(doc.querySelectorAll("mark")).toHaveLength(2);
  });

  it("entities count as one text unit", () => {
    const out = markHtmlRanges("<span>a&lt;b&amp;c</span>", [r(1, 4)]);
    expect(out).toBe('<span>a<mark class="comment-hl" data-comment-id="c1">&lt;b&amp;</mark>c</span>');
  });

  it("outdated ranges get the dashed class; overlapping ranges nest", () => {
    const out = markHtmlRanges("abcdef", [r(0, 4, "a"), r(2, 6, "b", true)]);
    const doc = new DOMParser().parseFromString(out, "text/html");
    expect(doc.body.textContent).toBe("abcdef");
    expect(doc.querySelector('mark[data-comment-id="b"]')?.className).toContain("comment-hl--outdated");
    expect(doc.querySelector('mark[data-comment-id="a"] mark[data-comment-id="b"]')?.textContent).toBe("cd");
  });

  it("never splits a surrogate pair", () => {
    const out = markHtmlRanges("a😀b", [r(1, 3)]);
    expect(out).toContain("<mark");
    expect(new DOMParser().parseFromString(out, "text/html").body.textContent).toBe("a😀b");
  });

  it("plain lines are escaped first", () => {
    expect(markPlainRanges("<a>", [r(0, 1)])).toBe('<mark class="comment-hl" data-comment-id="c1">&lt;</mark>a&gt;');
  });
});
