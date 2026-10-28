import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewComment } from "@/api/types";
import { CommentsList, VIRTUALISE_ABOVE, attachedWhere, type CommentsListProps } from "./CommentsList";
import { makeComment as c } from "./testFixtures";

function renderList(comments: ReviewComment[], over: Partial<CommentsListProps> = {}) {
  const props: CommentsListProps = {
    comments,
    status: "ready",
    unchecked: new Set(),
    onToggle: vi.fn(),
    onToggleAll: vi.fn(),
    onOpen: vi.fn(),
    onDetach: vi.fn(),
    onRetryLoad: vi.fn(),
    composerName: () => "main",
    ...over,
  };
  return { props, ...render(<CommentsList {...props} />) };
}

/** jsdom has no layout: give the scroller a 380px viewport so the virtualiser renders a window. */
function stubScrollerGeometry() {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 380, width: 400, height: 380, toJSON: () => ({}) } as DOMRect;
  const item = { ...rect, bottom: 76, height: 76 } as DOMRect;
  const empty = { ...rect, right: 0, bottom: 0, width: 0, height: 0 } as DOMRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("comment-list") ? rect : this.classList.contains("comment-list__virtual") ? item : empty;
  });
  for (const prop of ["offsetHeight", "offsetWidth"] as const) {
    vi.spyOn(HTMLElement.prototype, prop, "get").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("comment-list")) return prop === "offsetHeight" ? 380 : 400;
      return this.classList.contains("comment-list__virtual") ? (prop === "offsetHeight" ? 76 : 400) : 0;
    });
  }
}

afterEach(() => vi.restoreAllMocks());

describe("CommentsList rows are one tap target (round 4)", () => {
  const css = (f: string) => readFileSync(resolve(__dirname, f), "utf8");

  it("the row's one open button is named by path and line, and Enter / Space activate it", async () => {
    const { props } = renderList([c({ id: "a", pin: 1, path: "app.py", lineStart: 2, lineEnd: 2 })]);
    const open = screen.getByRole("button", { name: "Open app.py at L2" });
    expect(open).toHaveAttribute("title", "app.py");
    const user = userEvent.setup();
    open.focus();
    await user.keyboard("{Enter}");
    expect(props.onOpen).toHaveBeenCalledTimes(1);
    await user.keyboard(" ");
    expect(props.onOpen).toHaveBeenCalledTimes(2);
  });

  it("the open button is the row's only control, stretched over its text, quote and pin", () => {
    const { props, container } = renderList([c({ id: "a", pin: 1, path: "app.py", quote: "quoted line", text: "fix this" })]);
    const row = container.querySelector<HTMLElement>("[data-comment-row=a]")!;
    // the stretched ::after has no DOM node: the open button is the row's only control besides the checkbox
    expect(within(row).getAllByRole("button")).toHaveLength(1);
    fireEvent.click(within(row).getByRole("button"));
    expect(props.onOpen).toHaveBeenCalledTimes(1);
  });

  it("the checkbox toggles without opening the file", () => {
    const { props } = renderList([c({ id: "a", pin: 1 })]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select comment 1" }));
    expect(props.onToggle).toHaveBeenCalledWith("a");
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it("Detach calls onDetach without opening the file", () => {
    const { props } = renderList([c({ id: "b", attachedTo: "session:s1" })]);
    fireEvent.click(screen.getByRole("button", { name: "Detach" }));
    expect(props.onDetach).toHaveBeenCalledTimes(1);
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it("CSS stretches the button over the row; the checkbox hit and Detach sit above it; the focus ring is the row's", () => {
    const tray = css("tray.css");
    expect(tray).toMatch(/\.comment-list__link::after \{\s*content: "";\s*position: absolute;\s*inset: 0;/);
    expect(tray).toMatch(/\.comment-list__item \{\s*position: relative;\s*min-height: 44px;\s*cursor: pointer;/);
    expect(tray).toMatch(/\.comment-list__item > \.comment-cb-hit,\s*\.comment-list__detach \{\s*position: relative;\s*z-index: 1;/);
    expect(tray).toMatch(/\.comment-list__item:has\(\.comment-list__link:focus-visible\) \{\s*outline: 2px solid var\(--fg-primary\);/);
    expect(tray).toMatch(/\.comment-list__link:focus-visible \{\s*outline: none;/);
  });

  it("the desktop checkbox keeps a 44x44 hit area (14px box; the scroller clips 3px on the left, so the right takes them), phones their own 44px column", () => {
    const cm = css("comments.css");
    expect(cm).toMatch(/@media \(min-width: 769px\) \{\s*\.comment-cb-hit \{[^}]*position: relative;[^}]*\}\s*\.comment-cb-hit::before \{\s*content: "";\s*position: absolute;\s*(?:\/\*[^*]*\*\/\s*)?inset: -15px -18px -15px -12px;/);
    expect(cm).toMatch(/@media \(max-width: 768px\)[\s\S]*\.comment-cb-hit \{\s*display: inline-flex;[^}]*min-width: 44px;\s*min-height: 44px;/);
  });
});

describe("CommentsList (6.T2)", () => {
  it("wraps every checkbox in a label.comment-cb-hit touch target (R1F-07)", () => {
    renderList([c({ id: "a", pin: 1 }), c({ id: "b", pin: 2 })]);
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(3);
    for (const cb of boxes) expect(cb.parentElement?.matches("label.comment-cb-hit")).toBe(true);
  });

  it("has 'Needs you' with a checkbox per row, all ticked by default, and 'Attached' only when non-empty", () => {
    const { rerender, props } = renderList([c({ id: "a", pin: 1 }), c({ id: "b", pin: 2 })]);
    expect(screen.getByText("Needs you")).toBeInTheDocument();
    expect(screen.getByText("· 2 · 2 selected")).toBeInTheDocument();
    expect(screen.queryByText("Attached")).toBeNull();
    for (const cb of screen.getAllByRole("checkbox")) expect(cb).toBeChecked();

    rerender(<CommentsList {...props} comments={[c({ id: "a", pin: 1 }), c({ id: "b", pin: 2, attachedTo: "session:s1" })]} />);
    expect(screen.getByText("Attached")).toBeInTheDocument();
    expect(screen.getByText("· 1 · in the main chat box")).toBeInTheDocument();
    expect(screen.getByText("attached · main")).toBeInTheDocument();
  });

  it("unticked rows change the 'N selected' text; select-all toggles through the callback", () => {
    const { props } = renderList([c({ id: "a" }), c({ id: "b", pin: 2 }), c({ id: "d", pin: 3 })], { unchecked: new Set(["b"]) });
    expect(screen.getByText("· 3 · 2 selected")).toBeInTheDocument();
    expect(screen.getByLabelText("Select comment 2")).not.toBeChecked();
    fireEvent.click(screen.getByLabelText("Select comment 2"));
    expect(props.onToggle).toHaveBeenCalledWith("b");
    fireEvent.click(screen.getByLabelText("Select all"));
    expect(props.onToggleAll).toHaveBeenCalledWith(["a", "b", "d"], true);
  });

  it("shows the daemon's pin as-is (numbering restarts at 1 after a send)", () => {
    renderList([c({ id: "n", pin: 1 }), c({ id: "m", pin: 6, lineStart: 9 })]);
    const pins = [...document.querySelectorAll<HTMLElement>("[data-comment-row] .comment-list__pin")].map((p) => p.dataset.pin);
    expect(pins).toEqual(["1", "6"]);
    expect([...document.querySelectorAll("[data-comment-row] .comment-list__pin")].map((p) => p.textContent)).toEqual(["#1", "#6"]);
    expect(document.querySelector("[data-comment-row] .comment-pin")).toBeNull();
  });

  it("sorts by file, then line, then pin", () => {
    renderList([
      c({ id: "z", pin: 1, path: "z.ts", lineStart: 1 }),
      c({ id: "a2", pin: 3, path: "a.ts", lineStart: 20 }),
      c({ id: "a1", pin: 2, path: "a.ts", lineStart: 5 }),
    ]);
    const pins = [...document.querySelectorAll<HTMLElement>("[data-comment-row] .comment-list__pin")].map((p) => p.dataset.pin);
    expect(pins).toEqual(["2", "3", "1"]);
  });

  it("row copy: outdated / outside repo / file missing / can't check, and the click opens the comment", () => {
    const { props } = renderList([
      c({ id: "o", pin: 1, anchor: "outdated", path: "docs/a.md", lineStart: 78 }),
      c({ id: "x", pin: 2, pathKind: "artifact", path: "/tmp/mockups/rail.html" }),
      c({ id: "m", pin: 3, anchor: "file_missing", path: "gone.md" }),
      c({ id: "big", pin: 4, anchor: "cant_check", anchorReason: "file_too_large", path: "docs/huge-log.md" }),
      c({ id: "wl", pin: 5, anchor: "cant_check", anchorReason: "watch_limit", path: "src/gen.ts" }),
    ]);
    expect(screen.getByText("outdated")).toBeInTheDocument();
    expect(screen.getByText("outside repo")).toBeInTheDocument();
    expect(screen.getByText("(sent with “file no longer exists”)")).toBeInTheDocument();
    expect(document.querySelector("s")).toHaveTextContent("gone.md");
    expect(screen.getByText("Can't check · file too large")).toBeInTheDocument();
    const wl = screen.getByText("Can't check · too many watched files");
    expect(wl).toHaveAttribute("title", "Can't check · too many watched files (watch limit)");
    fireEvent.click(screen.getByRole("button", { name: "Open docs/a.md at L78" }));
    expect(props.onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "o" }));
  });

  it("Detach on an attached row", () => {
    const { props } = renderList([c({ id: "b", attachedTo: "session:s1" })]);
    fireEvent.click(screen.getByRole("button", { name: "Detach" }));
    expect(props.onDetach).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
  });

  it("virtualises above 60 rows: 200 rows never all mount", () => {
    stubScrollerGeometry();
    const many = Array.from({ length: 200 }, (_, i) => c({ id: `r${i}`, pin: i + 1, path: `f${String(i).padStart(3, "0")}.ts` }));
    renderList(many);
    const mounted = document.querySelectorAll("[data-comment-row]").length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(60);
    expect(VIRTUALISE_ABOVE).toBe(60);
  });

  it("does not virtualise a short list", () => {
    renderList(Array.from({ length: 30 }, (_, i) => c({ id: `r${i}`, pin: i + 1 })));
    expect(document.querySelectorAll("[data-comment-row]").length).toBe(30);
  });

  it("list-level states: loading skeleton, load error with Retry, empty, cap", () => {
    const loading = renderList([], { status: "loading" });
    expect(screen.getByText("Loading comments…")).toBeInTheDocument();
    loading.unmount();

    const err = renderList([], { status: "error" });
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t load comments.");
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }));
    expect(err.props.onRetryLoad).toHaveBeenCalled();
    err.unmount();

    const empty = renderList([]);
    expect(screen.getByText("No comments yet.")).toBeInTheDocument();
    expect(screen.getByText("Select text and press C, or click + in a gutter.")).toBeInTheDocument();
    empty.unmount();

    renderList(Array.from({ length: 500 }, (_, i) => c({ id: `r${i}`, pin: i + 1 })));
    expect(screen.getByText("Limit reached — delete or send some comments")).toBeInTheDocument();
  });

  it("names where comments are attached", () => {
    const name = (k: string) => (k === "session:a" ? "main" : "reviewer");
    expect(attachedWhere(["session:a", "session:a"], name)).toBe("in the main chat box");
    expect(attachedWhere(["session:a", "session:b"], name)).toBe("in 2 chat boxes");
  });

  it("shows bidi characters in comment text and quote literally (R1F-01)", () => {
    renderList([c({ id: "a", text: "evil\u202Etext", quote: "q\u200Bq" })]);
    expect(screen.getByText("evil<U+202E>text")).toBeInTheDocument();
    expect(screen.getByText("q<U+200B>q")).toBeInTheDocument();
  });
});
