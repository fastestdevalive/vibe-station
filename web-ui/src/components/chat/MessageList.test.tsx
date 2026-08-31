import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NormalizedEvent } from "@/api/types";
import { MessageList, groupEvents, mergeToolRuns } from "./MessageList";

function userEvent(turnId: string, text: string, edited = false): NormalizedEvent {
  return {
    id: `${turnId}-${edited ? "edit" : "orig"}`,
    sessionId: "s1",
    ts: new Date().toISOString(),
    provider: "claude",
    kind: "user",
    role: "user",
    text,
    turnId,
    ...(edited ? { edited: true } : {}),
  };
}

describe("groupEvents dedupe (2.T1 / A7)", () => {
  it("keeps ONE bubble per turnId at the first position with the latest text", () => {
    const items = groupEvents([
      userEvent("t1", "original"),
      {
        id: "asst",
        sessionId: "s1",
        ts: "",
        provider: "claude",
        kind: "text",
        text: "…",
        turnId: "t1",
      },
      userEvent("t1", "edited text", true),
    ]);
    const users = items.filter((i) => i.type === "user");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ type: "user", text: "edited text", turnId: "t1" });
    // First position preserved: the user bubble is item 0, assistant after it.
    expect(items[0]!.type).toBe("user");
  });
});

function statusEvent(id: string, text: string): NormalizedEvent {
  return { id, sessionId: "s1", ts: "", provider: "claude", kind: "status", text };
}

function textEvent(id: string, turnId: string, text: string): NormalizedEvent {
  return { id, sessionId: "s1", ts: "", provider: "claude", kind: "text", role: "assistant", text, turnId };
}

function thinkingEvent(id: string, turnId: string, text: string, ts = ""): NormalizedEvent {
  return { id, sessionId: "s1", ts, provider: "claude", kind: "thinking", text, turnId };
}

function toolUseEvent(id: string, turnId: string, ts = ""): NormalizedEvent {
  return { id, sessionId: "s1", ts, provider: "claude", kind: "tool_use", toolName: "Bash", toolId: id, turnId };
}

describe("groupEvents assistant turn boundaries", () => {
  it("merges streaming deltas within a turn but splits consecutive turns", () => {
    const items = groupEvents([
      textEvent("a1", "t1", "Hello "),
      textEvent("a2", "t1", "world"),
      textEvent("b1", "t2", "Second reply"),
      textEvent("c1", "t3", "Third reply"),
    ]);
    const assistants = items.filter((i) => i.type === "assistant") as { text: string }[];
    expect(assistants.map((a) => a.text)).toEqual(["Hello world", "Second reply", "Third reply"]);
  });
});

describe("groupEvents status filtering (RA6 — benign rate-limit noise)", () => {
  it("drops benign 'rate limit: unknown'/'allowed' but keeps real throttles + other notes", () => {
    const items = groupEvents([
      statusEvent("s1", "rate limit: unknown"),
      statusEvent("s2", "rate limit: allowed"),
      statusEvent("s3", "rate limit: rejected"),
      statusEvent("s4", "Turn stopped"),
    ]);
    const texts = items.filter((i) => i.type === "status").map((i) => (i as { text: string }).text);
    expect(texts).toEqual(["rate limit: rejected", "Turn stopped"]);
  });
});

describe("groupEvents thinking merge/close (1.T1 / 1.T2)", () => {
  it("1.T1 — merges thinking across an intervening tool_use (same turnId, non-empty text) into one item", () => {
    const items = groupEvents([
      thinkingEvent("th1", "t1", "reasoning part one", "2024-01-01T00:00:00.000Z"),
      toolUseEvent("tool1", "t1", "2024-01-01T00:00:01.000Z"),
      thinkingEvent("th2", "t1", " and part two", "2024-01-01T00:00:02.000Z"),
    ]);
    const thinkingItems = items.filter((i) => i.type === "thinking");
    expect(thinkingItems).toHaveLength(1);
    expect(thinkingItems[0]).toMatchObject({ text: "reasoning part one and part two", startedTs: "2024-01-01T00:00:00.000Z" });
    expect((thinkingItems[0] as { endedTs?: string }).endedTs).toBeUndefined();
  });

  it("1.T1 — a tool_use from a DIFFERENT turnId does not merge into the still-open group, and closes it", () => {
    const items = groupEvents([
      thinkingEvent("th1", "t1", "turn one reasoning", "2024-01-01T00:00:00.000Z"),
      toolUseEvent("tool1", "t2", "2024-01-01T00:00:05.000Z"),
      thinkingEvent("th2", "t2", "turn two reasoning", "2024-01-01T00:00:06.000Z"),
    ]);
    const thinkingItems = items.filter((i) => i.type === "thinking") as { text: string; turnId?: string; endedTs?: string }[];
    expect(thinkingItems).toHaveLength(2);
    expect(thinkingItems[0]).toMatchObject({ text: "turn one reasoning", turnId: "t1", endedTs: "2024-01-01T00:00:05.000Z" });
    expect(thinkingItems[1]).toMatchObject({ text: "turn two reasoning", turnId: "t2" });
    expect(thinkingItems[1]!.endedTs).toBeUndefined();
  });

  it("1.T2 — a text event after thinking sets endedTs from that event's ts (not a synthetic 'now')", () => {
    // textEvent() stamps ts: "" — a raw event is used here to control the timestamp precisely.
    const items = groupEvents([
      thinkingEvent("th1", "t1", "reasoning", "2024-01-01T00:00:00.000Z"),
      { id: "a1", sessionId: "s1", ts: "2024-01-01T00:00:06.400Z", provider: "claude", kind: "text", text: "answer", turnId: "t1" },
    ]);
    expect((items.find((i) => i.type === "thinking") as { endedTs?: string }).endedTs).toBe("2024-01-01T00:00:06.400Z");
    expect(items.filter((i) => i.type === "assistant")).toHaveLength(1);
  });

  it("1.T2 — a second thinking burst after that text (same turnId) starts a NEW item", () => {
    const items = groupEvents([
      thinkingEvent("th1", "t1", "first burst", "2024-01-01T00:00:00.000Z"),
      textEvent("a1", "t1", "partial answer"),
      thinkingEvent("th2", "t1", "second burst", "2024-01-01T00:00:10.000Z"),
    ]);
    const thinkingItems = items.filter((i) => i.type === "thinking") as { text: string }[];
    expect(thinkingItems).toHaveLength(2);
    expect(thinkingItems.map((i) => i.text)).toEqual(["first burst", "second burst"]);
  });

  it("1.T3 — regression: empty/signature-only thinking events between tool calls still let mergeToolRuns collapse them into ONE toolRun", () => {
    const items = mergeToolRuns(
      groupEvents([
        toolUseEvent("a", "t1"),
        thinkingEvent("th1", "t1", ""),
        toolUseEvent("b", "t1"),
        thinkingEvent("th2", "t1", ""),
        toolUseEvent("c", "t1"),
      ]),
    );
    expect(items.map((i) => i.type)).toEqual(["toolRun"]);
    expect((items[0] as { tools: unknown[] }).tools).toHaveLength(3);
    expect(items.some((i) => i.type === "thinking")).toBe(false);
  });

  it("a group that opened EMPTY but later gained text is not swept under its stale position — the tool run stays whole", () => {
    // The late text arrives AFTER tool b, so it must not render between a and
    // b. The drop-rule keys on emptiness at creation, so the (still logically
    // empty at that point) group stays transparent to the run, and the merged
    // group renders after it.
    const items = mergeToolRuns(
      groupEvents([
        toolUseEvent("a", "t1"),
        thinkingEvent("th1", "t1", ""),
        toolUseEvent("b", "t1"),
        thinkingEvent("th2", "t1", "late reasoning"),
      ]),
    );
    expect(items.map((i) => i.type)).toEqual(["toolRun", "thinking"]);
    expect((items[0] as { tools: unknown[] }).tools).toHaveLength(2);
    expect((items[1] as { text: string }).text).toBe("late reasoning");
  });

  it("an empty/signature-only thinking event NOT sandwiched between tool calls survives and renders 'Thought for Xs'", () => {
    // The common real-world shape: Claude emits signature-only reasoning (text
    // "") and then answers. This used to be dropped in `groupEvents`, so no
    // ThinkingBlock ever rendered for it.
    const closed: NormalizedEvent[] = [
      thinkingEvent("th1", "t1", "", "2024-01-01T00:00:00.000Z"),
      { ...textEvent("a1", "t1", "answer"), ts: "2024-01-01T00:00:04.000Z" },
    ];
    const items = mergeToolRuns(groupEvents(closed));
    expect(items.filter((i) => i.type === "thinking")).toHaveLength(1);

    const { container } = render(<MessageList events={closed} pending={[]} />);
    const block = container.querySelector(".chat-thinking");
    expect(block).toBeTruthy();
    expect(block!.textContent).toContain("Thought for 4s");
  });

  it("hadToolCall: true when a tool call ran while the group was open, false for a thinking-only group", () => {
    const withTool = groupEvents([
      thinkingEvent("th1", "t1", "reasoning", "2024-01-01T00:00:00.000Z"),
      toolUseEvent("tool1", "t1", "2024-01-01T00:00:01.000Z"),
      { ...textEvent("a1", "t1", "answer"), ts: "2024-01-01T00:00:03.000Z" },
    ]).find((i) => i.type === "thinking") as { hadToolCall?: boolean; endedTs?: string };
    expect(withTool.endedTs).toBe("2024-01-01T00:00:03.000Z");
    expect(withTool.hadToolCall).toBe(true);

    const withoutTool = groupEvents([
      thinkingEvent("th1", "t1", "reasoning", "2024-01-01T00:00:00.000Z"),
      { ...textEvent("a1", "t1", "answer"), ts: "2024-01-01T00:00:03.000Z" },
    ]).find((i) => i.type === "thinking") as { hadToolCall?: boolean; endedTs?: string };
    expect(withoutTool.endedTs).toBe("2024-01-01T00:00:03.000Z");
    expect(withoutTool.hadToolCall).toBeFalsy();
  });
});

describe("groupEvents acp-normalize-superset (Phase 3)", () => {
  it("3.T1 — a tool_result with toolStatus in_progress and no toolResult does not erase a previously-set diffs", () => {
    const items = groupEvents([
      toolUseEvent("tc1", "t1"),
      {
        id: "r1",
        sessionId: "s1",
        ts: "",
        provider: "claude",
        kind: "tool_result",
        toolId: "tc1",
        toolDiffs: [{ path: "/a.ts", oldText: "old", newText: "new" }],
        toolStatus: "in_progress",
      },
      {
        id: "r2",
        sessionId: "s1",
        ts: "",
        provider: "claude",
        kind: "tool_result",
        toolId: "tc1",
        toolStatus: "in_progress",
      },
    ]);
    const tool = items.find((i) => i.type === "tool") as { diffs?: unknown[]; status?: string };
    expect(tool.diffs).toEqual([{ path: "/a.ts", oldText: "old", newText: "new" }]);
    expect(tool.status).toBe("in_progress");
  });

  it("3.T2 — a mode_update event produces a status-type RenderItem", () => {
    const items = groupEvents([
      { id: "m1", sessionId: "s1", ts: "", provider: "claude", kind: "mode_update", modeId: "build" },
    ]);
    const status = items.find((i) => i.type === "status") as { text: string };
    expect(status).toBeTruthy();
    expect(status.text).toContain("build");
  });

  it("3.T4 — a text event with no text but a non-empty blocks array renders a non-empty placeholder bubble", () => {
    const items = groupEvents([
      {
        id: "b1",
        sessionId: "s1",
        ts: "",
        provider: "claude",
        kind: "text",
        role: "assistant",
        turnId: "t1",
        blocks: [{ type: "image", mimeType: "image/png", data: "abc" }],
      },
    ]);
    const assistant = items.find((i) => i.type === "assistant") as { text: string };
    expect(assistant).toBeTruthy();
    expect(assistant.text.length).toBeGreaterThan(0);
    expect(assistant.text).not.toBe("");
  });
});

describe("MessageList queued-turn filtering (tray relocation)", () => {
  it("hides user turns listed in hiddenTurnIds from the inline log", () => {
    render(
      <MessageList
        events={[userEvent("t1", "shown msg"), userEvent("t2", "queued msg")]}
        pending={[]}
        hiddenTurnIds={new Set(["t2"])}
      />,
    );
    expect(screen.getByText("shown msg")).toBeTruthy();
    expect(screen.queryByText("queued msg")).toBeNull();
  });

  it("carries no inline queue affordances (they live in the tray now)", () => {
    render(<MessageList events={[userEvent("t1", "queued msg")]} pending={[]} hiddenTurnIds={new Set(["t1"])} />);
    expect(screen.queryByLabelText("Send now")).toBeNull();
    expect(screen.queryByLabelText("Edit queued message")).toBeNull();
    expect(screen.queryByLabelText("Cancel queued turn")).toBeNull();
  });

  it("un-hides a turn once it leaves hiddenTurnIds (dequeued → shown in log)", () => {
    const { rerender } = render(
      <MessageList events={[userEvent("t1", "now running")]} pending={[]} hiddenTurnIds={new Set(["t1"])} />,
    );
    expect(screen.queryByText("now running")).toBeNull();
    rerender(<MessageList events={[userEvent("t1", "now running")]} pending={[]} hiddenTurnIds={new Set()} />);
    expect(screen.getByText("now running")).toBeTruthy();
  });
});

function toolItem(id: string, turnId: string) {
  return { type: "tool" as const, id, toolName: "Bash", turnId, toolInput: { command: "echo" } };
}
function thinkingItem(id: string, turnId: string, text: string) {
  // `openedEmpty` mirrors what `groupEvents` records at push time for a group
  // whose first (and here only) event carries this text.
  return { type: "thinking" as const, id, turnId, text, startedTs: "", openedEmpty: text.trim().length === 0 };
}

describe("mergeToolRuns", () => {
  it("wraps even a lone tool call in a toolRun (consistent new-style rendering)", () => {
    const out = mergeToolRuns([toolItem("a", "t1")]);
    expect(out).toEqual([{ type: "toolRun", id: "a", tools: [toolItem("a", "t1")] }]);
  });

  it("does not let an empty/signature-only thinking event split an otherwise-contiguous tool run", () => {
    const out = mergeToolRuns([
      toolItem("a", "t1"),
      thinkingItem("th", "t1", ""),
      toolItem("b", "t1"),
    ]);
    expect(out).toEqual([{ type: "toolRun", id: "a", tools: [toolItem("a", "t1"), toolItem("b", "t1")] }]);
  });

  it("still splits the run when the thinking event carries real content", () => {
    const out = mergeToolRuns([
      toolItem("a", "t1"),
      thinkingItem("th", "t1", "reasoning about next step"),
      toolItem("b", "t1"),
    ]);
    expect(out.map((i) => i.type)).toEqual(["toolRun", "thinking", "toolRun"]);
  });
});

describe("MessageList consolidated working affordance (1.T5 — ThinkingHint removed)", () => {
  it("never renders .chat-thinking-hint under any prop combination", () => {
    const combos = [
      { thinking: false, turnActive: false },
      { thinking: true, turnActive: false },
      { thinking: false, turnActive: true },
      { thinking: true, turnActive: true },
    ];
    for (const props of combos) {
      const { container, unmount } = render(
        <MessageList events={[userEvent("t1", "do the thing")]} pending={[]} {...props} />,
      );
      expect(container.querySelector(".chat-thinking-hint")).toBeNull();
      unmount();
    }
  });

  it("renders WorkingIndicator during the thinking sub-state (gate widened from turnActive && !thinking to plain turnActive)", () => {
    render(<MessageList events={[userEvent("t1", "do the thing")]} pending={[]} turnActive thinking />);
    expect(screen.getByRole("status", { name: "Agent is working" })).toBeTruthy();
  });
});

describe("MessageList live thinking block suppression", () => {
  // A thinking burst mid-turn: reasoning, then a tool call, group still open.
  const liveEvents: NormalizedEvent[] = [
    userEvent("t1", "do the thing"),
    thinkingEvent("th1", "t1", "let me reason", "2024-01-01T00:00:00.000Z"),
    toolUseEvent("tu1", "t1", "2024-01-01T00:00:01.000Z"),
  ];

  it("renders nothing for a still-open thinking group while the turn is active", () => {
    const { container } = render(<MessageList events={liveEvents} pending={[]} turnActive />);
    expect(container.querySelector(".chat-thinking")).toBeNull();
    expect(screen.queryByText("let me reason")).toBeNull();
    // The tool card around it is unaffected — no gap, no placeholder.
    expect(screen.getByText("Bash")).toBeTruthy();
  });

  it("renders the completed block in its original position once the group closes", () => {
    const closed: NormalizedEvent[] = [
      ...liveEvents,
      { ...textEvent("a1", "t1", "done"), ts: "2024-01-01T00:00:03.000Z" },
    ];
    const { container } = render(<MessageList events={closed} pending={[]} turnActive />);
    const block = container.querySelector(".chat-thinking");
    expect(block).toBeTruthy();
    // "Worked for", not "Thought for": a tool call ran while this group was
    // open (see `liveEvents`), so the completed label takes the tool variant.
    expect(block!.textContent).toContain("Worked for 3s");
    // Position preserved: thinking block precedes the tool card in DOM order.
    const tool = screen.getByText("Bash");
    expect(block!.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("still renders an unclosable (turnId-less) thinking group once the turn is over", () => {
    const noTurn: NormalizedEvent = {
      id: "th0",
      sessionId: "s1",
      ts: "",
      provider: "claude",
      kind: "thinking",
      text: "orphan reasoning",
    };
    const { container } = render(<MessageList events={[noTurn]} pending={[]} />);
    expect(container.querySelector(".chat-thinking")).toBeTruthy();
  });

  it("renders NOTHING for an unclosable (turnId-less) thinking group with no text", () => {
    // Empty + never-closeable: `closeOpenThinking` early-returns without a
    // turnId, so this group can never gain an `endedTs` — rendering it would
    // leave a permanent, live-looking "Thinking" label over dead content.
    const noTurnEmpty: NormalizedEvent = {
      id: "th0",
      sessionId: "s1",
      ts: "",
      provider: "claude",
      kind: "thinking",
      text: "",
    };
    const { container } = render(<MessageList events={[noTurnEmpty]} pending={[]} />);
    expect(container.querySelector(".chat-thinking")).toBeNull();
  });

  it("keeps a turnId-less (historical) thinking group visible while a DIFFERENT turn is running", () => {
    // Imported/resumed transcripts start with `currentTurnId: undefined`, so
    // pre-watermark events carry no turnId and can never be closed — they must
    // not vanish for the whole duration of every unrelated later turn.
    const orphan: NormalizedEvent = {
      id: "th0",
      sessionId: "s1",
      ts: "2024-01-01T00:00:00.000Z",
      provider: "claude",
      kind: "thinking",
      text: "orphan reasoning",
    };
    const { container } = render(
      <MessageList
        events={[
          orphan,
          userEvent("t2", "a brand new question"),
          thinkingEvent("th2", "t2", "live reasoning", "2024-01-01T00:01:00.000Z"),
        ]}
        pending={[]}
        turnActive
      />,
    );
    const blocks = container.querySelectorAll(".chat-thinking");
    // Exactly one: the orphan stays, the LIVE (t2) group is the hidden one.
    expect(blocks).toHaveLength(1);
    const userBubble = screen.getByText("a brand new question");
    expect(blocks[0]!.compareDocumentPosition(userBubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("MessageList persistent working indicator", () => {
  it("renders as the last item in the feed while a turn is active", () => {
    const { container } = render(
      <MessageList events={[userEvent("t1", "do the thing")]} pending={[]} turnActive />,
    );
    const indicator = screen.getByRole("status", { name: "Agent is working" });
    expect(indicator).toBeTruthy();
    // Last item in the list's DOM order (only the invisible bottom-scroll
    // sentinel div may follow it).
    const list = container.querySelector(".chat-message-list")!;
    const lastMeaningfulChild = list.children[list.children.length - 2];
    expect(lastMeaningfulChild).toBe(indicator);
  });

  it("does not render while idle", () => {
    render(<MessageList events={[userEvent("t1", "do the thing")]} pending={[]} />);
    expect(screen.queryByRole("status", { name: "Agent is working" })).toBeNull();
  });

  it("3.T2 — renders the passed workingLabel text alongside the dots", () => {
    const { container } = render(
      <MessageList events={[userEvent("t1", "do the thing")]} pending={[]} turnActive workingLabel="Responding" />,
    );
    expect(screen.getByText("Responding")).toBeTruthy();
    expect(container.querySelectorAll(".chat-working-indicator__dot")).toHaveLength(3);
  });

  it("3.T2 — omits the label span entirely when no workingLabel is passed", () => {
    const { container } = render(
      <MessageList events={[userEvent("t1", "do the thing")]} pending={[]} turnActive />,
    );
    expect(container.querySelector(".chat-working-indicator__label")).toBeNull();
  });

  it("cycles dot count 1 -> 2 -> 3 -> 1 on an interval", () => {
    vi.useFakeTimers();
    try {
      render(<MessageList events={[]} pending={[]} turnActive />);
      const dotOf = () => document.querySelectorAll(".chat-working-indicator__dot--on").length;
      expect(dotOf()).toBe(1);
      act(() => vi.advanceTimersByTime(450));
      expect(dotOf()).toBe(2);
      act(() => vi.advanceTimersByTime(450));
      expect(dotOf()).toBe(3);
      act(() => vi.advanceTimersByTime(450));
      expect(dotOf()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("1.T6 — DOES render during the thinking sub-state (inverted: ThinkingHint, which used to cover this, is gone)", () => {
    render(<MessageList events={[userEvent("t1", "do the thing")]} pending={[]} turnActive thinking />);
    expect(screen.getByRole("status", { name: "Agent is working" })).toBeTruthy();
  });

  it("does not start its dot interval when the user prefers reduced motion", () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    vi.useFakeTimers();
    try {
      render(<MessageList events={[]} pending={[]} turnActive />);
      const dotOf = () => document.querySelectorAll(".chat-working-indicator__dot--on").length;
      expect(dotOf()).toBe(1);
      act(() => vi.advanceTimersByTime(2000));
      expect(dotOf()).toBe(1);
    } finally {
      vi.useRealTimers();
      window.matchMedia = originalMatchMedia;
    }
  });
});

describe("MessageList footer-resize-aware auto-scroll", () => {
  // `render()`'s own mount div is the direct parent of MessageList's root
  // (`.chat-message-list`) — exactly the "scroll container" MessageList reads
  // via `listRef.current.parentElement`, so no extra DOM wiring is needed to
  // simulate it here.
  function mockResizeObserver() {
    let captured: (() => void) | null = null;
    class MockResizeObserver {
      constructor(cb: () => void) {
        captured = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    return {
      trigger: () => captured?.(),
      restore: () => {
        globalThis.ResizeObserver = original;
      },
    };
  }

  // The distance-to-bottom is computed FRESH inside the ResizeObserver
  // callback (not from a cached scroll-listener flag — see the source
  // comment), so these tests stub `scrollHeight`/`clientHeight` directly on
  // the container and assert on `container.scrollTop`, not `scrollIntoView`
  // (which the implementation deliberately does not use for this path, to
  // avoid walking ancestor scrollables).
  it("re-scrolls to bottom when the container resizes while currently near the bottom", () => {
    const ro = mockResizeObserver();
    try {
      const { container } = render(<MessageList events={[userEvent("t1", "hi")]} pending={[]} />);
      Object.defineProperty(container, "scrollHeight", { value: 500, configurable: true });
      Object.defineProperty(container, "clientHeight", { value: 480, configurable: true });
      container.scrollTop = 0; // distance = 500 - 0 - 480 = 20, < 80 → near bottom
      act(() => ro.trigger());
      expect(container.scrollTop).toBe(500);
    } finally {
      ro.restore();
    }
  });

  it("does not force-scroll on resize when the user is currently scrolled away from the bottom", () => {
    const ro = mockResizeObserver();
    try {
      const { container } = render(<MessageList events={[userEvent("t1", "hi")]} pending={[]} />);
      Object.defineProperty(container, "scrollHeight", { value: 1000, configurable: true });
      Object.defineProperty(container, "clientHeight", { value: 300, configurable: true });
      container.scrollTop = 0; // distance = 1000 - 0 - 300 = 700, >= 80 → not near bottom
      act(() => ro.trigger());
      expect(container.scrollTop).toBe(0);
    } finally {
      ro.restore();
    }
  });
});

describe("MessageList primary scroll effect — atBottom guard + jump-to-bottom (Phase 2)", () => {
  // Same rationale as the resize-effect tests above: stub scrollHeight/
  // clientHeight on the render container (which IS `listRef.current.parentElement`),
  // and assert on `container.scrollTop` directly.
  function stubMetrics(container: HTMLElement, scrollHeight: number, clientHeight: number) {
    Object.defineProperty(container, "scrollHeight", { value: scrollHeight, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: clientHeight, configurable: true });
  }

  it("2.T5 — fresh mount with no prior scroll event snaps to bottom (default atBottom = true)", () => {
    // Stub BEFORE mounting (via RTL's `container` option) so the very first
    // render's layout effect — not a later rerender — is what's observed.
    const mountDiv = document.createElement("div");
    document.body.appendChild(mountDiv);
    stubMetrics(mountDiv, 777, 300);
    mountDiv.scrollTop = 0;
    try {
      render(<MessageList events={[userEvent("t1", "hi")]} pending={[]} />, { container: mountDiv });
      expect(mountDiv.scrollTop).toBe(777);
    } finally {
      document.body.removeChild(mountDiv);
    }
  });

  it("2.T2 — content change while atBottom is true (never scrolled away) DOES set scrollTop = scrollHeight", () => {
    const { container, rerender } = render(<MessageList events={[userEvent("t1", "hi")]} pending={[]} />);
    stubMetrics(container, 900, 300);
    container.scrollTop = 0;
    // No `scroll` event fired — atBottomRef stays at its default `true`.
    rerender(<MessageList events={[userEvent("t1", "hi"), userEvent("t2", "hi again")]} pending={[]} />);
    expect(container.scrollTop).toBe(900);
  });

  it("2.T1 — content change while atBottom is false (user scrolled away) does NOT set scrollTop", () => {
    const { container, rerender } = render(<MessageList events={[userEvent("t1", "hi")]} pending={[]} />);
    stubMetrics(container, 1000, 300);
    container.scrollTop = 0; // distance = 1000 - 0 - 300 = 700 → far from bottom
    fireEvent.scroll(container); // atBottomRef -> false
    container.scrollTop = 123; // distinct sentinel value the effect must NOT overwrite
    rerender(<MessageList events={[userEvent("t1", "hi"), userEvent("t2", "hi again")]} pending={[]} />);
    expect(container.scrollTop).toBe(123);
  });

  it("2.T3 — pending.length growing (own send) forces scroll even when atBottom is false", () => {
    const { container, rerender } = render(<MessageList events={[userEvent("t1", "hi")]} pending={[]} />);
    stubMetrics(container, 1000, 300);
    container.scrollTop = 0;
    fireEvent.scroll(container); // atBottomRef -> false
    stubMetrics(container, 1200, 300); // content grew further (the new pending bubble)
    rerender(
      <MessageList
        events={[userEvent("t1", "hi")]}
        pending={[{ turnId: "p1", message: "just sent", attachments: [], queued: false }]}
      />,
    );
    expect(container.scrollTop).toBe(1200);
  });

  it("2.T4 — jump-to-bottom button: absent when atBottom, appears + works when scrolled away, unmounts once back at bottom", () => {
    const { container } = render(<MessageList events={[userEvent("t1", "hi")]} pending={[]} />);
    expect(screen.queryByRole("button", { name: "Jump to latest message" })).toBeNull();

    stubMetrics(container, 1000, 300);
    container.scrollTop = 0; // distance = 700 → far from bottom
    fireEvent.scroll(container);
    const button = screen.getByRole("button", { name: "Jump to latest message" });
    expect(button).toBeTruthy();

    fireEvent.click(button);
    expect(container.scrollTop).toBe(1000);
    // The click handler sets `atBottom` directly (so the button hides
    // immediately without waiting on a real scroll event) — but the same
    // conclusion must also hold via the actual scroll-listener PATH the plan
    // describes, not just the click shortcut. jsdom doesn't fire `scroll`
    // automatically for a programmatic `scrollTop` assignment, so dispatch it
    // explicitly: at scrollTop=1000 (what the click just set) against the
    // same scrollHeight/clientHeight, distance is negative (< 80) — the
    // listener's own "near bottom" computation must independently agree.
    fireEvent.scroll(container);
    expect(screen.queryByRole("button", { name: "Jump to latest message" })).toBeNull();
  });

  it("notifies onAtBottomChange on the scroll path and on the jump-to-bottom click", () => {
    const onAtBottomChange = vi.fn();
    const { container } = render(
      <MessageList events={[userEvent("t1", "hi")]} pending={[]} onAtBottomChange={onAtBottomChange} />,
    );
    // No scroll yet → no notification; the parent's own default (true) holds.
    expect(onAtBottomChange).not.toHaveBeenCalled();

    stubMetrics(container, 1000, 300);
    container.scrollTop = 0; // distance = 700 → scrolled away
    fireEvent.scroll(container);
    expect(onAtBottomChange).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByRole("button", { name: "Jump to latest message" }));
    expect(onAtBottomChange).toHaveBeenLastCalledWith(true);

    // Already at the bottom: the listener's own near-bottom computation
    // (scrollTop = 1000) agrees, so this scroll is NOT a transition and must
    // not re-notify — the callback fires on change only.
    onAtBottomChange.mockClear();
    fireEvent.scroll(container);
    expect(onAtBottomChange).not.toHaveBeenCalled();
  });
});

describe("MessageList auto load-earlier on scroll near top (infinite scroll upward)", () => {
  // Same container idiom as the scroll tests above: RTL's mount div IS
  // `listRef.current.parentElement`, so stubbing scrollHeight/clientHeight on
  // it and driving `fireEvent.scroll` exercises the real listener path.
  function stubMetrics(container: HTMLElement, scrollHeight: number, clientHeight: number) {
    Object.defineProperty(container, "scrollHeight", { value: scrollHeight, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: clientHeight, configurable: true });
  }

  it("triggers onLoadEarlier when scrolled within the near-top threshold", () => {
    const onLoadEarlier = vi.fn();
    const { container } = render(
      <MessageList events={[userEvent("t1", "hi")]} pending={[]} hasMore onLoadEarlier={onLoadEarlier} />,
    );
    stubMetrics(container, 1000, 300);
    container.scrollTop = 10; // < 80px from the top
    fireEvent.scroll(container);
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
  });

  it("does not trigger while scrolled away from the top", () => {
    const onLoadEarlier = vi.fn();
    const { container } = render(
      <MessageList events={[userEvent("t1", "hi")]} pending={[]} hasMore onLoadEarlier={onLoadEarlier} />,
    );
    stubMetrics(container, 1000, 300);
    container.scrollTop = 500;
    fireEvent.scroll(container);
    expect(onLoadEarlier).not.toHaveBeenCalled();
  });

  it("does not trigger once hasMore is false (top of history reached)", () => {
    const onLoadEarlier = vi.fn();
    const { container } = render(
      <MessageList
        events={[userEvent("t1", "hi")]}
        pending={[]}
        hasMore={false}
        onLoadEarlier={onLoadEarlier}
      />,
    );
    stubMetrics(container, 1000, 300);
    container.scrollTop = 0;
    fireEvent.scroll(container);
    expect(onLoadEarlier).not.toHaveBeenCalled();
  });

  it("does not fire duplicate/overlapping calls: repeated scrolls before AND during the in-flight load", () => {
    const onLoadEarlier = vi.fn();
    const { container, rerender } = render(
      <MessageList events={[userEvent("t1", "hi")]} pending={[]} hasMore onLoadEarlier={onLoadEarlier} />,
    );
    stubMetrics(container, 1000, 300);
    container.scrollTop = 0;
    // Several scroll events in the frames BEFORE `loadingEarlier` has come
    // back down as a prop — the internal pending guard must absorb these.
    fireEvent.scroll(container);
    fireEvent.scroll(container);
    fireEvent.scroll(container);
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
    // ...and once the prop does arrive, still no second call.
    rerender(
      <MessageList
        events={[userEvent("t1", "hi")]}
        pending={[]}
        hasMore
        loadingEarlier
        onLoadEarlier={onLoadEarlier}
      />,
    );
    fireEvent.scroll(container);
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
  });

  it("preserves the read position when the older page is prepended (scrollTop += height delta)", () => {
    const onLoadEarlier = vi.fn();
    const props = { pending: [], hasMore: true, onLoadEarlier };
    const { container, rerender } = render(
      <MessageList events={[userEvent("t2", "recent")]} {...props} />,
    );
    stubMetrics(container, 1000, 300);
    container.scrollTop = 0;
    fireEvent.scroll(container); // triggers the load; records pre-prepend height
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);

    rerender(<MessageList events={[userEvent("t2", "recent")]} {...props} loadingEarlier />);
    // The user keeps reading while the fetch is in flight.
    container.scrollTop = 10;

    // Page lands: 600px of older history prepended, loadingEarlier back to false.
    stubMetrics(container, 1600, 300);
    rerender(
      <MessageList events={[userEvent("t1", "older"), userEvent("t2", "recent")]} {...props} />,
    );
    expect(container.scrollTop).toBe(610);
  });

  it("leaves scrollTop alone when the load settles without prepending anything", () => {
    const onLoadEarlier = vi.fn();
    const props = { pending: [], hasMore: true, onLoadEarlier };
    const { container, rerender } = render(
      <MessageList events={[userEvent("t2", "recent")]} {...props} />,
    );
    stubMetrics(container, 1000, 300);
    container.scrollTop = 0;
    fireEvent.scroll(container);
    rerender(<MessageList events={[userEvent("t2", "recent")]} {...props} loadingEarlier />);
    container.scrollTop = 12;
    rerender(<MessageList events={[userEvent("t2", "recent")]} {...props} />);
    expect(container.scrollTop).toBe(12);
  });

  it("keeps a manual 'Load earlier messages' fallback that also routes through the guarded trigger", async () => {
    const onLoadEarlier = vi.fn();
    render(<MessageList events={[userEvent("t1", "hi")]} pending={[]} hasMore onLoadEarlier={onLoadEarlier} />);
    const button = screen.getByRole("button", { name: "Load earlier messages" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
    // ...and the dedupe is genuinely IN-FLIGHT-scoped, not a permanent wedge:
    // once the (here: instantly-settling, never-"loading") call settles, the
    // trigger is armed again.
    await act(async () => {});
    fireEvent.click(button);
    expect(onLoadEarlier).toHaveBeenCalledTimes(2);
  });

  it("does not wedge when the load settles without ever rendering loadingEarlier=true", async () => {
    // Reachable for real: `useChat.loadEarlier` early-returns before
    // `setLoadingEarlier(true)` when there's no cursor, a transport can
    // resolve fast enough that true→false coalesces into one `false` render,
    // and a throw before the flag flips does the same. Any of those used to
    // leave the prepend-pending flag set forever, killing pagination AND the
    // primary auto-scroll effect for the rest of the session.
    const onLoadEarlier = vi.fn(() => Promise.resolve());
    const { container } = render(
      <MessageList events={[userEvent("t1", "hi")]} pending={[]} hasMore onLoadEarlier={onLoadEarlier} />,
    );
    stubMetrics(container, 1000, 300);
    container.scrollTop = 0;
    fireEvent.scroll(container);
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
    await act(async () => {});
    container.scrollTop = 0; // user is still up at the top of the loaded window
    fireEvent.scroll(container);
    expect(onLoadEarlier).toHaveBeenCalledTimes(2);
  });

  it("still releases the pending prepend when the triggered load REJECTS", async () => {
    const onLoadEarlier = vi.fn(() => Promise.reject(new Error("boom")));
    const { container } = render(
      <MessageList events={[userEvent("t1", "hi")]} pending={[]} hasMore onLoadEarlier={onLoadEarlier} />,
    );
    stubMetrics(container, 1000, 300);
    container.scrollTop = 0;
    fireEvent.scroll(container);
    await act(async () => {});
    container.scrollTop = 0; // user is still up at the top of the loaded window
    fireEvent.scroll(container);
    expect(onLoadEarlier).toHaveBeenCalledTimes(2);
  });
});
