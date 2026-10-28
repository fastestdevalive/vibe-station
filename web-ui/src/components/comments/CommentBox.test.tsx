import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { getLexicalEditor } from "@/components/chat/lexicalTestSeam";
import { openEscapeLayers, dismissTop } from "@/lib/escapeLayers";
import { CommentBox } from "./CommentBox";
import { saveDraft, loadDraft } from "./commentDrafts";
import { makeComment } from "./testFixtures";

if (typeof Range !== "undefined" && !Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, toJSON: () => {} }) as DOMRect;
}
if (typeof Text !== "undefined" && !(Text.prototype as unknown as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect) {
  (Text.prototype as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({ x: 0, y: 0, bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, toJSON: () => {} }) as DOMRect;
}

const api = createMockApi();
const mentions = { api, projectId: "p1", worktreeId: "wt-1", selfSessionId: null, kinds: ["file" as const] };
const KEY = "vst-comment-draft:worktree:wt-1:src/a.ts:abc";

const key = async (el: Element, k: string, o: Partial<KeyboardEventInit> = {}) => {
  await act(async () => {
    fireEvent.keyDown(el, { key: k, ...o });
  });
};

function renderNew(over: Partial<React.ComponentProps<typeof CommentBox>> = {}) {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  render(
    <CommentBox
      mode="new"
      label="L129 · +"
      quote={"> first line\nsecond"}
      draftKey={KEY}
      mentions={mentions}
      onSave={onSave}
      onCancel={onCancel}
      {...over}
    />,
  );
  return { onSave, onCancel, editor: screen.getByLabelText("Comment") };
}

beforeEach(() => localStorage.clear());

describe("CommentBox new (5.T1)", () => {
  it("shows the quote header, hint, and a disabled Add while empty", () => {
    renderNew();
    expect(screen.getByText("L129 · +")).toBeInTheDocument();
    expect(screen.getByText(/> first line/)).toBeInTheDocument();
    expect(screen.getByText(/to add · Esc to cancel/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add comment" })).toBeDisabled();
  });

  it("adds with Ctrl+Enter (plain Enter is a newline), saving the plain text", async () => {
    saveDraft(KEY, "Badge the icon {x}");
    const { onSave, editor } = renderNew();
    await key(editor, "Enter");
    expect(onSave).not.toHaveBeenCalled();
    await key(editor, "Enter", { ctrlKey: true });
    expect(onSave).toHaveBeenCalledWith("Badge the icon {x}");
  });

  it("the Add button saves too", async () => {
    saveDraft(KEY, "hi");
    const { onSave } = renderNew();
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    expect(onSave).toHaveBeenCalledWith("hi");
  });

  it("Esc with no text cancels at once", async () => {
    const { onCancel, editor } = renderNew();
    await key(editor, "Escape");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Esc with text asks to discard; Keep editing returns, Discard cancels", async () => {
    saveDraft(KEY, "typed");
    const { onCancel, editor } = renderNew();
    await key(editor, "Escape");
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByText("Discard this comment?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByText("Discard this comment?")).not.toBeInTheDocument();
    await key(editor, "Escape");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("registers an escape layer while open, so the tools pane Esc reaches it", async () => {
    const { onCancel } = renderNew();
    expect(openEscapeLayers()).toContain("comment-box");
    act(() => void dismissTop());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("restores a stored draft and persists edits", async () => {
    saveDraft(KEY, "from before");
    renderNew();
    expect(loadDraft(KEY)).toBe("from before");
    const ed = getLexicalEditor(screen.getByLabelText("Comment"))!;
    await act(async () => {
      ed.update(() => {
        const root = $getRoot();
        root.clear();
        const p = $createParagraphNode();
        p.append($createTextNode("rewritten"));
        root.append(p);
      });
    });
    await waitFor(() => expect(loadDraft(KEY)).toBe("rewritten"));
  });

  it("disables Add with the reason when offline or at the cap", () => {
    saveDraft(KEY, "x");
    renderNew({ offline: true });
    expect(screen.getByRole("button", { name: "Add comment" })).toBeDisabled();
    expect(screen.getAllByText("Offline · reconnecting").length).toBeGreaterThan(0);
  });

  it("at the 500 cap Add says why", () => {
    saveDraft(KEY, "x");
    renderNew({ capReached: true });
    expect(screen.getByRole("button", { name: "Add comment" })).toBeDisabled();
    expect(screen.getAllByText("Limit reached — delete or send some comments").length).toBeGreaterThan(0);
  });

  it("stale banner while the quoted text changed", () => {
    renderNew({ stale: true });
    expect(screen.getByText("The quoted text changed while you were typing. Your comment will be saved as outdated.")).toBeInTheDocument();
  });

  it("the @ popover offers files only", async () => {
    renderNew();
    const ed = getLexicalEditor(screen.getByLabelText("Comment"))!;
    await act(async () => {
      ed.update(() => {
        const root = $getRoot();
        root.clear();
        const p = $createParagraphNode();
        const t = $createTextNode("@");
        p.append(t);
        root.append(p);
        t.select(1, 1);
      });
    });
    await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());
    const box = screen.getByRole("listbox");
    expect(box.textContent).not.toMatch(/Agents|Worktrees|Projects|Narrow to/);
  });
});

describe("CommentBox edit / view (5.T1, States 4)", () => {
  it("edit shows 'Editing comment 1 · L129', saves with the save hint, deleted-elsewhere banner offers Restore / Discard", async () => {
    const c = makeComment({ pin: 1, text: "old text" });
    const onSave = vi.fn();
    const onRestore = vi.fn();
    const onDiscard = vi.fn();
    render(
      <CommentBox
        mode="edit"
        label="L129 · +"
        quote="q"
        comment={c}
        draftKey="k-edit"
        seedText="old text"
        mentions={mentions}
        removed={{ reason: "deleted" }}
        onSave={onSave}
        onRestore={onRestore}
        onDiscard={onDiscard}
      />,
    );
    expect(screen.getByText("Editing comment 1 · L129")).toBeInTheDocument();
    expect(screen.getByText("Deleted on another device.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(onRestore).toHaveBeenCalledWith("old text");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onDiscard).toHaveBeenCalled();
  });

  it("sent elsewhere: only Discard and Copy text, no Restore", () => {
    render(
      <CommentBox mode="edit" label="L1" quote="q" comment={makeComment()} draftKey="k2" seedText="t" mentions={mentions} removed={{ reason: "sent" }} />,
    );
    expect(screen.getByText("Sent from another device.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy text" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
  });

  it("W2-05 — scheduled elsewhere says so (not 'Sent'), with the same Discard / Copy text actions", () => {
    render(
      <CommentBox mode="edit" label="L1" quote="q" comment={makeComment()} draftKey="k3" seedText="t" mentions={mentions} removed={{ reason: "scheduled" }} />,
    );
    expect(screen.getByText("Scheduled from another device.")).toBeInTheDocument();
    expect(screen.queryByText("Sent from another device.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy text" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
  });

  it("view card: text, 'unsent', Edit / Delete; outdated shows the note", () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(<CommentBox mode="view" label="L3 · +" quote="q" comment={makeComment({ anchor: "outdated", pin: 4 })} onEdit={onEdit} onDelete={onDelete} />);
    const card = screen.getByRole("group", { name: "Comment #4" });
    expect(card.querySelector(".comment-box__q-prefix")?.textContent).toBe("#4 · ");
    expect(screen.getByText("unsent")).toBeInTheDocument();
    expect(screen.getByText("outdated")).toBeInTheDocument();
    expect(screen.getByText("This quote is no longer in the file · showing where it was")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onEdit).toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalled();
  });
});
