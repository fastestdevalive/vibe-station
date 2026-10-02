import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApiInstance } from "@/api";
import type { NormalizedEvent } from "@/api/types";
import { MessageList } from "./MessageList";

// rich-chat-perf Phase 1 (1.T2): settled assistant bubbles must NOT re-render
// when a streaming delta is appended — only the growing bubble does. Count
// renders of the memoized `StreamingMarkdown` (the leaf each assistant bubble
// renders through) so a settled bubble's stale markdown parse is observable.
const { renderCount } = vi.hoisted(() => ({ renderCount: vi.fn() }));

// Stable across renders — an unstable `api` object would defeat every memo.
const API = {} as ApiInstance;

vi.mock("./StreamingMarkdown", () => ({
  StreamingMarkdown: () => {
    renderCount();
    return <div data-testid="streaming-md" />;
  },
}));

function asstEvent(id: string, turnId: string, text: string): NormalizedEvent {
  return { id, sessionId: "s1", ts: "", provider: "claude", kind: "text", role: "assistant", text, turnId };
}

function listElement(events: NormalizedEvent[]) {
  return <MessageList events={events} pending={[]} api={API} worktreeId="wt-1" scope="worktree" />;
}

describe("MessageList memoization (rich-chat-perf Phase 1, 1.T2)", () => {
  it("re-renders ONLY the growing bubble when a delta is appended to a settled transcript", () => {
    const settled = [
      asstEvent("a1", "t1", "first reply"),
      asstEvent("a2", "t2", "second reply"),
      asstEvent("a3", "t3", "third reply"),
    ];

    const { rerender } = render(listElement(settled));
    // Each of the three settled bubbles mounted exactly once.
    expect(renderCount).toHaveBeenCalledTimes(3);

    // Append one streaming delta that merges into the LAST (t3) bubble.
    const withDelta = [
      asstEvent("a1", "t1", "first reply"),
      asstEvent("a2", "t2", "second reply"),
      asstEvent("a3", "t3", "third reply"),
      asstEvent("a4", "t3", " more"),
    ];
    renderCount.mockClear();
    act(() => rerender(listElement(withDelta)));
    // The memoized settled bubbles (t1, t2) skipped re-render; only the
    // growing t3 bubble re-rendered its markdown.
    expect(renderCount).toHaveBeenCalledTimes(1);
  });
});
