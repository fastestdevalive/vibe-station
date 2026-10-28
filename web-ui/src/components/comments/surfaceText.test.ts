import { describe, expect, it } from "vitest";
import { describeSelection } from "./anchorGeometry";
import { locateQuote } from "./locateQuote";
import { surfaceOffset, surfaceText, surfaceTextPos } from "./surfaceText";

function html(inner: string): HTMLElement {
  const root = document.createElement("div");
  root.className = "workspace-markdown-preview";
  root.innerHTML = inner;
  document.body.appendChild(root);
  return root;
}

describe("surfaceText / surfaceOffset", () => {
  it("skips [data-comment-ignore] subtrees", () => {
    const el = html('<p>one</p><div data-comment-ignore=""><span>ts</span><button>Copy</button></div><pre>code</pre>');
    expect(surfaceText(el)).toBe("onecode");
    const pre = el.querySelector("pre")!.firstChild!;
    expect(surfaceOffset(el, pre, 2)).toBe(5);
    // a boundary inside the ignored header counts only the text before it
    const copy = el.querySelector("button")!.firstChild!;
    expect(surfaceOffset(el, copy, 2)).toBe(3);
  });

  it("an element boundary counts the text nodes before it; outside boundaries clamp", () => {
    const el = html("<p>ab</p><p>cd</p>");
    expect(surfaceOffset(el, el, 1)).toBe(2);
    expect(surfaceOffset(el, el, 2)).toBe(4);
    const outside = document.createElement("i");
    document.body.appendChild(outside);
    expect(surfaceOffset(el, outside, 0)).toBe(4);
  });

  it("surfaceTextPos: forward starts the next node at a boundary, backward stays in the ending one", () => {
    const el = html("<p>ab</p><p>cd</p>");
    expect(surfaceTextPos(el, 2, "forward")!.node.data).toBe("cd");
    expect(surfaceTextPos(el, 2, "backward")!.node.data).toBe("ab");
    expect(surfaceTextPos(el, 99, "forward")!.offset).toBe(2);
  });
});

describe("describeMarkdown over a fenced block", () => {
  it("never stores the code block header text and the quote is found again in the same corpus", () => {
    const root = html(
      '<p data-sl="1" data-el="1">Intro line</p>' +
        '<div class="workspace-md-code-block"><div class="workspace-md-code-block-header" data-comment-ignore=""><span>ts</span><button>Copy</button></div>' +
        '<pre data-sl="3" data-el="5">const a = 1;\n</pre></div>' +
        '<p data-sl="7" data-el="7">After the fence</p>',
    );
    const range = document.createRange();
    range.setStart(root.querySelector("p")!.firstChild!, 6);
    range.setEnd(root.querySelectorAll("p")[1]!.firstChild!, 5);
    const res = describeSelection(range, { root, surface: "markdown" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.anchor.quote).not.toContain("Copy");
    expect(res.anchor.quote).not.toContain("tsCopy");
    expect(res.anchor.quote).toBe("lineconst a = 1;\nAfter");
    const hit = locateQuote(surfaceText(root), res.anchor)!;
    expect(surfaceText(root).slice(hit.start, hit.end)).toBe(res.anchor.quote);
  });
});
