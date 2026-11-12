import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ChatFindBar, type ChatFindBarProps } from "./ChatFindBar";

describe("ChatFindBar", () => {
  const defaultProps: ChatFindBarProps = {
    sessionId: "sess-1",
    query: "test",
    scope: "messages",
    status: "ready",
    matches: [
      { seq: 10, turnIndex: 1, occurrence: 0, kind: "user" },
      { seq: 20, turnIndex: 2, occurrence: 0, kind: "text" },
    ],
    total: 2,
    totalCapped: false,
    current: { seq: 10, occurrence: 0 },
    newCount: 0,
    listOpen: false,
    backfilling: false,
    turnCount: 10,
    loadedTurnsCount: 10,
    detached: false,
    currentStyleKey: "10/0",
    announcement: "",
    moreOpen: false,
    onSetQuery: vi.fn(),
    onToggleScope: vi.fn(),
    onToggleList: vi.fn(),
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onClose: vi.fn(),
    onToggleMore: vi.fn(),
    onRetry: vi.fn(),
  };

  it("renders count '{n} / {N}' in normal ready state", () => {
    render(<ChatFindBar {...defaultProps} />);
    const countBtn = screen.getByRole("button", { name: "1 of 2, show list" });
    expect(countBtn).toHaveTextContent("1 / 2");
  });

  it("renders count '{n} / 1,000+' when totalCapped", () => {
    render(
      <ChatFindBar
        {...defaultProps}
        total={1000}
        totalCapped={true}
      />
    );
    const countBtn = screen.getByRole("button", { name: "1 of 1,000+, show list" });
    expect(countBtn).toHaveTextContent("1 / 1,000+");
  });

  it("renders count '{n} / {N} · +{k} new' when newCount > 0", () => {
    render(
      <ChatFindBar
        {...defaultProps}
        newCount={3}
      />
    );
    const countBtn = screen.getByRole("button", { name: "1 of 2, show list" });
    expect(countBtn).toHaveTextContent("1 / 2 · +3 new");
  });

  it("renders '{k} here' for short / offline / error states", () => {
    const { rerender } = render(
      <ChatFindBar
        {...defaultProps}
        status="short"
        total={4}
      />
    );
    expect(screen.getByRole("button", { name: "4 here, show list" })).toHaveTextContent("4 here");

    rerender(
      <ChatFindBar
        {...defaultProps}
        status="offline"
        total={5}
      />
    );
    expect(screen.getByRole("button", { name: "5 here, show list" })).toHaveTextContent("5 here");

    rerender(
      <ChatFindBar
        {...defaultProps}
        status="error"
        total={2}
      />
    );
    expect(screen.getByRole("button", { name: "2 here, show list" })).toHaveTextContent("2 here");
  });

  it("renders 'No results' when status is empty", () => {
    render(
      <ChatFindBar
        {...defaultProps}
        status="empty"
        total={0}
        matches={[]}
        current={null}
      />
    );
    const countBtn = screen.getByRole("button", { name: "No results" });
    expect(countBtn).toHaveTextContent("No results");
    expect(countBtn).toHaveClass("fbar__count--danger");
  });

  it("an empty page while the index is still catching up says Indexing, not No results", () => {
    render(
      <ChatFindBar
        {...defaultProps}
        status="empty"
        total={0}
        matches={[]}
        current={null}
        backfilling={true}
      />
    );
    const countBtn = screen.getByRole("button", { name: /Indexing the chat/ });
    expect(countBtn).toHaveTextContent("Indexing…");
    expect(countBtn).not.toHaveClass("fbar__count--danger");
    expect(screen.getByText("Indexing this chat")).toBeInTheDocument();
    expect(screen.queryByText("Nothing in messages")).toBeNull();
  });

  it("keeps the Indexing label while a backfill retry is searching", () => {
    render(
      <ChatFindBar
        {...defaultProps}
        status="searching"
        total={0}
        matches={[]}
        current={null}
        backfilling={true}
      />
    );
    const countBtn = screen.getByRole("button", { name: /Indexing the chat/ });
    expect(countBtn).toHaveTextContent("Indexing…");
  });

  it("renders short banner: 'Type 3+ characters to search the whole chat'", () => {
    render(
      <ChatFindBar
        {...defaultProps}
        status="short"
        query="hi"
      />
    );
    expect(screen.getByText("Type 3+ characters to search the whole chat")).toBeInTheDocument();
  });

  it("renders empty in messages banner: 'Nothing in messages' with 'Include tool calls' button", () => {
    const onToggleScope = vi.fn();
    render(
      <ChatFindBar
        {...defaultProps}
        status="empty"
        scope="messages"
        total={0}
        matches={[]}
        onToggleScope={onToggleScope}
      />
    );
    expect(screen.getByText("Nothing in messages")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "Include tool calls" });
    fireEvent.click(btn);
    expect(onToggleScope).toHaveBeenCalledTimes(1);
  });

  it("renders error banner with 'Whole-chat search failed' and 'Retry' button, with fbar--error class", () => {
    const onRetry = vi.fn();
    render(
      <ChatFindBar
        {...defaultProps}
        status="error"
        onRetry={onRetry}
      />
    );
    expect(screen.getByText("Whole-chat search failed")).toBeInTheDocument();
    const searchBar = screen.getByRole("search");
    expect(searchBar).toHaveClass("fbar--error");
    const retryBtn = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders offline banner: 'Offline · loaded turns only ({L} of {T})'", () => {
    const { rerender } = render(
      <ChatFindBar
        {...defaultProps}
        status="offline"
        turnCount={25}
        loadedTurnsCount={10}
      />
    );
    expect(screen.getByText("Offline · loaded turns only (10 of 25)")).toBeInTheDocument();

    rerender(
      <ChatFindBar
        {...defaultProps}
        status="offline"
        turnCount={0}
        loadedTurnsCount={undefined}
      />
    );
    expect(screen.getByText("Offline · loaded turns only")).toBeInTheDocument();
  });

  it("renders backfilling banner: 'Indexing this chat'", () => {
    render(
      <ChatFindBar
        {...defaultProps}
        status="ready"
        backfilling={true}
      />
    );
    expect(screen.getByText("Indexing this chat")).toBeInTheDocument();
  });

  it("renders detached banner: 'Viewing turns {a}–{b} of {T}' and calls onJumpToLatest", () => {
    const onJumpToLatest = vi.fn();
    render(
      <ChatFindBar
        {...defaultProps}
        status="ready"
        detached={true}
        detachedTurns={[5, 15]}
        turnCount={50}
        onJumpToLatest={onJumpToLatest}
      />
    );
    expect(screen.getByText("Viewing turns 5–15 of 50")).toBeInTheDocument();
    const jumpBtn = screen.getByRole("button", { name: "Jump to latest" });
    fireEvent.click(jumpBtn);
    expect(onJumpToLatest).toHaveBeenCalledTimes(1);
  });

  it("prefixes generated current-match style rule with .chat-pane[data-find-pane=...]", () => {
    const { container } = render(
      <ChatFindBar
        {...defaultProps}
        sessionId="test-session-xyz"
        currentStyleKey="doc42:1"
      />
    );
    const styleEl = container.querySelector("style");
    expect(styleEl).not.toBeNull();
    expect(styleEl?.textContent).toContain('.chat-pane[data-find-pane="test-session-xyz"] mark[data-find-key="doc42\\:1"]');
    expect(styleEl?.textContent).toContain("background: var(--find-current);");
    expect(styleEl?.textContent).toContain("box-shadow: 0 0 0 1px var(--find-ring);");
  });

  it("disables prev and next arrows when matches is empty", () => {
    render(
      <ChatFindBar
        {...defaultProps}
        matches={[]}
        total={0}
      />
    );
    const prevBtn = screen.getByRole("button", { name: "Previous match (Shift+Enter)" });
    const nextBtn = screen.getByRole("button", { name: "Next match (Enter)" });
    expect(prevBtn).toBeDisabled();
    expect(nextBtn).toBeDisabled();
  });

  it("renders count textContent exactly '7 / 9' for matchNum 7 of 9", () => {
    const matches = Array.from({ length: 9 }, (_, i) => ({
      seq: (i + 1) * 10,
      turnIndex: i + 1,
      occurrence: 0,
      kind: "text" as const,
    }));
    render(
      <ChatFindBar
        {...defaultProps}
        matches={matches}
        total={9}
        current={{ seq: 70, occurrence: 0 }}
      />
    );
    const countBtn = screen.getByRole("button", { name: "7 of 9, show list" });
    expect(countBtn.textContent).toBe("7 / 9");
  });

  it("disables count button and list button with matches: [] in short status and resolves input aria-label", () => {
    render(
      <ChatFindBar
        {...defaultProps}
        status="short"
        total={9}
        matches={[]}
        current={null}
      />
    );
    const countBtn = screen.getByRole("button", { name: "9 here" });
    expect(countBtn).toBeDisabled();
    const listBtn = screen.getByRole("button", { name: "List matches (Alt+Enter)" });
    expect(listBtn).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Find in chat" })).toBeInTheDocument();
  });
});
