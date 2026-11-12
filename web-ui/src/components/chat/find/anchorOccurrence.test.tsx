import { useRef, type ReactNode } from "react";
import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { NormalizedEvent } from "@/api/types";
import { anchorOccurrence } from "./anchorOccurrence";
import { FindMarksProvider } from "./FindMarksContext";
import { TextMessage } from "../TextMessage";
import { ToolRunSummary } from "../ToolRunSummary";
import { RowUiStateProvider } from "../rowUiState";
import { useMessageNav, type MessageNav } from "../messageNav";
import type { RenderItem } from "../MessageList";
import type { ToolCallEntry } from "../toolFormat";

function ev(id: string, extra: Partial<NormalizedEvent>): NormalizedEvent {
  return { id, sessionId: "s", ts: "", provider: "claude", kind: "text", ...extra };
}

/** Distinct find-mark keys rendered inside `anchor` (one occurrence can span several marks). */
function renderedMarkCount(root: ParentNode, anchor: string): number {
  const keys = new Set<string>();
  root.querySelectorAll<HTMLElement>("mark.find-hit").forEach((m) => {
    const k = m.getAttribute("data-find-key") ?? "";
    if (k.startsWith(`${anchor}/`) || k.startsWith(`${anchor}:`)) keys.add(k);
  });
  return keys.size;
}

function NavHarness({
  items,
  seqIndex,
  navOut,
  children,
}: {
  items: RenderItem[];
  seqIndex: Map<number, string>;
  navOut: { current: MessageNav | null };
  children: ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  navOut.current = useMessageNav({
    items,
    seqIndex,
    virtualizer: {} as Virtualizer<HTMLElement, Element>,
    virtualized: false,
    listRef,
  });
  return (
    <div>
      <div ref={listRef}>{children}</div>
    </div>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("anchorOccurrence — the indexed document vs the rendered row", () => {
  it("maps an occurrence of a multi-row text run to its ordinal in the row", () => {
    const events = [
      ev("u1", { kind: "user", role: "user", text: "q", turnId: "t1", logSeq: 1 }),
      ev("a1", { kind: "text", role: "assistant", text: "foo one ", turnId: "t1", logSeq: 2 }),
      ev("a2", { kind: "text", role: "assistant", text: "and foo two", turnId: "t1", logSeq: 3 }),
    ];
    const seqAnchor = (s: number) => (s === 1 ? "u:t1" : "a:a1");
    expect(anchorOccurrence(events, ["foo"], "messages", seqAnchor, "a:a1", { seq: 2, occurrence: 1 })).toEqual({
      ordinal: 1,
      expected: 2,
    });
    // Not loaded / past the document's occurrences → null (caller falls back).
    expect(anchorOccurrence(events, ["foo"], "messages", seqAnchor, "a:a1", { seq: 99, occurrence: 0 })).toBeNull();
    expect(anchorOccurrence(events, ["foo"], "messages", seqAnchor, "a:a1", { seq: 2, occurrence: 2 })).toBeNull();
  });

  it("plain markdown: rendered marks agree with the index, so the jump lands on the exact mark", async () => {
    const text = "foo and **foo** here";
    const events = [ev("a1", { kind: "text", role: "assistant", text, turnId: "t1", logSeq: 10 })];
    const located = anchorOccurrence(events, ["foo"], "messages", () => "a:a1", "a:a1", { seq: 10, occurrence: 1 });
    expect(located).toEqual({ ordinal: 1, expected: 2 });

    const navOut: { current: MessageNav | null } = { current: null };
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");
    const { container } = render(
      <FindMarksProvider terms={["foo"]} scope="messages">
        <NavHarness items={[{ type: "assistant", id: "a1", text }]} seqIndex={new Map([[10, "a:a1"]])} navOut={navOut}>
          <div data-row-index={0} data-find-anchor="a:a1">
            <TextMessage role="assistant" text={text} findKeyPrefix="a:a1" />
          </div>
        </NavHarness>
      </FindMarksProvider>,
    );
    expect(renderedMarkCount(container, "a:a1")).toBe(2);

    const key = await navOut.current!.scrollToAnchor("a:a1", {
      ordinal: located!.ordinal,
      expectedMarks: located!.expected,
    });
    const marks = Array.from(container.querySelectorAll<HTMLElement>("mark.find-hit"));
    expect(key).toBe(marks[1]!.getAttribute("data-find-key"));
    expect(scrollSpy.mock.instances).toContain(marks[1]);
  });

  it("markdown link: the URL is indexed but not rendered, so the row is outlined instead of a wrong mark", async () => {
    const text = "see [foo docs](https://foo.dev) and foo";
    const events = [ev("a1", { kind: "text", role: "assistant", text, turnId: "t1", logSeq: 10 })];
    // Index: link text, URL, trailing word → 3 occurrences; the trailing one is #2.
    const located = anchorOccurrence(events, ["foo"], "messages", () => "a:a1", "a:a1", { seq: 10, occurrence: 2 });
    expect(located).toEqual({ ordinal: 2, expected: 3 });

    const navOut: { current: MessageNav | null } = { current: null };
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");
    const { container } = render(
      <FindMarksProvider terms={["foo"]} scope="messages">
        <NavHarness items={[{ type: "assistant", id: "a1", text }]} seqIndex={new Map([[10, "a:a1"]])} navOut={navOut}>
          <div data-row-index={0} data-find-anchor="a:a1">
            <TextMessage role="assistant" text={text} findKeyPrefix="a:a1" />
          </div>
        </NavHarness>
      </FindMarksProvider>,
    );
    expect(renderedMarkCount(container, "a:a1")).toBe(2);

    const key = await navOut.current!.scrollToAnchor("a:a1", {
      ordinal: located!.ordinal,
      expectedMarks: located!.expected,
    });
    expect(key).toBeNull();
    expect(scrollSpy.mock.instances).toContain(container.querySelector('[data-find-anchor="a:a1"]'));
  });

  it("tool input: JSON keys render but are not indexed, so the row is outlined instead of a wrong mark", async () => {
    const toolInput = { foo_mode: "strict", query: "foo" };
    const events = [ev("tu1", { kind: "tool_use", toolName: "Search", toolInput, turnId: "t1", logSeq: 20 })];
    // Index: "Search\nstrict\nfoo" → one occurrence (the value), never the key.
    const located = anchorOccurrence(events, ["foo"], "all", () => "t:tu1", "t:tu1", { seq: 20, occurrence: 0 });
    expect(located).toEqual({ ordinal: 0, expected: 1 });

    const entry: ToolCallEntry = { id: "tu1", toolName: "Search", toolInput, result: { content: "no hits" } };
    const items: RenderItem[] = [{ type: "toolRun", id: "run1", tools: [entry] }];
    const navOut: { current: MessageNav | null } = { current: null };
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");
    const { container } = render(
      <RowUiStateProvider>
        <FindMarksProvider terms={["foo"]} scope="all">
          <NavHarness items={items} seqIndex={new Map([[20, "t:tu1"]])} navOut={navOut}>
            <div data-row-index={0} data-find-anchor="t:tu1">
              <ToolRunSummary tools={[entry]} live={false} />
            </div>
          </NavHarness>
        </FindMarksProvider>
      </RowUiStateProvider>,
    );
    fireEvent.click(container.querySelector(".chat-tool-entry__header")!);
    expect(renderedMarkCount(container, "t:tu1")).toBeGreaterThan(located!.expected);

    const key = await navOut.current!.scrollToAnchor("t:tu1", {
      ordinal: located!.ordinal,
      expectedMarks: located!.expected,
    });
    expect(key).toBeNull();
    expect(scrollSpy.mock.instances).toContain(container.querySelector('[data-find-anchor="t:tu1"]'));
  });
});
