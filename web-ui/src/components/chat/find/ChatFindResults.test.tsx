import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ChatFindResults } from "./ChatFindResults";
import type { MessageNav } from "../messageNav";
import type { TranscriptSearchMatch } from "@/api/types";

describe("ChatFindResults", () => {
  const matches: TranscriptSearchMatch[] = [
    {
      seq: 10,
      turnIndex: 1,
      occurrence: 0,
      kind: "user",
      snippet: [{ text: "Hello " }, { text: "world", hit: true }],
    },
    {
      seq: 20,
      turnIndex: 2,
      occurrence: 0,
      kind: "text",
      snippet: [{ text: "Agent " }, { text: "world", hit: true }],
    },
    {
      seq: 30,
      turnIndex: 3,
      occurrence: 0,
      kind: "text",
      snippet: [{ text: "Above " }, { text: "world", hit: true }],
    },
    {
      seq: 40,
      turnIndex: 4,
      occurrence: 0,
      kind: "text",
      snippet: [{ text: "Unloaded " }, { text: "world", hit: true }],
    },
  ];

  const mockNav: MessageNav = {
    seqAnchor: vi.fn((seq: number) => {
      if (seq === 10) return "u:turn-1";
      if (seq === 20) return "a:msg-2";
      if (seq === 30) return "a:msg-3";
      return undefined; // seq 40 not loaded
    }),
    anchorWhere: vi.fn((anchor: string) => {
      if (anchor === "u:turn-1") return "in-view";
      if (anchor === "a:msg-2") return "below";
      if (anchor === "a:msg-3") return "above";
      return "in-view";
    }),
    scrollToAnchor: vi.fn(),
    visibleItemRange: vi.fn(() => [0, 10] as [number, number]),
    rowFor: vi.fn(() => null),
    jumpTurn: vi.fn(),
    flashAnchor: vi.fn(),
  };

  const navRef = { current: mockNav };

  it("hovering a row calls neither scrollToAnchor nor any API, only onPeek", () => {
    const onJump = vi.fn();
    const onPeek = vi.fn();
    const onClose = vi.fn();

    render(
      <ChatFindResults
        matches={matches}
        totalCapped={false}
        current={null}
        peekMatch={null}
        navRef={navRef}
        scope="messages"
        onToggleScope={vi.fn()}
        onJump={onJump}
        onPeek={onPeek}
        onClose={onClose}
      />
    );

    const rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(4);

    // Hover first row
    fireEvent.pointerEnter(rows[0]!);
    expect(onPeek).toHaveBeenCalledWith(matches[0]);
    expect(mockNav.scrollToAnchor).not.toHaveBeenCalled();
    expect(onJump).not.toHaveBeenCalled();

    // Leave first row
    fireEvent.pointerLeave(rows[0]!);
    expect(onPeek).toHaveBeenCalledWith(null);
  });

  it("clicking a row calls jumpTo (onJump prop)", () => {
    const onJump = vi.fn();
    const onPeek = vi.fn();
    const onClose = vi.fn();

    render(
      <ChatFindResults
        matches={matches}
        totalCapped={false}
        current={null}
        peekMatch={null}
        navRef={navRef}
        scope="messages"
        onToggleScope={vi.fn()}
        onJump={onJump}
        onPeek={onPeek}
        onClose={onClose}
      />
    );

    const rows = screen.getAllByRole("option");
    fireEvent.click(rows[1]!);
    expect(onJump).toHaveBeenCalledWith(matches[1]);
  });

  it("where-labels follow anchorWhere and 'not loaded'", () => {
    const onJump = vi.fn();
    const onPeek = vi.fn();
    const onClose = vi.fn();

    render(
      <ChatFindResults
        matches={matches}
        totalCapped={false}
        current={null}
        peekMatch={null}
        navRef={navRef}
        scope="messages"
        onToggleScope={vi.fn()}
        onJump={onJump}
        onPeek={onPeek}
        onClose={onClose}
      />
    );

    const whereLabels = screen.getAllByText(/(in view|↑ above|↓ below|not loaded)/);
    expect(whereLabels).toHaveLength(4);
    expect(whereLabels[0]).toHaveTextContent("in view");
    expect(whereLabels[1]).toHaveTextContent("↓ below");
    expect(whereLabels[2]).toHaveTextContent("↑ above");
    expect(whereLabels[3]).toHaveTextContent("not loaded");
  });

  it("where-labels are re-measured when the current match changes", () => {
    let where: "above" | "below" = "below";
    const nav: MessageNav = { ...mockNav, anchorWhere: vi.fn(() => where) };
    const props = {
      matches,
      totalCapped: false,
      peekMatch: null,
      navRef: { current: nav },
      scope: "messages" as const,
      onToggleScope: vi.fn(),
      onJump: vi.fn(),
      onPeek: vi.fn(),
      onClose: vi.fn(),
    };
    const { rerender } = render(<ChatFindResults {...props} current={null} />);
    expect(screen.getAllByText("↓ below")).toHaveLength(3);

    // The jump scrolled the transcript: the same rows are now above.
    where = "above";
    rerender(<ChatFindResults {...props} current={{ seq: 40, occurrence: 0 }} />);
    expect(screen.getAllByText("↑ above")).toHaveLength(3);
  });

  it("the head renders a .fpill whose click calls onToggleScope", () => {
    const onToggleScope = vi.fn();

    render(
      <ChatFindResults
        matches={matches}
        totalCapped={false}
        current={null}
        peekMatch={null}
        navRef={navRef}
        scope="messages"
        onToggleScope={onToggleScope}
        onJump={vi.fn()}
        onPeek={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const pill = screen.getByRole("button", { name: "Tool calls & thinking" });
    expect(pill).toHaveClass("fpill");
    expect(pill).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(pill);
    expect(onToggleScope).toHaveBeenCalledTimes(1);
  });
  it("measures 'where' labels only for the rows it renders, not for every match", () => {
    const many: TranscriptSearchMatch[] = Array.from({ length: 1000 }, (_, i) => ({
      seq: i + 1,
      turnIndex: i + 1,
      occurrence: 0,
      kind: "text",
      snippet: [{ text: "hit", hit: true }],
    }));
    const anchorWhere = vi.fn(() => "below" as const);
    const nav: MessageNav = { ...mockNav, seqAnchor: vi.fn((seq: number) => `a:${seq}`), anchorWhere };

    const { container } = render(
      <ChatFindResults
        matches={many}
        totalCapped={false}
        current={null}
        peekMatch={null}
        navRef={{ current: nav }}
        scope="messages"
        onToggleScope={vi.fn()}
        onJump={vi.fn()}
        onPeek={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const rendered = container.querySelectorAll('[role="option"]').length;
    expect(rendered).toBeLessThan(many.length);
    expect(anchorWhere.mock.calls.length).toBeLessThanOrEqual(rendered);
  });
});
