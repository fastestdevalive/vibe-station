import { act, render } from "@testing-library/react";
import { pinAriaLabel } from "./CommentPins";
import { describe, expect, it } from "vitest";
import type { ReviewComment } from "@/api/types";
import { MarkdownView } from "@/components/preview/MarkdownView";
import { CommentSurfaceContext, type CommentSurfaceValue } from "./CommentSurfaceContext";
import { PinMeasurer } from "./pinMeasurer";
import { buildSurfaceComments } from "./rowIndex";

const SRC = ["# Title", "", "Soft wrapped paragraph that goes", "on to a second line.", "", "- outer item", "  - inner **bold** item", "- second **bold** item"].join("\n");

function comment(over: Partial<ReviewComment>): ReviewComment {
  return {
    id: "c1",
    scopeKind: "worktree",
    scopeId: "wt",
    pin: 1,
    path: "doc.md",
    pathKind: "repo",
    surface: "markdown",
    quote: "second line",
    prefix: "on to a ",
    suffix: ".",
    occurrence: 0,
    text: "t",
    anchor: "anchored",
    lineStart: 3,
    lineEnd: 4,
    blockBytes: 10,
    version: 1,
    createdAt: "",
    updatedAt: "",
    ...over,
  } as ReviewComment;
}

function surfaceWith(comments: ReviewComment[]): CommentSurfaceValue {
  const view = buildSurfaceComments(comments, "markdown");
  return {
    enabled: true,
    path: "doc.md",
    pinMeasurer: new PinMeasurer(),
    draft: null,
    activeId: null,
    forSurface: () => view,
    pinLabel: (c: ReviewComment) => pinAriaLabel(c, comments.findIndex((x) => x.id === c.id) + 1, comments.length),
  } as unknown as CommentSurfaceValue;
}

/** Mount the view in a surface and run the measurer's frame so the gutter pins render. */
function mountMd(comments: ReviewComment[], source: string, startLine: number) {
  const surface = surfaceWith(comments);
  const utils = render(
    <CommentSurfaceContext.Provider value={surface}>
      <MarkdownView source={source} filePath="doc.md" commentSource={{ startLine }} />
    </CommentSurfaceContext.Provider>,
  );
  act(() => surface.pinMeasurer.flush());
  return utils;
}

describe("MarkdownView comment source + marks (4.T3, 5.T5)", () => {
  it("WITHOUT the prop renders no data-sl (chat bubble regression)", () => {
    const { container } = render(<MarkdownView source={SRC} />);
    expect(container.querySelector("[data-sl]")).toBeNull();
    expect(container.querySelector("mark")).toBeNull();
  });

  it("with the prop: data-sl/data-el carry the segment's startLine offset; a wrapped paragraph is ONE range; nested li ranges", () => {
    const { container } = render(<MarkdownView source={SRC} commentSource={{ startLine: 10 }} />);
    const sl = (el: Element) => [el.getAttribute("data-sl"), el.getAttribute("data-el")];
    expect(sl(container.querySelector("h1")!)).toEqual(["10", "10"]);
    expect(sl(container.querySelectorAll("p")[0]!)).toEqual(["12", "13"]);
    const lis = container.querySelectorAll("li");
    expect(sl(lis[0]!)).toEqual(["15", "16"]); // outer li spans its nested list
    expect(sl(lis[1]!)).toEqual(["16", "16"]); // inner li
    expect(sl(lis[2]!)).toEqual(["17", "17"]);
  });

  it("highlights the quote with <mark data-comment-id>; the pin is a text-less button in the gutter OUTSIDE the rendered markdown", () => {
    const c = comment({ lineStart: 12, lineEnd: 13 });
    const { container } = mountMd([c], SRC, 10);
    const mark = container.querySelector('mark[data-comment-id="c1"]')!;
    expect(mark.textContent).toBe("second line");
    expect(mark.hasAttribute("data-comment-end")).toBe(true);
    const pin = container.querySelector('[data-comment-pin="c1"]')!;
    expect(pin.tagName).toBe("BUTTON");
    expect(pin.textContent).toBe("");
    expect(pin.getAttribute("data-pin")).toBe("1");
    expect(pin.getAttribute("aria-label")).toContain("Comment #1 (1 of 1)");
    expect(pin.querySelector("svg.comment-pin__icon")).not.toBeNull();
    // Not in the hast: the stack is a direct child of the container, beside the markdown's own blocks.
    expect(pin.closest(".comment-pin-stack")!.parentElement).toBe(container.querySelector(".workspace-markdown-preview"));
    expect(container.querySelector("[data-sl] button")).toBeNull();
    expect((pin.closest(".comment-pin-stack") as HTMLElement).style.getPropertyValue("--top")).toMatch(/px$/);
  });

  it("a quote across bold becomes one mark per text run", () => {
    const c = comment({ quote: "inner bold item", prefix: "", suffix: "", lineStart: 16, lineEnd: 16 });
    const { container } = render(
      <CommentSurfaceContext.Provider value={surfaceWith([c])}>
        <MarkdownView source={SRC} filePath="doc.md" commentSource={{ startLine: 10 }} />
      </CommentSurfaceContext.Provider>,
    );
    const marks = [...container.querySelectorAll('mark[data-comment-id="c1"]')].map((m) => m.textContent);
    expect(marks.join("")).toBe("inner bold item");
    expect(marks.length).toBeGreaterThan(1);
  });

  it("outdated: dashed class when found; a quote that is gone marks nothing and flags the last known block", () => {
    const found = comment({ anchor: "outdated" });
    const gone = comment({ id: "c2", pin: 2, quote: "not in the file", prefix: "", suffix: "", anchor: "outdated", lineStart: 12, lineEnd: 13 });
    const { container } = mountMd([found, gone], SRC, 10);
    expect(container.querySelector('mark[data-comment-id="c1"]')!.className).toContain("comment-hl--outdated");
    expect(container.querySelector("mark[data-comment-id='c2']")).toBeNull();
    const block = container.querySelector("[data-comment-fallback]")!;
    expect(block.getAttribute("data-comment-fallback")).toBe("c2");
    expect(block.getAttribute("data-sl")).toBe("12");
    const pin2 = container.querySelector('[data-comment-pin="c2"]')!;
    expect(pin2.className).toContain("comment-pin--outdated");
    expect(pin2.getAttribute("aria-label")).toContain("(2 of 2)");
  });

  it("a quote ending in the newline between list items marks only text, ends inside the li and never marks whitespace", () => {
    const c = comment({ quote: "alpha item\n", prefix: "", suffix: "beta item", lineStart: 1, lineEnd: 1 });
    const { container } = mountMd([c], "- alpha item\n- beta item", 1);
    const end = container.querySelector("mark[data-comment-end]")!;
    expect(end.closest("li")).toBe(container.querySelector("li"));
    const marks = [...container.querySelectorAll("mark.comment-hl")];
    expect(marks.length).toBeGreaterThan(0);
    for (const m of marks) expect((m.textContent ?? "").trim()).not.toBe("");
    expect(container.querySelector('[data-comment-pin="c1"]')).not.toBeNull();
  });

  it("a multi-paragraph quote marks every paragraph, with ONE end marker on the last", () => {
    const src = "First para here.\n\nMiddle para here.\n\nLast para here.";
    const c = comment({ quote: "para here.\nMiddle para here.\nLast para", prefix: "First ", suffix: " here.", lineStart: 1, lineEnd: 5 });
    const { container } = mountMd([c], src, 1);
    const ps = [...container.querySelectorAll("p")];
    expect(ps).toHaveLength(3);
    for (const p of ps) expect(p.querySelector('mark[data-comment-id="c1"]')).not.toBeNull();
    const ends = container.querySelectorAll("mark[data-comment-end]");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.closest("p")).toBe(ps[2]);
  });

  it("overlapping quotes NEST (lowest pin outermost) and each comment keeps its own end marker", () => {
    const src = "alpha beta gamma delta";
    const a = comment({ id: "a", pin: 1, quote: "alpha beta gamma", prefix: "", suffix: "", lineStart: 1, lineEnd: 1 });
    const b = comment({ id: "b", pin: 2, quote: "beta gamma delta", prefix: "", suffix: "", lineStart: 1, lineEnd: 1 });
    const { container } = mountMd([a, b], src, 1);
    const markA = [...container.querySelectorAll('mark[data-comment-id="a"]')].map((m) => m.textContent).join("");
    const markB = [...container.querySelectorAll('mark[data-comment-id="b"]')].map((m) => m.textContent).join("");
    expect(markA).toBe("alpha beta gamma");
    expect(markB).toBe("beta gamma delta");
    const overlap = container.querySelector('mark[data-comment-id="a"] mark[data-comment-id="b"]')!;
    expect(overlap.textContent).toBe("beta gamma");
    expect(container.querySelectorAll('mark[data-comment-id="a"][data-comment-end]')).toHaveLength(1);
    expect(container.querySelectorAll('mark[data-comment-id="b"][data-comment-end]')).toHaveLength(1);
    // a's last piece is the shared "beta gamma" run (a is outermost there), so its end marker wraps b's mark.
    expect(container.querySelector('mark[data-comment-id="a"][data-comment-end]')!.textContent).toBe("beta gamma");
    expect(container.querySelector('mark[data-comment-id="b"][data-comment-end]')!.textContent).toBe(" delta");
  });

  it("a quote across a table (react-markdown drops the whitespace between rows) is found and marked", () => {
    const src = "| h1 | h2 |\n| -- | -- |\n| a1 | a2 |\n| b1 | b2 |";
    const c = comment({ quote: "a2b1", prefix: "h1h2a1", suffix: "b2", lineStart: 3, lineEnd: 4 });
    const { container } = mountMd([c], src, 1);
    const marks = [...container.querySelectorAll('mark[data-comment-id="c1"]')].map((m) => m.textContent);
    expect(marks.join("")).toBe("a2b1");
  });
});
