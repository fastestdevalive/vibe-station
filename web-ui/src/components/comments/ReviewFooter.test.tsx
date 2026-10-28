import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewCommentSnapshot, ReviewRecord } from "@/api/types";
import { useWorkspaceStore } from "@/hooks/useStore";
import { ReviewFooter, QueuedReviewLine, restoreSummary } from "./ReviewFooter";
import { makeApi } from "./testHarness";
import { TextMessage } from "@/components/chat/TextMessage";
import { MessageList } from "@/components/chat/MessageList";
import { createMockApi } from "@/api/mock";

const snap = (over: Partial<ReviewCommentSnapshot> = {}): ReviewCommentSnapshot => ({
  id: "s1",
  pin: 1,
  path: "src/FilesLeftRail.tsx",
  pathKind: "repo",
  surface: "file",
  lines: { start: 129, end: 129 },
  quote: ">",
  text: "Badge the Artifacts icon.",
  anchor: "anchored",
  ...over,
});
const record = (...comments: ReviewCommentSnapshot[]): ReviewRecord => ({ name: "feat/x", comments });

describe("ReviewFooter (6.T9)", () => {
  it("is a collapsed button with the counts and aria-expanded; expanding shows file link, lines, quote and text", () => {
    render(
      <ReviewFooter
        record={record(snap(), snap({ id: "s2", pin: 2, path: "src/FilesLeftRail.tsx", lines: { start: 132, end: 136 }, quote: "<button …>", text: "Drop the title." }), snap({ id: "s3", pin: 3, path: "docs/a.md", text: "x" }))}
        scopeId="wt-1"
      />,
    );
    const bar = screen.getByRole("button", { name: /3 review comments/ });
    expect(bar).toHaveAttribute("aria-expanded", "false");
    expect(bar).toHaveTextContent("2 files");
    expect(screen.queryByText("Badge the Artifacts icon.")).toBeNull();
    fireEvent.click(bar);
    expect(bar).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByText("L129")).toHaveLength(2);
    expect(screen.getByText("L132–136")).toBeInTheDocument();
    expect(screen.getByText("Badge the Artifacts icon.")).toBeInTheDocument();
    expect(screen.getByText("Drop the title.")).toBeInTheDocument();
  });

  it("pluralises one comment in one file", () => {
    render(<ReviewFooter record={record(snap())} />);
    const bar = screen.getByRole("button", { name: /1 review comment/ });
    expect(bar).toHaveTextContent("1 file");
  });

  it("file links jump to the comment's file and line", () => {
    const spy = vi.fn();
    useWorkspaceStore.setState({ setActiveFilePathAtLine: spy } as never);
    render(<ReviewFooter record={record(snap({ lines: { start: 40, end: 42 } }))} scopeId="wt-1" />);
    fireEvent.click(screen.getByRole("button", { name: /review comment/ }));
    fireEvent.click(screen.getByRole("button", { name: "src/FilesLeftRail.tsx" }));
    expect(spy).toHaveBeenCalledWith("wt-1", "src/FilesLeftRail.tsx", 40);
  });

  it("marks outside-repo, outdated and missing items", () => {
    render(
      <ReviewFooter
        record={record(
          snap({ pathKind: "artifact", path: "/tmp/mockups/rail.html" }),
          snap({ id: "s2", pin: 2, anchor: "outdated" }),
          snap({ id: "s3", pin: 3, anchor: "file_missing", lines: undefined }),
        )}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /review comments/ }));
    expect(screen.getByText("outside repo")).toBeInTheDocument();
    expect(screen.getByText("outdated")).toBeInTheDocument();
    expect(screen.getByText("file no longer exists")).toBeInTheDocument();
  });

  it("Restore to comments (every sent card): reports 'N restored · M already in the panel'", async () => {
    const api = makeApi({ restoreReview: vi.fn().mockResolvedValue({ restored: 2, skipped: 1 }) });
    render(<ReviewFooter record={record(snap(), snap({ id: "s2", pin: 2 }), snap({ id: "s3", pin: 3 }))} sessionId="sess" turnId="turn-9" api={api} />);
    fireEvent.click(screen.getByRole("button", { name: /review comments/ }));
    fireEvent.click(screen.getByRole("button", { name: "Restore to comments" }));
    await waitFor(() => expect(api.restoreReview).toHaveBeenCalledWith("sess", "turn-9"));
    expect(await screen.findByText("2 restored · 1 already in the panel")).toBeInTheDocument();
    expect(restoreSummary(0, 3)).toBe("0 restored · 3 already in the panel");
  });

  it("a refused restore (cancelled or superseded turn) shows the reason", async () => {
    const api = makeApi({ restoreReview: vi.fn().mockRejectedValue(new Error("turn_not_restorable")) });
    render(<ReviewFooter record={record(snap())} sessionId="sess" turnId="t" api={api} />);
    fireEvent.click(screen.getByRole("button", { name: /review comment/ }));
    fireEvent.click(screen.getByRole("button", { name: "Restore to comments" }));
    expect(await screen.findByText("turn_not_restorable")).toBeInTheDocument();
  });

  it("parsed history says so and offers no Restore (no stored snapshot)", () => {
    const api = makeApi();
    render(<ReviewFooter record={record(snap(), snap({ id: "p2", pin: 2 }))} parsed sessionId="sess" turnId="t" api={api} />);
    const bar = screen.getByRole("button", { name: /2 review comments/ });
    expect(bar).toHaveTextContent("parsed from the message text");
    fireEvent.click(bar);
    expect(screen.queryByRole("button", { name: "Restore to comments" })).toBeNull();
  });

  it("the queued card line is not expandable and says queued", () => {
    render(<QueuedReviewLine summary={{ count: 3, files: 2 }} />);
    expect(screen.getByTestId("queued-review-line")).toHaveTextContent("3 review comments2 files· queued");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("review footer in the transcript", () => {
  beforeEach(() => localStorage.clear());

  it("a user bubble shows its text then the footer", () => {
    render(<TextMessage role="user" text="Also check mobile" review={record(snap())} sessionId="s" turnId="t" worktreeId="wt-1" api={createMockApi()} />);
    expect(screen.getByText("Also check mobile")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /1 review comment/ })).toBeInTheDocument();
  });

  it("an empty-message bubble has no text paragraph, the footer is the whole card", () => {
    const { container } = render(<TextMessage role="user" text="" review={record(snap())} />);
    expect(container.querySelector(".chat-bubble__text")).toBeNull();
    expect(screen.getByRole("button", { name: /1 review comment/ })).toBeInTheDocument();
  });

  it("an ordinary empty user message still renders its (empty) text node", () => {
    const { container } = render(<TextMessage role="user" text="" />);
    expect(container.querySelector(".chat-bubble__text")).not.toBeNull();
  });

  const userEvFn = (over: Record<string, unknown>) =>
    ({ id: "e1", sessionId: "s1", ts: new Date().toISOString(), provider: "claude", kind: "user", role: "user", turnId: "t1", ...over }) as never;
  const list = (events: unknown[]) =>
    render(<MessageList events={events as never} pending={[]} turnActive={false} thinking={false} hasMore={false} loadingEarlier={false} onLoadEarlier={() => {}} onLoadAll={() => {}} onRetry={() => {}} api={createMockApi()} worktreeId="wt-1" scope="worktree" sessionId="s1" />);

  it("MessageList shows the footer for a stored review and none on a cancelled row", () => {
    list([userEvFn({ text: "go", review: record(snap()) })]);
    expect(screen.getByRole("button", { name: /1 review comment/ })).toBeInTheDocument();
  });

  it("a cancelled row has no footer", () => {
    list([userEvFn({ text: "go", cancelled: true, review: record(snap()) })]);
    expect(screen.queryByRole("button", { name: /review comment/ })).toBeNull();
    expect(screen.getByText(/Canceled/)).toBeInTheDocument();
  });

  it("imported history: the block is parsed out of the text and shown as the footer (no Restore)", () => {
    const text = ["Also check mobile", "", "Review comments (1) · feat/x", "", "1) File: src/a.ts", "   Lines: 5", '   Quote: "foo"', "   Comment: bar"].join("\n");
    list([userEvFn({ text })]);
    expect(screen.getByText("Also check mobile")).toBeInTheDocument();
    expect(screen.queryByText(/Review comments \(1\)/)).toBeNull();
    const bar = screen.getByRole("button", { name: /1 review comment/ });
    expect(bar).toHaveTextContent("parsed from the message text");
    fireEvent.click(bar);
    expect(screen.getByText("bar")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore to comments" })).toBeNull();
  });

  it("unparsable text stays plain", () => {
    const text = "Review comments (2) · feat/x\n\nnot really";
    list([userEvFn({ text })]);
    expect(screen.getByText(/Review comments \(2\)/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /review comment/ })).toBeNull();
  });

  it("a stored review gets Restore with the session and turn ids", async () => {
    const api = createMockApi();
    const spy = vi.spyOn(api, "restoreReview").mockResolvedValue({ restored: 1, skipped: 0 });
    render(<MessageList events={[userEvFn({ text: "go", review: record(snap()) })] as never} pending={[]} turnActive={false} thinking={false} hasMore={false} loadingEarlier={false} onLoadEarlier={() => {}} onLoadAll={() => {}} onRetry={() => {}} api={api} worktreeId="wt-1" scope="worktree" sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: /1 review comment/ }));
    fireEvent.click(screen.getByRole("button", { name: "Restore to comments" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("s1", "t1"));
  });

  it("shows bidi characters in comment text literally (R1F-01)", () => {
    render(<ReviewFooter record={record(snap({ text: "evil\u202Etext", quote: "q\u200Bq" }))} scopeId="wt-1" />);
    fireEvent.click(screen.getByRole("button", { name: /1 review comment/ }));
    expect(screen.getByText("evil<U+202E>text")).toBeInTheDocument();
    expect(screen.getByText("q<U+200B>q")).toBeInTheDocument();
  });
});
