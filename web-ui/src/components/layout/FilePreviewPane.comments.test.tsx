import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/errors";
import { createMockApi } from "@/api/mock";
import { commentJumpLine, jumpToComment } from "@/components/comments/commentJump";
import { makeComment } from "@/components/comments/testFixtures";
import { useCommentStore } from "@/components/comments/useCommentStore";
import { HTML_IFRAME_SANDBOX } from "@/components/preview/htmlDocument";
import { useWorkspaceStore } from "@/hooks/useStore";
import { FilePreviewPane } from "./FilePreviewPane";

if (typeof Range !== "undefined" && !Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, toJSON: () => {} }) as DOMRect;
}
if (typeof Text !== "undefined" && !(Text.prototype as unknown as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect) {
  (Text.prototype as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({ x: 0, y: 0, bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, toJSON: () => {} }) as DOMRect;
}

const seedScope = (comments = [] as ReturnType<typeof makeComment>[]) =>
  useCommentStore.getState().replace("wt-1", "worktree", { comments, nextPin: 10, terminalDeliveries: [] });

beforeEach(() => {
  window.localStorage.clear();
  useCommentStore.getState().reset();
  useWorkspaceStore.setState({
    activeWorktreeId: "wt-1",
    activeFilePath: "src/App.tsx",
    diffScopeByWorktree: { "wt-1": "local" },
    pendingLineTarget: null,
    peekFile: null,
  });
});

describe("FilePreviewPane comments — diff (5.T2, 5.T9)", () => {
  it("marks the body as a comment surface; the strip has no Comment button or hint (selection pill, gutter + and C stay)", async () => {
    seedScope();
    const api = createMockApi();
    const { container } = render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    await waitFor(() => expect(document.querySelectorAll(".diff-line").length).toBeGreaterThan(0));
    expect(container.querySelector(".preview-body")!.hasAttribute("data-comment-surface")).toBe(true);
    // The strip's Comment button and its hint were removed (tools-pane-rework B4.5); the entry points remain.
    expect(screen.queryByText(/Select text and press/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Comment" })).not.toBeInTheDocument();
  });

  it("the hint goes away once the file has a comment", async () => {
    seedScope([makeComment({ path: "src/App.tsx", surface: "diff", diffScope: "local", side: "new", lineStart: 2, lineEnd: 2, newStart: 2, newEnd: 2 })]);
    render(<FilePreviewPane api={createMockApi()} worktreeId="wt-1" />);
    await waitFor(() => expect(document.querySelectorAll(".diff-line").length).toBeGreaterThan(0));
    expect(screen.queryByText(/Select text and press/)).not.toBeInTheDocument();
  });

  it("commit scope: no gutter +, no surface attribute, no Comment button", async () => {
    const api = createMockApi();
    const { container } = render(<FilePreviewPane api={api} worktreeId="wt-1" controlled={{ path: "src/App.tsx", scope: "commit", commitSha: "abc" }} />);
    await waitFor(() => expect(document.querySelectorAll(".diff-line").length).toBeGreaterThan(0));
    expect(document.querySelectorAll("[data-comment-plus]")).toHaveLength(0);
    expect(container.querySelector(".preview-body")!.hasAttribute("data-comment-surface")).toBe(false);
    // No Comment button in the commit strip either (comments are not offered on commits at all).
    expect(screen.queryByRole("button", { name: "Comment" })).not.toBeInTheDocument();
  });

  it("jumping to a comment inside a collapsed hunk expands it first", async () => {
    seedScope();
    const api = createMockApi();
    render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    await waitFor(() => expect(document.querySelectorAll(".diff-line").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByLabelText("Collapse hunk"));
    expect(document.querySelectorAll(".diff-line")).toHaveLength(0);
    act(() => jumpToComment(makeComment({ path: "src/App.tsx", scopeId: "wt-1", lineStart: 2 })));
    await waitFor(() => expect(document.querySelectorAll(".diff-line").length).toBeGreaterThan(0));
  });

  it("an outdated comment opens at its last known span with the 'showing where it was' note", async () => {
    seedScope([
      makeComment({ id: "o1", path: "src/App.tsx", surface: "diff", diffScope: "local", side: "new", lineStart: 2, lineEnd: 2, newStart: 2, newEnd: 2, anchor: "outdated" }),
    ]);
    render(<FilePreviewPane api={createMockApi()} worktreeId="wt-1" />);
    expect(await screen.findByText("This quote is no longer in the file · showing where it was")).toBeInTheDocument();
    // The pin is placed by the measurer one animation frame after the row mounts (gutter, not inline).
    await waitFor(() => expect(document.querySelector('[data-comment-pin="o1"]')).not.toBeNull());
    const pin = document.querySelector('[data-comment-pin="o1"]')!;
    expect(pin.closest(".comment-pin-stack")!.parentElement!.classList.contains("diff-line")).toBe(true);
    expect(pin.className).toContain("comment-pin--outdated");
    expect(pin.getAttribute("aria-label")).toMatch(/, outdated$/);
  });

  it("commentJumpLine: re-anchored span wins, last known otherwise, clamped to the file length", () => {
    expect(commentJumpLine(makeComment({ lineStart: 5, current: { start: 9, end: 9 } }))).toBe(9);
    expect(commentJumpLine(makeComment({ lineStart: 5 }))).toBe(5);
    expect(commentJumpLine(makeComment({ lineStart: 500 }), 40)).toBe(40);
    expect(commentJumpLine(makeComment({ lineStart: undefined, newStart: 7 }))).toBe(7);
  });

  it("a missing file shows 'File not found'", async () => {
    const api = createMockApi();
    vi.spyOn(api, "getFile").mockRejectedValue(new ApiError("nope", 404));
    render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    expect(await screen.findByText("File not found")).toBeInTheDocument();
  });
});

describe("FilePreviewPane comments — HTML (5.T6)", () => {
  beforeEach(() => {
    window.localStorage.removeItem("vibestation:html-preview-mode");
    useWorkspaceStore.setState({ activeFilePath: "page.html", diffScopeByWorktree: {} });
  });

  it("Rendered shows the sandbox banner and no comment surface; the button switches to a commentable Source", async () => {
    seedScope();
    const api = createMockApi();
    vi.spyOn(api, "getFile").mockResolvedValue("<h1>Hi</h1>\n<p>there</p>");
    const { container } = render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    await waitFor(() => expect(container.querySelector('iframe[title="page.html"]')).toBeTruthy());
    expect(screen.getByText("Rendered HTML runs in a sandbox with no script access, so selections can’t be read.")).toBeInTheDocument();
    expect(container.querySelector(".preview-body")!.hasAttribute("data-comment-surface")).toBe(false);
    // The iframe sandbox is untouched by comments.
    expect(container.querySelector("iframe")!.getAttribute("sandbox")).toBe(HTML_IFRAME_SANDBOX);
    expect(HTML_IFRAME_SANDBOX).toBe("allow-popups allow-popups-to-escape-sandbox");

    fireEvent.click(screen.getByRole("button", { name: "Switch to source to comment" }));
    await waitFor(() => expect(container.querySelector('iframe[title="page.html"]')).toBeNull());
    expect(container.querySelector(".preview-body")!.hasAttribute("data-comment-surface")).toBe(true);
    await waitFor(() => expect(document.querySelectorAll("[data-comment-plus]").length).toBe(2));
    expect(screen.queryByText(/Rendered HTML runs in a sandbox/)).not.toBeInTheDocument();
  });

  it("an html Source comment is an html-source comment", async () => {
    seedScope();
    const api = createMockApi();
    vi.spyOn(api, "getFile").mockResolvedValue("<h1>Hi</h1>\n<p>there</p>");
    const create = vi.spyOn(api, "createComment");
    window.localStorage.setItem("vibestation:html-preview-mode", "source");
    render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    await waitFor(() => expect(document.querySelectorAll("[data-comment-plus]").length).toBe(2));
    fireEvent.click(document.querySelectorAll("[data-comment-plus]")[1]!);
    await screen.findByRole("group", { name: "New comment" });
    expect(screen.getByText("L2")).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("FilePreviewPane comments — rendered markdown (5.T5)", () => {
  it("a selection in the segment after a mermaid block stores the absolute source line and the selected quote", async () => {
    seedScope();
    const api = createMockApi();
    const md = ["# Title", "", "```mermaid", "graph TD;", "A-->B", "```", "", "After the diagram, a wrapped", "paragraph continues here."].join("\n");
    vi.spyOn(api, "getFile").mockResolvedValue(md);
    useWorkspaceStore.setState({ activeFilePath: "docs/notes.md", diffScopeByWorktree: {} });
    const { container } = render(<FilePreviewPane api={api} worktreeId="wt-1" />);
    await waitFor(() => expect(container.querySelector("[data-sl]")).toBeTruthy());
    const para = [...container.querySelectorAll("p[data-sl]")].find((p) => p.textContent?.includes("After the diagram"))!;
    // markdown segment 2 starts on the line the fence closed on (6); its first paragraph is at segment line 2
    expect(para.getAttribute("data-sl")).toBe("8");
    expect(para.getAttribute("data-el")).toBe("9");
    const range = document.createRange();
    range.setStart(para.firstChild!, 6);
    range.setEnd(para.firstChild!, 13);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const create = vi.spyOn(api, "createComment");
    fireEvent.keyDown(para, { key: "c" });
    await screen.findByRole("group", { name: "New comment" });
    expect(screen.getByRole("group", { name: "New comment" })).toHaveTextContent("L8–9");
    expect(create).not.toHaveBeenCalled();
  });
});
