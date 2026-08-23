import { act, render, screen } from "@testing-library/react";
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
  return { type: "thinking" as const, id, turnId, text };
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

describe("MessageList thinking hint (Change 3)", () => {
  it("renders the hint after the last user message while thinking", () => {
    render(<MessageList events={[userEvent("t1", "do the thing")]} pending={[]} thinking />);
    expect(screen.getByText("Thinking…")).toBeTruthy();
  });

  it("does not render the hint when not thinking", () => {
    render(<MessageList events={[userEvent("t1", "do the thing")]} pending={[]} />);
    expect(screen.queryByText("Thinking…")).toBeNull();
  });

  it("renders the hint after an optimistic pending bubble", () => {
    render(
      <MessageList
        events={[]}
        pending={[{ turnId: "p1", message: "just sent", attachments: [], queued: false }]}
        thinking
      />,
    );
    expect(screen.getByText("just sent")).toBeTruthy();
    expect(screen.getByText("Thinking…")).toBeTruthy();
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

  it("does not render during the thinking sub-state (ThinkingHint already covers it)", () => {
    render(<MessageList events={[userEvent("t1", "do the thing")]} pending={[]} turnActive thinking />);
    expect(screen.getByText("Thinking…")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Agent is working" })).toBeNull();
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
