import { act, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { getLexicalEditor } from "@/components/chat/lexicalTestSeam";
import { MarkdownView } from "@/components/preview/MarkdownView";
import { dismissTop, openEscapeLayers } from "@/lib/escapeLayers";
import { useCommentSurface, type CommentSurfaceValue } from "./CommentSurfaceContext";
import { CommentSurfaceProvider } from "./CommentSurfaceProvider";
import { anchorHash, loadDraft, draftKey } from "./commentDrafts";
import { useCommentStore } from "./useCommentStore";
import { useCommentsSync } from "./useCommentsSync";

const PATH = "docs/a.md";
const SRC = "alpha beta gamma delta\n\nsecond paragraph here";
const rect = (top: number, height = 20): DOMRect => ({ top, height, bottom: top + height, left: 0, right: 10, width: 10, x: 0, y: top, toJSON: () => {} }) as DOMRect;

let surface: CommentSurfaceValue | null = null;
function Probe() {
  surface = useCommentSurface();
  return null;
}

function Harness({ api, children }: { api: ReturnType<typeof createMockApi>; children: ReactNode }) {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  useCommentsSync(api);
  return (
    <CommentSurfaceProvider api={api} scopeKind="worktree" scopeId="wt-1" path={PATH} pathKind="repo" rootEl={root} disabledReason={null} diffScope="local" fileText={SRC}>
      <div className="preview-body" data-comment-surface="" tabIndex={-1} ref={setRoot}>
        <Probe />
        {children}
      </div>
    </CommentSurfaceProvider>
  );
}

const seed = (api: ReturnType<typeof createMockApi>, over: Record<string, unknown>) =>
  api.createComment("wt-1", "worktree", { path: PATH, pathKind: "repo", prefix: "", suffix: "", occurrence: 0, text: "note", ...over } as never);

async function mount(): Promise<void> {
  // jsdom has no layout: put comment `c` far below `a`, so each gets its own pin stack.
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
    return [rect(this.getAttribute("data-comment-id") === "c" ? 200 : 0)] as unknown as DOMRectList;
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { get: () => 600, configurable: true });
  const api = createMockApi();
  await seed(api, { id: "a", surface: "markdown", lineStart: 1, lineEnd: 1, quote: "alpha", text: "first note" });
  await seed(api, { id: "c", surface: "markdown", lineStart: 3, lineEnd: 3, quote: "second", text: "third note" });
  render(
    <Harness api={api}>
      <MarkdownView source={SRC} filePath={PATH} commentSource={{ startLine: 1 }} />
    </Harness>,
  );
  await waitFor(() => expect(document.querySelectorAll("[data-comment-pin]")).toHaveLength(2));
}

const pin = (id: string) => document.querySelector<HTMLElement>(`[data-comment-pin="${id}"]`)!;
const float = () => document.querySelector<HTMLElement>("[data-comment-float]");

function pointer(type: "Down" | "Move" | "Up" | "Cancel", el: Element, init: Record<string, unknown> = {}) {
  const ev = createEvent[`pointer${type}` as "pointerDown"](el, { pointerId: 1, clientX: 5, clientY: 5, button: 0, pointerType: "mouse", bubbles: true, ...init } as never);
  fireEvent(el, ev);
}
const tap = (el: Element, init: Record<string, unknown> = {}) => {
  act(() => {
    pointer("Down", el, init);
    pointer("Up", el, init);
  });
};

async function openBox(): Promise<void> {
  await act(async () => {
    surface!.openNew(
      { surface: "markdown", lineStart: 1, lineEnd: 1, quote: "beta", prefix: "alpha ", suffix: " gamma", occurrence: 0 },
      { anchorEl: pin("a") },
    );
  });
  await screen.findByRole("group", { name: "New comment" });
}
async function typeInto(text: string) {
  const ed = getLexicalEditor(screen.getByLabelText("Comment"))!;
  await act(async () => {
    ed.update(() => {
      const root = $getRoot();
      root.clear();
      const p = $createParagraphNode();
      p.append($createTextNode(text));
      root.append(p);
    });
  });
}

beforeEach(() => {
  localStorage.clear();
  useCommentStore.getState().reset();
  const proto = Range.prototype as unknown as { getClientRects?: () => DOMRectList; getBoundingClientRect?: () => DOMRect };
  proto.getClientRects ??= () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect ??= () => rect(0, 0);
});
afterEach(() => {
  document.getSelection()?.removeAllRanges();
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  vi.restoreAllMocks();
});

describe("rendered markdown card: closing (round 5)", () => {
  it("a click outside closes it; focus is not forced anywhere", async () => {
    await mount();
    fireEvent.click(pin("a"));
    await waitFor(() => expect(float()).not.toBeNull());
    tap(document.body);
    await waitFor(() => expect(float()).toBeNull());
  });

  it("a touch tap outside closes it", async () => {
    await mount();
    fireEvent.click(pin("a"));
    await waitFor(() => expect(float()).not.toBeNull());
    tap(document.body, { pointerType: "touch" });
    await waitFor(() => expect(float()).toBeNull());
  });

  it("tapping the same pin toggles it closed and focuses the pin; another pin replaces the card", async () => {
    await mount();
    fireEvent.click(pin("a"));
    await waitFor(() => expect(float()).toHaveTextContent("first note"));
    tap(pin("c")); // the pointer part of a pin tap is inside (the click handler decides)
    fireEvent.click(pin("c"));
    await waitFor(() => expect(float()).toHaveTextContent("third note"));
    expect(float()).not.toHaveTextContent("first note");
    tap(pin("c"));
    fireEvent.click(pin("c"));
    await waitFor(() => expect(float()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(pin("c")));
  });

  it("a tap inside the float does not close it", async () => {
    await mount();
    fireEvent.click(pin("a"));
    await waitFor(() => expect(float()).not.toBeNull());
    tap(float()!.querySelector(".comment-box__q")!);
    tap(float()!);
    expect(float()).not.toBeNull();
  });

  it.each([
    ["a drag", () => { pointer("Down", document.body); pointer("Move", document.body, { clientX: 40 }); pointer("Up", document.body, { clientX: 40 }); }],
    ["a cancelled touch", () => { pointer("Down", document.body, { pointerType: "touch" }); pointer("Cancel", document.body, { pointerType: "touch" }); pointer("Up", document.body, { pointerType: "touch" }); }],
    ["a right-click", () => { pointer("Down", document.body, { button: 2 }); pointer("Up", document.body, { button: 2 }); }],
  ])("%s is not a tap", async (_n, gesture) => {
    await mount();
    fireEvent.click(pin("a"));
    await waitFor(() => expect(float()).not.toBeNull());
    act(gesture);
    expect(float()).not.toBeNull();
  });

  it("a tap that ends a text selection is not a tap", async () => {
    await mount();
    fireEvent.click(pin("a"));
    await waitFor(() => expect(float()).not.toBeNull());
    const r = document.createRange();
    const node = document.querySelector(".workspace-markdown-preview p")!.lastChild as Text;
    r.setStart(node, 1);
    r.setEnd(node, 5);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(r);
    expect(document.getSelection()!.isCollapsed).toBe(false);
    tap(document.body);
    expect(float()).not.toBeNull();
  });

  it("Esc closes it through the escape-layer stack (one Esc, one layer) and focus returns to the pin", async () => {
    await mount();
    fireEvent.click(pin("a"));
    await waitFor(() => expect(float()).not.toBeNull());
    expect(openEscapeLayers()).toEqual(["comment-box"]);
    expect(dismissTop()).toBe(true);
    await waitFor(() => expect(float()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(pin("a")));
    expect(openEscapeLayers()).toEqual([]);
    expect(dismissTop()).toBe(false);
  });

  it("a bare Escape on the document no longer closes it (no document listener)", async () => {
    await mount();
    fireEvent.click(pin("a"));
    await waitFor(() => expect(float()).not.toBeNull());
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(float()).not.toBeNull();
  });

  it("opening it moves focus to the card's first action", async () => {
    await mount();
    fireEvent.click(pin("a"));
    await waitFor(() => expect(float()).not.toBeNull());
    const active = document.activeElement as HTMLElement;
    expect(active.closest('[data-comment-card="a"]')).not.toBeNull();
    expect(active).toHaveTextContent("Edit");
  });

  it("Edit from the card returns focus to the pin when the box closes", async () => {
    await mount();
    fireEvent.click(pin("a"));
    await waitFor(() => expect(float()).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("group", { name: "Editing comment 1" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(pin("a")));
  });
});

describe("rendered markdown box in the float: outside taps (round 5)", () => {
  it("an empty new box closes on an outside tap together with its draft pin", async () => {
    await mount();
    await openBox();
    tap(document.body);
    await waitFor(() => expect(screen.queryByRole("group", { name: "New comment" })).toBeNull());
    expect(document.querySelector(".comment-pin--draft")).toBeNull();
    expect(document.querySelector("[data-comment-float]")).toBeNull();
  });

  it("a box holding text asks to discard, keeps the text and the stored draft, and a second tap changes nothing", async () => {
    await mount();
    await openBox();
    await typeInto("keep me");
    tap(document.body);
    const dialog = await screen.findByRole("alertdialog", { name: "Discard this comment?" });
    expect(dialog).toBeInTheDocument();
    tap(document.body);
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    const key = draftKey("worktree:wt-1", PATH, anchorHash({ surface: "markdown", lineStart: 1, lineEnd: 1, quote: "beta", occurrence: 0 }));
    expect(loadDraft(key)).toContain("keep me");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("group", { name: "New comment" })).toBeInTheDocument();
  });

  it("a tap inside the box (its own text) does not ask or close", async () => {
    await mount();
    await openBox();
    await typeInto("typed");
    tap(screen.getByLabelText("Comment"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("group", { name: "New comment" })).toBeInTheDocument();
  });

  it("a pin tap with text in the box shows the prompt and does NOT open the card", async () => {
    await mount();
    await openBox();
    await typeInto("keep me");
    tap(pin("c"));
    fireEvent.click(pin("c"));
    await screen.findByRole("alertdialog", { name: "Discard this comment?" });
    expect(document.querySelector('[data-comment-card="c"]')).toBeNull();
    expect(screen.getByRole("group", { name: "New comment" })).toBeInTheDocument();
  });

  it("a pin tap with a clean box closes the box and opens the card", async () => {
    await mount();
    await openBox();
    tap(pin("c"));
    fireEvent.click(pin("c"));
    await waitFor(() => expect(document.querySelector('[data-comment-card="c"]')).not.toBeNull());
    expect(screen.queryByRole("group", { name: "New comment" })).toBeNull();
  });
});
