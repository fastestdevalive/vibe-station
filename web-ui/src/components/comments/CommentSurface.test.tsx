import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import type { ReviewComment } from "@/api/types";
import { getLexicalEditor } from "@/components/chat/lexicalTestSeam";
import { CodeView } from "@/components/preview/CodeView";
import { DiffView } from "@/components/preview/DiffView";
import { useWorkspaceStore } from "@/hooks/useStore";
import { CommentSurfaceProvider } from "./CommentSurfaceProvider";
import { useCommentSurface } from "./CommentSurfaceContext";
import { anchorHash, listPathDrafts, loadDraft } from "./commentDrafts";
import { ReviewApiError } from "@/api/errors";
import { useCommentStore } from "./useCommentStore";
import { useCommentsSync } from "./useCommentsSync";

if (typeof Range !== "undefined" && !Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, toJSON: () => {} }) as DOMRect;
}
if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
}
if (typeof Text !== "undefined" && !(Text.prototype as unknown as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect) {
  (Text.prototype as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({ x: 0, y: 0, bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, toJSON: () => {} }) as DOMRect;
}

const PATH = "src/a.ts";
const DIFF = ["@@ -1,4 +1,4 @@", " keep one", "-removed two", "+added two", " keep three"].join("\n");
const FILE = "keep one\nadded two\nkeep three\n";

function Harness({ api, children, scope = "local", fileText = FILE }: { api: ReturnType<typeof createMockApi>; children: ReactNode; scope?: "local" | "branch" | "commit"; fileText?: string | null }) {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  useCommentsSync(api);
  return (
    <CommentSurfaceProvider
      api={api}
      scopeKind="worktree"
      scopeId="wt-1"
      path={PATH}
      pathKind="repo"
      rootEl={root}
      disabledReason={scope === "commit" ? "Comments aren’t available on commits" : null}
      diffScope={scope}
      fileText={fileText}
    >
      <div className="preview-body" data-comment-surface="" tabIndex={-1} ref={setRoot}>
        {children}
      </div>
    </CommentSurfaceProvider>
  );
}

function diffView() {
  return <DiffView diffText={DIFF} fileContentFallback={FILE} filePath={PATH} interactive />;
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
const ctrlEnter = async () =>
  act(async () => {
    fireEvent.keyDown(screen.getByLabelText("Comment"), { key: "Enter", ctrlKey: true });
  });

function textNodes(el: Element): Text[] {
  const out: Text[] = [];
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n as Text);
  return out;
}

const pluses = () => [...document.querySelectorAll<HTMLElement>("[data-comment-plus]")];

beforeEach(() => {
  localStorage.clear();
  useCommentStore.getState().reset();
  useWorkspaceStore.setState({ diffLayoutMode: "inline" } as never);
});

async function mounted(api: ReturnType<typeof createMockApi>, node: ReactNode, scope: "local" | "branch" | "commit" = "local") {
  const utils = render(<Harness api={api} scope={scope}>{node}</Harness>);
  await waitFor(() => expect(useCommentStore.getState().byScope["wt-1"]?.status === "ready" || scope === "commit").toBe(true));
  return utils;
}

describe("DiffView comments (5.T2)", () => {
  it("renders a + per row (added, removed, context), every row with data-side and data-old-line", async () => {
    await mounted(createMockApi(), diffView());
    const rows = [...document.querySelectorAll<HTMLElement>(".diff-line")];
    expect(rows).toHaveLength(4);
    expect(pluses()).toHaveLength(4);
    const removed = document.querySelector<HTMLElement>(".diff-line--removed")!;
    expect(removed.getAttribute("data-side")).toBe("old");
    expect(removed.getAttribute("data-old-line")).toBe("2");
    expect(removed.hasAttribute("data-line")).toBe(false);
    const added = document.querySelector<HTMLElement>(".diff-line--added")!;
    expect(added.getAttribute("data-side")).toBe("new");
    expect(added.getAttribute("data-line")).toBe("2");
  });

  it("clicking + opens the box under that row; Add saves a diff comment and renders its pin and card", async () => {
    const api = createMockApi();
    const create = vi.spyOn(api, "createComment");
    await mounted(api, diffView());
    fireEvent.click(document.querySelector(".diff-line--added [data-comment-plus]")!);
    const box = await screen.findByRole("group", { name: "New comment" });
    expect(within(box).getByText("L2 · +")).toBeInTheDocument();
    expect(box.closest(".comment-rowstack")!.previousElementSibling).toBe(document.querySelector(".diff-line--added"));
    await typeInto("Badge the icon");
    await ctrlEnter();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![2]).toMatchObject({
      path: PATH,
      pathKind: "repo",
      surface: "diff",
      diffScope: "local",
      side: "new",
      lineStart: 2,
      lineEnd: 2,
      newStart: 2,
      quote: "added two",
      text: "Badge the icon",
    });
    await waitFor(() => expect(document.querySelector("[data-comment-pin]")).toBeTruthy());
    expect(screen.queryByRole("group", { name: "New comment" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Comment #1" })).toHaveTextContent("Badge the icon");
    expect(document.querySelector(".diff-line--added")!.className).toContain("diff-line--commented");
    expect(document.querySelector("[data-comment-pin]")!.getAttribute("aria-label")).toMatch(/^Comment #1 \(1 of 1\): Badge the icon/);
  });

  it("retrying a failed save reuses the same comment id (no duplicate; review 18)", async () => {
    const api = createMockApi();
    const create = vi.spyOn(api, "createComment").mockRejectedValueOnce(new Error("response lost"));
    await mounted(api, diffView());
    fireEvent.click(document.querySelector(".diff-line--added [data-comment-plus]")!);
    await screen.findByRole("group", { name: "New comment" });
    await typeInto("retry me");
    await ctrlEnter();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("response lost")).toBeInTheDocument();
    await ctrlEnter();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]![2].id).toBe(create.mock.calls[0]![2].id);
  });

  it("a comment on a deleted line uses the old side and old line numbers", async () => {
    const api = createMockApi();
    const create = vi.spyOn(api, "createComment");
    await mounted(api, diffView());
    fireEvent.click(document.querySelector(".diff-line--removed [data-comment-plus]")!);
    const box = await screen.findByRole("group", { name: "New comment" });
    expect(within(box).getByText("L2 · −")).toBeInTheDocument();
    await typeInto("why remove");
    await ctrlEnter();
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![2]).toMatchObject({ side: "old", lineStart: 2, oldStart: 2, oldEnd: 2, quote: "removed two" });
    expect(create.mock.calls[0]![2].newStart).toBeUndefined();
  });

  it("commit scope renders no + and no comment UI", async () => {
    await mounted(createMockApi(), <DiffView diffText={DIFF} filePath={PATH} interactive />, "commit");
    expect(pluses()).toHaveLength(0);
  });

  it("a non-interactive diff (chat tool card) stays inert even inside a surface", async () => {
    await mounted(createMockApi(), <DiffView diffText={DIFF} filePath={PATH} />);
    expect(pluses()).toHaveLength(0);
  });

  it("edit and delete through the card", async () => {
    const api = createMockApi();
    await api.createComment("wt-1", "worktree", { id: "x1", path: PATH, pathKind: "repo", surface: "diff", diffScope: "local", side: "new", lineStart: 2, lineEnd: 2, newStart: 2, newEnd: 2, quote: "added two", prefix: "", suffix: "", occurrence: 0, text: "first" });
    const patch = vi.spyOn(api, "patchComment");
    const del = vi.spyOn(api, "deleteComment");
    await mounted(api, diffView());
    await screen.findByRole("group", { name: "Comment #1" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(await screen.findByText("Editing comment 1 · L2")).toBeInTheDocument();
    await typeInto("second");
    await ctrlEnter();
    await waitFor(() => expect(patch).toHaveBeenCalledWith("x1", expect.objectContaining({ text: "second" })));
    await waitFor(() => expect(screen.getByRole("group", { name: "Comment #1" })).toHaveTextContent("second"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("x1"));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Comment #1" })).not.toBeInTheDocument());
  });

  it("a failed delete brings the comment back and says so (review 19)", async () => {
    const api = createMockApi();
    await api.createComment("wt-1", "worktree", { id: "x1", path: PATH, pathKind: "repo", surface: "diff", diffScope: "local", side: "new", lineStart: 2, lineEnd: 2, newStart: 2, newEnd: 2, quote: "added two", prefix: "", suffix: "", occurrence: 0, text: "first" });
    vi.spyOn(api, "deleteComment").mockRejectedValue(new Error("daemon down"));
    await mounted(api, diffView());
    await screen.findByRole("group", { name: "Comment #1" });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText(/Couldn’t delete the comment: daemon down/)).toBeInTheDocument();
    expect(await screen.findByRole("group", { name: "Comment #1" })).toBeInTheDocument();
  });

  it("a comment inside a collapsed hunk shows a count chip, and the chip expands it", async () => {
    const api = createMockApi();
    await api.createComment("wt-1", "worktree", { id: "x1", path: PATH, pathKind: "repo", surface: "diff", diffScope: "local", side: "new", lineStart: 2, lineEnd: 2, newStart: 2, newEnd: 2, quote: "added two", prefix: "", suffix: "", occurrence: 0, text: "c" });
    await mounted(api, diffView());
    fireEvent.click(screen.getByLabelText("Collapse hunk"));
    expect(document.querySelector(".diff-line")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /Expand hunk with 1 comment/ }));
    expect(document.querySelectorAll(".diff-line").length).toBe(4);
  });
});

describe("selection, c shortcut and keyboard-only flow (5.T3, 5.T4)", () => {
  it("a selection across removed and added rows then c opens a box with the selected text and both ranges", async () => {
    const api = createMockApi();
    const create = vi.spyOn(api, "createComment");
    await mounted(api, diffView());
    const rows = document.querySelectorAll(".diff-line");
    const range = document.createRange();
    const [startText] = textNodes(rows[1]!.querySelector(".diff-line-text")!);
    const endTexts = textNodes(rows[2]!.querySelector(".diff-line-text")!);
    const endText = endTexts[endTexts.length - 1]!;
    range.setStart(startText!, 0);
    range.setEnd(endText, endText.length);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    fireEvent.keyDown(rows[2]!.querySelector(".diff-line-text")!, { key: "c" });
    const box = await screen.findByRole("group", { name: "New comment" });
    expect(box).toHaveTextContent("removed two");
    await typeInto("both sides");
    await ctrlEnter();
    await waitFor(() => expect(create).toHaveBeenCalled());
    const body = create.mock.calls[0]![2];
    expect(body.quote).toBe("removed two\nadded two");
    expect(body).toMatchObject({ side: "old", oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 2 });
  });

  it("keyboard only: focus the gutter +, c, type, Ctrl+Enter, focus returns to the + (R85); arrows move between them", async () => {
    const api = createMockApi();
    await mounted(api, diffView());
    await waitFor(() => expect(pluses().some((p) => p.tabIndex === 0)).toBe(true));
    const first = pluses().find((p) => p.tabIndex === 0)!;
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(pluses()[1]);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(pluses()[0]);
    const plus = document.activeElement as HTMLElement;
    fireEvent.keyDown(plus, { key: "c" });
    await screen.findByRole("group", { name: "New comment" });
    await typeInto("from the keyboard");
    await ctrlEnter();
    await waitFor(() => expect(screen.queryByRole("group", { name: "New comment" })).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(plus));
  });

  it("closing a box whose return-focus element is disabled falls back to the surface root", async () => {
    await mounted(createMockApi(), diffView());
    const plus = pluses()[0]!;
    plus.focus();
    fireEvent.keyDown(plus, { key: "c" });
    await screen.findByRole("group", { name: "New comment" });
    // A disabled/hidden element silently refuses focus (jsdom does not model that), leaving it on <body>.
    plus.focus = () => {};
    plus.blur();
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText("Comment"), { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryByRole("group", { name: "New comment" })).not.toBeInTheDocument());
    const rootEl = document.querySelector<HTMLElement>("[data-comment-surface]")!;
    await waitFor(() => expect(document.activeElement).toBe(rootEl));
  });

  it("Esc with typed text asks first, and cancelling restores focus to the +", async () => {
    await mounted(createMockApi(), diffView());
    const plus = pluses()[0]!;
    plus.focus();
    fireEvent.keyDown(plus, { key: "c" });
    await screen.findByRole("group", { name: "New comment" });
    await typeInto("keep me");
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText("Comment"), { key: "Escape" });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "New comment" })).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(plus));
  });
});

describe("selection popover", () => {
  it("shows Comment [C] / Copy for a valid selection; Comment opens the box and clears the selection", async () => {
    await mounted(createMockApi(), diffView());
    const row = document.querySelector(".diff-line--added .diff-line-text")!;
    const [t] = textNodes(row);
    const range = document.createRange();
    range.setStart(t!, 0);
    range.setEnd(t!, 5);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    fireEvent.pointerUp(document);
    const bar = await screen.findByRole("toolbar", { name: "Selection actions" });
    expect(within(bar).getByRole("button", { name: /Comment/ })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Copy" })).toBeInTheDocument();
    fireEvent.click(within(bar).getByRole("button", { name: /Comment/ }));
    const box = await screen.findByRole("group", { name: "New comment" });
    expect(box).toHaveTextContent("added");
    expect(screen.queryByRole("toolbar", { name: "Selection actions" })).not.toBeInTheDocument();
  });

  it("a collapsed selection hides it", async () => {
    await mounted(createMockApi(), diffView());
    const [t] = textNodes(document.querySelector(".diff-line--added .diff-line-text")!);
    const range = document.createRange();
    range.setStart(t!, 0);
    range.setEnd(t!, 3);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    fireEvent.pointerUp(document);
    await screen.findByRole("toolbar", { name: "Selection actions" });
    act(() => sel.removeAllRanges());
    fireEvent(document, new Event("selectionchange"));
    await waitFor(() => expect(screen.queryByRole("toolbar", { name: "Selection actions" })).not.toBeInTheDocument());
  });
});

describe("drafts per device (5.T8)", () => {
  it("a typed draft survives a remount and a reload (the box reopens with its text); discard clears it", async () => {
    const api = createMockApi();
    const first = await mounted(api, diffView());
    fireEvent.click(document.querySelector(".diff-line--added [data-comment-plus]")!);
    await screen.findByRole("group", { name: "New comment" });
    await typeInto("half typed {x}");
    await waitFor(() => expect(listPathDrafts("worktree:wt-1", PATH)).toHaveLength(1));
    const stored = listPathDrafts("worktree:wt-1", PATH)[0]!;
    expect(stored.key).toContain(anchorHash(stored.anchor));
    expect(loadDraft(stored.key)).toBe("half typed \\{x}");
    first.unmount();
    useCommentStore.getState().reset();

    await mounted(api, diffView());
    const reopened = await screen.findByRole("group", { name: "New comment" });
    expect(reopened).toBeInTheDocument();
    expect(screen.getByLabelText("Comment").textContent).toContain("half typed {x}");
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText("Comment"), { key: "Escape" });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(listPathDrafts("worktree:wt-1", PATH)).toHaveLength(0));
  });
});

describe("side-by-side column clamp (5.T11)", () => {
  beforeEach(() => useWorkspaceStore.setState({ diffLayoutMode: "side-by-side" } as never));

  it("mousedown in the right cell makes the left cells' text user-select:none; it survives mouseup and clears when the selection does", async () => {
    await mounted(createMockApi(), diffView());
    const right = document.querySelector<HTMLElement>('.diff-line[data-side="new"] .diff-line-text')!;
    const left = [...document.querySelectorAll<HTMLElement>('.diff-line[data-side="old"] .diff-line-text')];
    expect(left.length).toBeGreaterThan(0);
    fireEvent.mouseDown(right, { button: 0 });
    for (const l of left) expect(l.style.userSelect).toBe("none");
    for (const r of document.querySelectorAll<HTMLElement>('.diff-line[data-side="new"] .diff-line-text')) expect(r.style.userSelect).toBe("");
    fireEvent.mouseUp(document);
    for (const l of left) expect(l.style.userSelect).toBe("none");
    document.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    for (const l of left) expect(l.style.userSelect).toBe("");
  });

  it("Esc with a collapsed selection restores; blur no longer does", async () => {
    await mounted(createMockApi(), diffView());
    const right = document.querySelector<HTMLElement>('.diff-line[data-side="new"] .diff-line-text')!;
    const left = document.querySelector<HTMLElement>('.diff-line[data-side="old"] .diff-line-text')!;
    fireEvent.mouseDown(right, { button: 0 });
    fireEvent.blur(window);
    expect(left.style.userSelect).toBe("none");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(left.style.userSelect).toBe("");
  });

  it("a selection with endpoints in different columns yields no popover and c does nothing", async () => {
    await mounted(createMockApi(), diffView());
    const l = document.querySelector('.diff-line[data-side="old"] .diff-line-text')!;
    const r = document.querySelector('.diff-line[data-side="new"] .diff-line-text')!;
    const range = document.createRange();
    range.setStart(l.firstChild!, 1);
    range.setEnd(r.firstChild!, 2);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    fireEvent.keyDown(r, { key: "c" });
    await act(async () => {
      await new Promise((res) => setTimeout(res, 30));
    });
    expect(screen.queryByRole("group", { name: "New comment" })).not.toBeInTheDocument();
    expect(screen.queryByRole("toolbar", { name: "Selection actions" })).not.toBeInTheDocument();
  });

  it("a left-cell (removed line) comment records the old side and old line numbers", async () => {
    const api = createMockApi();
    const create = vi.spyOn(api, "createComment");
    await mounted(api, diffView());
    fireEvent.click(document.querySelector('.diff-line[data-side="old"].diff-line--removed [data-comment-plus]')!);
    await screen.findByRole("group", { name: "New comment" });
    await typeInto("left");
    await ctrlEnter();
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![2]).toMatchObject({ side: "old", lineStart: 2, oldStart: 2, oldEnd: 2 });
    // the comment row spans both columns
    await waitFor(() => expect(document.querySelector(".comment-rowstack")).toBeTruthy());
  });
});

describe("CodeView (5.T7)", () => {
  function makeScroller() {
    const el = document.createElement("div");
    el.getBoundingClientRect = () => ({ top: 0, left: 0, right: 800, bottom: 500, width: 800, height: 500, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    Object.defineProperty(el, "clientHeight", { value: 500, configurable: true });
    Object.defineProperty(el, "clientWidth", { value: 800, configurable: true });
    Object.defineProperty(el, "offsetHeight", { value: 500, configurable: true });
    Object.defineProperty(el, "scrollHeight", { value: 2_000_000, configurable: true });
    return el;
  }
  const big = Array.from({ length: 2500 }, (_, i) => `const line${i + 1} = ${i};`).join("\n");

  function Open({ line }: { line: number }) {
    const cs = useCommentSurface();
    return (
      <button
        type="button"
        data-testid="open"
        onClick={() =>
          cs?.openNew({ surface: "file", lineStart: line, lineEnd: line, quote: `const line${line}`, prefix: "", suffix: "", occurrence: 0 })
        }
      />
    );
  }

  it("keeps the open comment row mounted while it is far outside the window", async () => {
    const api = createMockApi();
    const scroller = makeScroller();
    render(
      <Harness api={api} fileText={big}>
        <Open line={2400} />
        <CodeView code={big} filePath={PATH} scrollElRef={{ current: scroller }} />
      </Harness>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(document.querySelector(".workspace-code-viewer--virtual")).toBeTruthy();
    expect(document.querySelector('.workspace-code-line[data-line="2400"]')).toBeNull();
    fireEvent.click(screen.getByTestId("open"));
    const box = await screen.findByRole("group", { name: "New comment" });
    expect(box).toBeInTheDocument();
    expect(document.querySelector('.workspace-code-line[data-line="2400"]')).toBeTruthy();
    expect(document.querySelectorAll(".workspace-code-line").length).toBeLessThan(200);
  });

  it("a plain code line gets a gutter + and a whole-line anchor", async () => {
    const api = createMockApi();
    const create = vi.spyOn(api, "createComment");
    render(
      <Harness api={api} fileText={"alpha\nbeta\n"}>
        <CodeView code={"alpha\nbeta\n"} filePath={PATH} />
      </Harness>,
    );
    await waitFor(() => expect(pluses().length).toBeGreaterThan(0));
    fireEvent.click(pluses()[1]!);
    await screen.findByRole("group", { name: "New comment" });
    await typeInto("on beta");
    await ctrlEnter();
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![2]).toMatchObject({ surface: "file", lineStart: 2, lineEnd: 2, quote: "beta", prefix: "alpha\n" });
    expect(create.mock.calls[0]![2].side).toBeUndefined();
    expect(create.mock.calls[0]![2].diffScope).toBeUndefined();
  });
});

describe("multi-device notices through the surface (6.T11 groundwork)", () => {
  it("a comment deleted elsewhere while edited keeps the box with Restore; sent elsewhere has no Restore", async () => {
    const api = createMockApi();
    const c = await api.createComment("wt-1", "worktree", { id: "x1", path: PATH, pathKind: "repo", surface: "diff", diffScope: "local", side: "new", lineStart: 2, lineEnd: 2, newStart: 2, newEnd: 2, quote: "added two", prefix: "", suffix: "", occurrence: 0, text: "mine" });
    await mounted(api, diffView());
    await screen.findByRole("group", { name: "Comment #1" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByText("Editing comment 1 · L2");
    act(() => api.__test.emit({ type: "comments:changed", scopeKind: "worktree", scopeId: "wt-1", upserted: [], deleted: [{ id: c.id, reason: "deleted" }] }));
    expect(await screen.findByText("Deleted on another device.")).toBeInTheDocument();
    const create = vi.spyOn(api, "createComment");
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("wt-1", "worktree", expect.objectContaining({ id: "x1", text: "mine", restorePin: 1 })));
    await waitFor(() => expect(screen.queryByText("Deleted on another device.")).not.toBeInTheDocument());
  });

  it("sent from another device: Discard + Copy text only", async () => {
    const api = createMockApi();
    const c = await api.createComment("wt-1", "worktree", { id: "x2", path: PATH, pathKind: "repo", surface: "diff", diffScope: "local", side: "new", lineStart: 2, lineEnd: 2, newStart: 2, newEnd: 2, quote: "added two", prefix: "", suffix: "", occurrence: 0, text: "mine" });
    await mounted(api, diffView());
    await screen.findByRole("group", { name: "Comment #1" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByText("Editing comment 1 · L2");
    act(() => api.__test.emit({ type: "comments:changed", scopeKind: "worktree", scopeId: "wt-1", upserted: [], deleted: [{ id: c.id, reason: "sent" }] }));
    expect(await screen.findByText("Sent from another device.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy text" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByText("Sent from another device.")).not.toBeInTheDocument());
  });
});

describe("W2-04 — the c shortcut on a gutter + belongs to the surface that owns it", () => {
  it("with two surfaces mounted, c on a + in A opens a box in A only", async () => {
    const api = createMockApi();
    const code = "alpha\nbeta\n";
    render(
      <>
        <div data-testid="a">
          <Harness api={api} fileText={code}>
            <CodeView code={code} filePath={PATH} />
          </Harness>
        </div>
        <div data-testid="b">
          <Harness api={api} fileText={code}>
            <CodeView code={code} filePath={PATH} />
          </Harness>
        </div>
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("a").querySelectorAll("[data-comment-plus]").length).toBeGreaterThan(1));
    const plus = screen.getByTestId("a").querySelectorAll<HTMLElement>("[data-comment-plus]")[1]!;
    plus.focus();
    fireEvent.keyDown(plus, { key: "c" });
    await waitFor(() => expect(screen.getByTestId("a").querySelector('[data-comment-box="new"]')).not.toBeNull());
    expect(screen.getByTestId("b").querySelector('[data-comment-box="new"]')).toBeNull();
  });
});

describe("W2-03 — a comment that vanishes through a refetch (no event)", () => {
  const seed = (api: ReturnType<typeof createMockApi>, id: string) =>
    api.createComment("wt-1", "worktree", { id, path: PATH, pathKind: "repo", surface: "diff", diffScope: "local", side: "new", lineStart: 2, lineEnd: 2, newStart: 2, newEnd: 2, quote: "added two", prefix: "", suffix: "", occurrence: 0, text: "mine" });

  it("an open Edit box stays with the Deleted banner and Restore re-creates it with the typed text", async () => {
    const api = createMockApi();
    await seed(api, "r1");
    await mounted(api, diffView());
    await screen.findByRole("group", { name: "Comment #1" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByText("Editing comment 1 · L2");
    act(() => useCommentStore.getState().replace("wt-1", "worktree", { comments: [], nextPin: 2, terminalDeliveries: [] }));
    expect(await screen.findByText("Deleted on another device.")).toBeInTheDocument();
    const create = vi.spyOn(api, "createComment");
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("wt-1", "worktree", expect.objectContaining({ id: "r1", text: "mine" })));
  });

  it("P-02 — Restore of a comment held by a queued send (409 id_taken) explains it and drops the stale notice", async () => {
    const api = createMockApi();
    await seed(api, "r3");
    await mounted(api, diffView());
    await screen.findByRole("group", { name: "Comment #1" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByText("Editing comment 1 · L2");
    act(() => useCommentStore.getState().replace("wt-1", "worktree", { comments: [], nextPin: 2, terminalDeliveries: [] }));
    await screen.findByText("Deleted on another device.");
    vi.spyOn(api, "createComment").mockRejectedValue(new ReviewApiError("comment id is already in use", 409, "id_taken"));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(await screen.findByText("This comment is in a queued send. Cancel the send to get it back.")).toBeInTheDocument();
    expect(screen.queryByText(/already in use/)).not.toBeInTheDocument();
    expect(useCommentStore.getState().byScope["wt-1"]!.removed.r3).toBeUndefined();
  });

  it("our own delete (removeLocal, then a refetch) still closes the box with no banner", async () => {
    const api = createMockApi();
    await seed(api, "r2");
    await mounted(api, diffView());
    await screen.findByRole("group", { name: "Comment #1" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByText("Editing comment 1 · L2");
    act(() => {
      useCommentStore.getState().removeLocal("wt-1", ["r2"]);
      useCommentStore.getState().replace("wt-1", "worktree", { comments: [], nextPin: 2, terminalDeliveries: [] });
    });
    await waitFor(() => expect(screen.queryByText("Editing comment 1 · L2")).not.toBeInTheDocument());
    expect(screen.queryByText("Deleted on another device.")).not.toBeInTheDocument();
  });
});

export type { ReviewComment };
