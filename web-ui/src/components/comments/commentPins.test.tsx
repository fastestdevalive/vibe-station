import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { CodeView } from "@/components/preview/CodeView";
import { DiffView } from "@/components/preview/DiffView";
import { MarkdownView } from "@/components/preview/MarkdownView";
import { useWorkspaceStore } from "@/hooks/useStore";
import { useCommentSurface } from "./CommentSurfaceContext";
import { CommentSurfaceProvider } from "./CommentSurfaceProvider";
import { linkRules } from "./commentLinkRules";
import { DRAFT_ID } from "./draftComment";
import type { PinMeasurer } from "./pinMeasurer";
import { useCommentStore } from "./useCommentStore";
import { useCommentsSync } from "./useCommentsSync";

const rect = (top: number, height = 20): DOMRect => ({ top, height, bottom: top + height, left: 0, right: 10, width: 10, x: 0, y: top, toJSON: () => {} }) as DOMRect;
const PATH = "src/a.ts";

let measurer: PinMeasurer | null = null;
function Probe() {
  measurer = useCommentSurface()?.pinMeasurer ?? null;
  return null;
}

function Harness({ api, children, fileText }: { api: ReturnType<typeof createMockApi>; children: ReactNode; fileText: string }) {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  useCommentsSync(api);
  return (
    <CommentSurfaceProvider api={api} scopeKind="worktree" scopeId="wt-1" path={PATH} pathKind="repo" rootEl={root} disabledReason={null} diffScope="local" fileText={fileText}>
      <div className="preview-body" data-comment-surface="" tabIndex={-1} ref={setRoot} data-testid="root">
        <Probe />
        {children}
      </div>
    </CommentSurfaceProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  useCommentStore.getState().reset();
  useWorkspaceStore.setState({ diffLayoutMode: "inline" } as never);
  const proto = Range.prototype as unknown as { getClientRects?: () => DOMRectList; getBoundingClientRect?: () => DOMRect };
  proto.getClientRects ??= () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect ??= () => rect(0, 0);
});
afterEach(() => vi.restoreAllMocks());

const seed = (api: ReturnType<typeof createMockApi>, over: Record<string, unknown>) =>
  api.createComment("wt-1", "worktree", { path: PATH, pathKind: "repo", prefix: "", suffix: "", occurrence: 0, text: "note", ...over } as never);

async function mount(api: ReturnType<typeof createMockApi>, fileText: string, node: ReactNode) {
  const utils = render(
    <Harness api={api} fileText={fileText}>
      {node}
    </Harness>,
  );
  await waitFor(() => expect(useCommentStore.getState().byScope["wt-1"]?.status).toBe("ready"));
  return utils;
}

const stacks = (scope: ParentNode = document) => [...scope.querySelectorAll<HTMLElement>(".comment-pin-stack")];

const FILE = ["line one", "x tail", "middle line", "head of end", "line five"].join("\n");

describe("code view: every row of a multi-line span is marked, the pin sits in the gutter of the LAST row (10)", () => {
  it("marks rows 2-4 (the middle one in full), draws no inline pins and one stack with --top on row 4", async () => {
    const api = createMockApi();
    await seed(api, { id: "m1", surface: "file", lineStart: 2, lineEnd: 4, quote: "tail\nmiddle line\nhead of" });
    await mount(api, FILE, <CodeView code={FILE} filePath={PATH} />);
    await waitFor(() => expect(document.querySelector("[data-comment-pin]")).toBeTruthy());
    const row = (n: number) => document.querySelector<HTMLElement>(`.workspace-code-line[data-line="${n}"]`)!;
    expect(row(1).querySelector("mark.comment-hl")).toBeNull();
    for (const n of [2, 3, 4]) {
      expect(row(n).querySelector("mark.comment-hl")).not.toBeNull();
      expect(row(n).className).toContain("workspace-code-line--commented");
    }
    expect(row(5).querySelector("mark.comment-hl")).toBeNull();
    expect([...row(3).querySelectorAll("mark.comment-hl")].map((m) => m.textContent).join("")).toBe("middle line");
    expect([...row(4).querySelectorAll("mark.comment-hl")].map((m) => m.textContent).join("")).toBe("head of");
    expect(document.querySelector(".comment-pins")).toBeNull();
    const all = stacks();
    expect(all).toHaveLength(1);
    expect(row(4).contains(all[0]!)).toBe(true);
    expect(all[0]!.style.getPropertyValue("--top")).toMatch(/^\d+(\.\d+)?px$/);
  });

  it("a CRLF file still marks every row", async () => {
    const crlf = FILE.replace(/\n/g, "\r\n");
    const api = createMockApi();
    await seed(api, { id: "m1", surface: "file", lineStart: 2, lineEnd: 4, quote: "tail\nmiddle line\nhead of" });
    await mount(api, crlf, <CodeView code={crlf} filePath={PATH} />);
    await waitFor(() =>
      expect([...document.querySelectorAll(".workspace-code-line")].filter((r) => r.querySelector("mark.comment-hl"))).toHaveLength(3),
    );
  });

  it("follows horizontal scroll: stack --x = scrollLeft + clientWidth - gutter + (gutter - width) / 2 (12)", async () => {
    const api = createMockApi();
    await seed(api, { id: "m1", surface: "file", lineStart: 2, lineEnd: 2, quote: "tail" });
    await mount(api, FILE, <CodeView code={FILE} filePath={PATH} />);
    const root = screen.getByTestId("root");
    Object.defineProperty(root, "clientWidth", { value: 900, configurable: true });
    let left = 0;
    Object.defineProperty(root, "scrollLeft", { get: () => left, configurable: true });
    root.style.setProperty("--comment-gutter-w", "24px");
    await waitFor(() => expect(stacks()).toHaveLength(1));
    const stack = stacks()[0]!;
    Object.defineProperty(stack, "offsetWidth", { value: 16, configurable: true });
    left = 500;
    act(() => {
      root.dispatchEvent(new Event("scroll"));
    });
    await waitFor(() => expect(stack.style.getPropertyValue("--x")).toBe(`${500 + 900 - 24 + 4}px`));
  });

  it("shows the open box's span dashed with a draft pin at its end, aria-hidden and not focusable (2.7)", async () => {
    const api = createMockApi();
    await mount(
      api,
      FILE,
      <>
        <OpenAt />
        <CodeView code={FILE} filePath={PATH} />
      </>,
    );
    fireEvent.click(screen.getByTestId("open"));
    await screen.findByRole("group", { name: "New comment" });
    await waitFor(() => expect(document.querySelector(".comment-pin--draft")).toBeTruthy());
    const draft = document.querySelector<HTMLElement>(".comment-pin--draft")!;
    expect(draft.getAttribute("aria-hidden")).toBe("true");
    expect(draft.tagName).not.toBe("BUTTON");
    expect(draft.closest(".workspace-code-line")!.getAttribute("data-line")).toBe("3");
    expect(document.querySelectorAll("mark.comment-hl--draft").length).toBeGreaterThanOrEqual(2);
  });
});

function OpenAt() {
  const cs = useCommentSurface();
  return (
    <button type="button" data-testid="open" onClick={() => cs?.openNew({ surface: "file", lineStart: 2, lineEnd: 3, quote: "tail\nmiddle line", prefix: "", suffix: "", occurrence: 0 })} />
  );
}

describe("virtualised code view (11)", () => {
  const big = Array.from({ length: 2500 }, (_, i) => `const line${i + 1} = ${i};`).join("\n");
  function scroller() {
    const el = document.createElement("div");
    el.getBoundingClientRect = () => rect(0, 500);
    Object.defineProperty(el, "clientHeight", { value: 500, configurable: true });
    Object.defineProperty(el, "clientWidth", { value: 800, configurable: true });
    Object.defineProperty(el, "offsetHeight", { value: 500, configurable: true });
    Object.defineProperty(el, "scrollHeight", { value: 2_000_000, configurable: true });
    return el;
  }
  function Open() {
    const cs = useCommentSurface();
    return <button type="button" data-testid="open" onClick={() => cs?.openNew({ surface: "file", lineStart: 2400, lineEnd: 2400, quote: "const line2400", prefix: "", suffix: "", occurrence: 0 })} />;
  }

  it("the row under the open box stays mounted with its draft pin; leaving it unregisters the host", async () => {
    const api = createMockApi();
    await mount(
      api,
      big,
      <>
        <Open />
        <CodeView code={big} filePath={PATH} scrollElRef={{ current: scroller() }} />
      </>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(document.querySelector('.workspace-code-line[data-line="2400"]')).toBeNull();
    expect(measurer!.hostCount).toBe(0);
    fireEvent.click(screen.getByTestId("open"));
    await screen.findByRole("group", { name: "New comment" });
    await waitFor(() => expect(document.querySelector('.workspace-code-line[data-line="2400"] .comment-pin--draft')).toBeTruthy());
    expect(measurer!.hostCount).toBe(1);
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText("Comment"), { key: "Escape" });
    });
    await waitFor(() => expect(document.querySelector('.workspace-code-line[data-line="2400"]')).toBeNull());
    expect(measurer!.hostCount).toBe(0);
  });
});

const DIFF = ["@@ -1,5 +1,5 @@", " keep one", "-old a", "+new a", "-old b", "+new b", " keep end"].join("\n");
const NEW_FILE = "keep one\nnew a\nnew b\nkeep end\n";
const diff = () => <DiffView diffText={DIFF} fileContentFallback={NEW_FILE} filePath={PATH} interactive />;
const textsOf = (el: Element) => [...el.querySelectorAll("mark.comment-hl")].map((m) => m.textContent).join("");

describe("diff view (13)", () => {
  it("inline: marks both added rows; the removed row between them gets tint and bar but no marks; pin on the last row only", async () => {
    const api = createMockApi();
    await seed(api, { id: "d1", surface: "diff", diffScope: "local", side: "new", lineStart: 2, lineEnd: 3, newStart: 2, newEnd: 3, quote: "new a\nnew b" });
    await mount(api, NEW_FILE, diff());
    await waitFor(() => expect(document.querySelector("[data-comment-pin]")).toBeTruthy());
    const added = [...document.querySelectorAll<HTMLElement>(".diff-line--added")];
    expect(added.map(textsOf)).toEqual(["new a", "new b"]);
    const removed = [...document.querySelectorAll<HTMLElement>(".diff-line--removed")];
    expect(removed[0]!.className).not.toContain("diff-line--commented"); // old a: before the span's first row
    expect(removed[1]!.className).toContain("diff-line--commented"); // old b: inside the span
    expect(removed[1]!.querySelector("mark")).toBeNull();
    expect(stacks()).toHaveLength(1);
    expect(added[1]!.contains(stacks()[0]!)).toBe(true);
    expect(document.querySelector(".comment-pins")).toBeNull();
  });

  it("a wrapped row: the stack top follows the visual line holding the last character", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => rect(0, 60));
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { get: () => 60, configurable: true });
    try {
      // last character on visual line 2 of 3 (rows 20px): centre y = 30 -> top = 30 - 9 (an 18px pin)
      vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([rect(0), rect(20)] as unknown as DOMRectList);
      const api = createMockApi();
      await seed(api, { id: "d1", surface: "diff", diffScope: "local", side: "new", lineStart: 2, lineEnd: 2, newStart: 2, newEnd: 2, quote: "new a" });
      await mount(api, NEW_FILE, diff());
      await waitFor(() => expect(stacks()).toHaveLength(1));
      expect(stacks()[0]!.style.getPropertyValue("--top")).toBe("21px");
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
    }
  });

  it("side-by-side: right-column marks, and an old-side stack lives inside the LEFT cell", async () => {
    useWorkspaceStore.setState({ diffLayoutMode: "side-by-side" } as never);
    const api = createMockApi();
    await seed(api, { id: "n1", surface: "diff", diffScope: "local", side: "new", lineStart: 2, lineEnd: 3, newStart: 2, newEnd: 3, quote: "new a\nnew b" });
    await seed(api, { id: "o1", surface: "diff", diffScope: "local", side: "old", lineStart: 2, lineEnd: 3, oldStart: 2, oldEnd: 3, quote: "old a\nold b" });
    await mount(api, NEW_FILE, diff());
    await waitFor(() => expect(stacks()).toHaveLength(2));
    const right = [...document.querySelectorAll<HTMLElement>('.diff-line[data-side="new"].diff-line--added')];
    expect(right.map(textsOf)).toEqual(["new a", "new b"]);
    const left = [...document.querySelectorAll<HTMLElement>('.diff-line[data-side="old"].diff-line--removed')];
    expect(left.map(textsOf)).toEqual(["old a", "old b"]);
    const oldStack = stacks().find((s) => s.querySelector('[data-comment-pin="o1"]'))!;
    expect(oldStack.closest(".diff-line")).toBe(left[1]);
    const newStack = stacks().find((s) => s.querySelector('[data-comment-pin="n1"]'))!;
    expect(newStack.closest(".diff-line")).toBe(right[1]);
  });

  it("a collapsed gap a span runs through shows the span bar on its header", async () => {
    const gapDiff = ["@@ -1,2 +1,2 @@", " one", "-two", "+TWO", "@@ -10,2 +10,2 @@", " ten", "-eleven", "+ELEVEN"].join("\n");
    const lines = Array.from({ length: 12 }, (_, i) => `l${i + 1}`);
    lines[1] = "TWO";
    lines[10] = "ELEVEN";
    const file = lines.join("\n");
    const api = createMockApi();
    await seed(api, { id: "g1", surface: "diff", diffScope: "local", side: "new", lineStart: 2, lineEnd: 11, newStart: 2, newEnd: 11, quote: "TWO\nl3" });
    await mount(api, file, <DiffView diffText={gapDiff} fileContentFallback={file} filePath={PATH} interactive />);
    await waitFor(() => expect(document.querySelector(".preview-diff-gap-header--commented")).toBeTruthy());
  });
});

describe("hover / focus link and a11y (15, 16)", () => {
  async function two() {
    const api = createMockApi();
    await seed(api, { id: "p1", surface: "file", lineStart: 2, lineEnd: 2, quote: "tail", text: "first" });
    await seed(api, { id: "p2", surface: "file", lineStart: 2, lineEnd: 2, quote: "x ", text: "second" });
    await mount(api, FILE, <CodeView code={FILE} filePath={PATH} />);
    await waitFor(() => expect(document.querySelectorAll("[data-comment-pin]")).toHaveLength(2));
    return api;
  }
  const rule = () => document.querySelector("style[data-comment-link-rules]")?.textContent ?? "";

  it("the pin <-> span link is a static :has(:hover / :focus) rule per comment, the draft excluded", async () => {
    await two();
    const css = rule();
    for (const id of ["p1", "p2"]) {
      expect(css).toContain(
        `[data-comment-surface]:has([data-comment-pin="${id}"]:hover,[data-comment-pin="${id}"]:focus,mark[data-comment-id="${id}"]:hover) ` +
          `mark.comment-hl[data-comment-id="${id}"]{background:var(--comment-hl-active)}`,
      );
    }
    // Hover never restyles the pin itself (no ring / size change under the pointer).
    expect(css).not.toMatch(/\.comment-pin[^{]*\{/);
    expect(css).not.toMatch(/box-shadow|transform|scale/);
    expect(linkRules(["a", DRAFT_ID])).not.toContain(DRAFT_ID);
  });

  it("the stylesheet sizes pins up at rest (18px, glyph 0.7) and gives :hover no transform / transition / ring", () => {
    const css = readFileSync(resolve(__dirname, "comments.css"), "utf8");
    expect(css).toMatch(/\.preview-body\[data-comment-surface\] \{\s*--comment-gutter-w: 24px;\s*--comment-pin-size: 18px;/);
    expect(css).toMatch(/\.comment-pin__icon \{\s*width: calc\(var\(--comment-pin-size, 18px\) \* 0\.7\);/);
    for (const [, body] of css.matchAll(/\.comment-pin[\w-]*:hover[^{]*\{([^}]*)\}/g)) {
      expect(body?.trim()).toMatch(/^background: var\(--[\w-]+\);$/);
    }
    // Any rule styling a pin (not the code view's stack, which slides sideways via `--x`) stays still.
    expect(css).not.toMatch(/\.comment-pin(?!-stack)[^{}]*\{[^}]*(transform|transition|scale|animation)/);
  });

  it("hovering / focusing a pin or a mark runs no DOM change (no state, no injected node, nothing moves)", async () => {
    await two();
    const pin = document.querySelector<HTMLElement>('[data-comment-pin="p1"]')!;
    const before = rule();
    const records: MutationRecord[] = [];
    const mo = new MutationObserver((r) => records.push(...r));
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    fireEvent.mouseOver(pin);
    fireEvent.mouseEnter(pin);
    fireEvent.mouseMove(pin);
    fireEvent.focusIn(pin);
    fireEvent.mouseOver(document.querySelector('mark[data-comment-id="p2"]')!);
    fireEvent.focusOut(pin);
    fireEvent.mouseLeave(screen.getByTestId("root"));
    await act(async () => {});
    records.push(...mo.takeRecords());
    mo.disconnect();
    expect(records).toEqual([]);
    expect(rule()).toBe(before);
  });

  it("two comments on one visual line: a named group of two real buttons with accessible labels, in pin order", async () => {
    await two();
    const stack = stacks()[0]!;
    expect(stack.getAttribute("role")).toBe("group");
    expect(stack.getAttribute("aria-label")).toBe("2 comments on this line");
    const buttons = [...stack.querySelectorAll<HTMLButtonElement>("button.comment-pin")];
    expect(buttons.map((b) => b.getAttribute("data-comment-pin"))).toEqual(["p1", "p2"]);
    expect(buttons[0]!.getAttribute("aria-label")).toMatch(/^Comment #1 \(1 of 2\): first/);
    expect(buttons[1]!.getAttribute("aria-label")).toMatch(/^Comment #2 \(2 of 2\): second/);
    expect(buttons.every((b) => b.tabIndex === 0)).toBe(true);
  });

  it("clicking a code pin focuses that comment's card", async () => {
    await two();
    fireEvent.click(document.querySelector('[data-comment-pin="p2"]')!);
    expect((document.activeElement as HTMLElement).closest('[data-comment-card="p2"]')).not.toBeNull();
  });

  it("a stack shows the TOTAL as its count badge from two comments; a single pin has none", async () => {
    const api = createMockApi();
    for (const id of ["a", "b", "c"]) await seed(api, { id, surface: "file", lineStart: 2, lineEnd: 2, quote: "tail" });
    await mount(api, FILE, <CodeView code={FILE} filePath={PATH} />);
    await waitFor(() => expect(document.querySelectorAll("[data-comment-pin]")).toHaveLength(3));
    expect(stacks()[0]!.getAttribute("data-count")).toBe("3");
    expect(stacks()[0]!.hasAttribute("data-more")).toBe(false);
  });

  it("the pin of the comment being edited is active (aria-current) and the pins follow row order", async () => {
    const api = createMockApi();
    await seed(api, { id: "r1", surface: "file", lineStart: 2, lineEnd: 2, quote: "tail", text: "one" });
    await seed(api, { id: "r2", surface: "file", lineStart: 4, lineEnd: 4, quote: "head", text: "two" });
    await mount(api, FILE, <CodeView code={FILE} filePath={PATH} />);
    await waitFor(() => expect(document.querySelectorAll("[data-comment-pin]")).toHaveLength(2));
    const order = [...document.querySelectorAll("[data-comment-pin]")].map((p) => p.getAttribute("data-comment-pin"));
    expect(order).toEqual(["r1", "r2"]);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]!);
    await screen.findByText(/Editing comment 1/);
    await waitFor(() => expect(document.querySelector('[data-comment-pin="r1"]')!.getAttribute("aria-current")).toBe("true"));
    expect(document.querySelector('[data-comment-pin="r1"]')!.className).toContain("comment-pin--active");
    expect(document.querySelector('[data-comment-pin="r2"]')!.hasAttribute("aria-current")).toBe(false);
  });
});

describe("pins show an icon, never a number (round 5)", () => {
  it("every real pin and the draft pin hold the comment icon; there is no text and no count on a single pin", async () => {
    const api = createMockApi();
    await seed(api, { id: "a", surface: "file", lineStart: 1, lineEnd: 1, quote: "line one" });
    await seed(api, { id: "b", surface: "file", lineStart: 5, lineEnd: 5, quote: "line five" });
    await mount(api, FILE, <CodeView code={FILE} filePath={PATH} />);
    await waitFor(() => expect(document.querySelectorAll("[data-comment-pin]")).toHaveLength(2));
    for (const pinEl of document.querySelectorAll<HTMLElement>("button.comment-pin")) {
      expect(pinEl.querySelector("svg.comment-pin__icon")).not.toBeNull();
      expect(pinEl.textContent).toBe("");
      expect(pinEl.getAttribute("aria-label")).toMatch(/^Comment #\d+ \(\d of 2\): /);
    }
    for (const st of stacks()) expect(st.hasAttribute("data-count")).toBe(false);
  });

  it("two comments on one line: the badge counts both; the draft joins the stack and is counted", async () => {
    const api = createMockApi();
    for (const id of ["a", "b"]) await seed(api, { id, surface: "file", lineStart: 2, lineEnd: 2, quote: "tail" });
    await mount(api, FILE, <CodeView code={FILE} filePath={PATH} />);
    await waitFor(() => expect(document.querySelectorAll("[data-comment-pin]")).toHaveLength(2));
    expect(stacks()[0]!.getAttribute("data-count")).toBe("2");
    expect(stacks()[0]!.getAttribute("aria-label")).toBe("2 comments on this line");
  });

  it("the stylesheet draws no number (no attr(data-pin) content); the badge reads data-count; tokens only", () => {
    const css = readFileSync(resolve(__dirname, "comments.css"), "utf8");
    expect(css).not.toMatch(/content:\s*attr\(data-pin\)/);
    expect(css).not.toMatch(/data-more/);
    expect(css).toMatch(/\.comment-pin-stack\[data-count\]::before \{\s*content: attr\(data-count\);/);
    expect(css).toMatch(/\.comment-pin--draft \{\s*color: var\(--comment\);/);
  });
});

describe("rendered markdown through the provider (14)", () => {
  const SRC = "alpha beta gamma delta";
  async function md() {
    const api = createMockApi();
    await seed(api, { id: "a", surface: "markdown", lineStart: 1, lineEnd: 1, quote: "alpha beta gamma", text: "first note" });
    await seed(api, { id: "b", surface: "markdown", lineStart: 1, lineEnd: 1, quote: "beta gamma delta", text: "second note" });
    await mount(api, SRC, <MarkdownView source={SRC} filePath={PATH} commentSource={{ startLine: 1 }} />);
    await waitFor(() => expect(document.querySelectorAll("[data-comment-pin]")).toHaveLength(2));
  }

  it("clicking a merged pin opens a float with BOTH view boxes", async () => {
    await md();
    expect(stacks()).toHaveLength(1);
    fireEvent.click(document.querySelector('[data-comment-pin="b"]')!);
    const float = await waitFor(() => {
      const f = document.querySelector<HTMLElement>("[data-comment-float]");
      expect(f).not.toBeNull();
      return f!;
    });
    expect(float).toHaveTextContent("first note");
    expect(float).toHaveTextContent("second note");
  });

  it("hovering a pin lights both of its marks (nested marks carry the id)", async () => {
    await md();
    fireEvent.mouseOver(document.querySelector('[data-comment-pin="a"]')!);
    const css = [...document.querySelectorAll("style")].map((x) => x.textContent).join("");
    expect(css).toContain('mark.comment-hl[data-comment-id="a"]');
    expect(document.querySelectorAll('mark[data-comment-id="a"]').length).toBeGreaterThan(0);
  });
});
