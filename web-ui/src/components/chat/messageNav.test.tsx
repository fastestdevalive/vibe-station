import { useRef, type ReactNode } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import type { Virtualizer } from "@tanstack/react-virtual";
import { useMessageNav, itemAnchorKey, matchItemAnchor, type MessageNav } from "./messageNav";
import type { RenderItem } from "./MessageList";
import type { ToolCallEntry } from "./toolFormat";
import type { RowUiStore } from "./rowUiState";

function Harness({
  items,
  seqIndex,
  rowUiStore,
  navOut,
  virtualizer,
  children,
}: {
  items: RenderItem[];
  seqIndex: Map<number, string>;
  rowUiStore?: RowUiStore | null;
  navOut: { current: MessageNav | null };
  virtualizer?: Virtualizer<HTMLElement, Element>;
  children: ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const nav = useMessageNav({
    items,
    seqIndex,
    virtualizer: virtualizer ?? ({} as Virtualizer<HTMLElement, Element>),
    virtualized: virtualizer != null,
    listRef,
    rowUiStore,
  });
  navOut.current = nav;
  return (
    <div className="scroller">
      <div ref={listRef}>{children}</div>
    </div>
  );
}

function userItem(turnId: string): RenderItem {
  return { type: "user", id: `u_${turnId}`, turnId, text: turnId };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("messageNav", () => {
  it("maps seq → anchor and scrolls the ordinal-th DISTINCT mark inside the row", async () => {
    const items: RenderItem[] = [{ type: "assistant", id: "a1", text: "x" }];
    const seqIndex = new Map([[10, "a:a1"]]);
    const navOut: { current: MessageNav | null } = { current: null };
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");

    render(
      <Harness items={items} seqIndex={seqIndex} navOut={navOut}>
        <div data-row-index={0} data-find-anchor="a:a1">
          {/* One occurrence split across two highlight spans: SAME key, two marks
              — it must count as ONE ordinal. */}
          <mark className="find-hit" data-find-key="a:a1/0:0">foo</mark>
          <mark className="find-hit" data-find-key="a:a1/0:0">bar</mark>
          <mark className="find-hit" data-find-key="a:a1/0:1">baz</mark>
        </div>
      </Harness>,
    );

    expect(navOut.current!.seqAnchor(10)).toBe("a:a1");
    expect(navOut.current!.seqAnchor(11)).toBeUndefined();

    const key = await navOut.current!.scrollToAnchor("a:a1", { ordinal: 1 });
    expect(key).toBe("a:a1/0:1");
    const mark = document.querySelector('[data-find-key="a:a1/0:1"]');
    expect(scrollSpy.mock.instances).toContain(mark);
  });

  it("resolves the ordinal within ONE tool's prefix in a multi-tool toolRun row", async () => {
    const tools: ToolCallEntry[] = [
      { id: "t1", toolName: "Bash" } as ToolCallEntry,
      { id: "t2", toolName: "Read" } as ToolCallEntry,
    ];
    const items: RenderItem[] = [{ type: "toolRun", id: "run1", tools }];
    const seqIndex = new Map([[20, "t:t1 t:t2"]]);
    const navOut: { current: MessageNav | null } = { current: null };
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");

    render(
      <Harness items={items} seqIndex={seqIndex} navOut={navOut}>
        <div data-row-index={0} data-find-anchor={itemAnchorKey(items[0]!)}>
          <mark className="find-hit" data-find-key="t:t1/0:0">a</mark>
          <mark className="find-hit" data-find-key="t:t1/0:1">b</mark>
          <mark className="find-hit" data-find-key="t:t2/0:0">c</mark>
          <mark className="find-hit" data-find-key="t:t2/0:1">d</mark>
        </div>
      </Harness>,
    );

    expect(navOut.current!.seqAnchor(20)).toBe("t:t1 t:t2");
    const key = await navOut.current!.scrollToAnchor("t:t2", { ordinal: 1 });
    expect(key).toBe("t:t2/0:1");
    const mark = document.querySelector('[data-find-key="t:t2/0:1"]');
    expect(scrollSpy.mock.instances).toContain(mark);
  });

  it("falls back to the row when the ordinal-th mark is missing (null key)", async () => {
    const items: RenderItem[] = [{ type: "assistant", id: "a1", text: "x" }];
    const seqIndex = new Map([[10, "a:a1"]]);
    const navOut: { current: MessageNav | null } = { current: null };
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");

    render(
      <Harness items={items} seqIndex={seqIndex} navOut={navOut}>
        <div data-row-index={0} data-find-anchor="a:a1">
          <span>no marks here</span>
        </div>
      </Harness>,
    );

    const key = await navOut.current!.scrollToAnchor("a:a1", { ordinal: 0 });
    expect(key).toBeNull();
    const row = document.querySelector('[data-find-anchor="a:a1"]');
    expect(scrollSpy.mock.instances).toContain(row);
  });

  it("reveals the collapsed row that owns a thinking / tool anchor", async () => {
    const items: RenderItem[] = [
      { type: "thinking", id: "th1", text: "t", startedTs: "", openedEmpty: false },
      {
        type: "toolRun",
        id: "run1",
        tools: [{ id: "tool-2", toolName: "Read" } as ToolCallEntry],
      },
    ];
    const set = vi.fn();
    const store: RowUiStore = {
      get: () => undefined,
      set,
      subscribe: () => () => {},
    };
    const navOut: { current: MessageNav | null } = { current: null };

    render(
      <Harness items={items} seqIndex={new Map()} rowUiStore={store} navOut={navOut}>
        <div />
      </Harness>,
    );

    await navOut.current!.scrollToAnchor("th:th1");
    expect(set).toHaveBeenCalledWith("think:th1", true, false);

    set.mockClear();
    await navOut.current!.scrollToAnchor("t:tool-2");
    expect(set).toHaveBeenCalledWith("tool:tool-2", true, false);
    expect(set).toHaveBeenCalledWith("run:run1", true, false);
  });

  it("jumpTurn steps to the previous / next user turn", async () => {
    const items: RenderItem[] = [userItem("t1"), { type: "assistant", id: "a1", text: "x" }, userItem("t2")];
    const seqIndex = new Map();
    const navOut: { current: MessageNav | null } = { current: null };
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");

    render(
      <Harness items={items} seqIndex={seqIndex} navOut={navOut}>
        <div data-row-index={0} data-find-anchor="u:t1" />
        <div data-row-index={1} data-find-anchor="a:a1" />
        <div data-row-index={2} data-find-anchor="u:t2" />
      </Harness>,
    );

    navOut.current!.jumpTurn(1);
    await Promise.resolve();
    expect(scrollSpy.mock.instances).toContain(document.querySelector('[data-find-anchor="u:t2"]'));

    scrollSpy.mockClear();
    navOut.current!.jumpTurn(-1);
    await Promise.resolve();
    expect(scrollSpy.mock.instances).toContain(document.querySelector('[data-find-anchor="u:t1"]'));
  });
  it("Alt+Down moves past a turn parked under the find bar's scroll margin", async () => {
    const items: RenderItem[] = [
      userItem("t1"),
      { type: "assistant", id: "a1", text: "x" },
      userItem("t2"),
      { type: "assistant", id: "a2", text: "y" },
      userItem("t3"),
    ];
    const navOut: { current: MessageNav | null } = { current: null };
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");
    const { container } = render(
      <Harness items={items} seqIndex={new Map()} navOut={navOut}>
        <style>{"[data-find-anchor] { scroll-margin-top: 60px; }"}</style>
        <div data-row-index={0} data-find-anchor="u:t1" />
        <div data-row-index={1} data-find-anchor="a:a1" />
        <div data-row-index={2} data-find-anchor="u:t2" />
        <div data-row-index={3} data-find-anchor="a:a2" />
        <div data-row-index={4} data-find-anchor="u:t3" />
      </Harness>,
    );
    expect(getComputedStyle(container.querySelector('[data-find-anchor="u:t2"]')!).scrollMarginTop).toBe("60px");
    // `t2` was just jumped to: it sits 60px below the scroller top, so the
    // previous turn's reply still overlaps the top of the viewport.
    const spans: Array<[number, number]> = [[-200, -100], [-100, 60], [60, 160], [160, 400], [400, 500]];
    container.querySelectorAll<HTMLElement>("[data-row-index]").forEach((row, i) => {
      const [top, bottom] = spans[i]!;
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ top, bottom } as DOMRect);
    });

    navOut.current!.jumpTurn(1);
    await Promise.resolve();
    expect(scrollSpy.mock.instances).toContain(document.querySelector('[data-find-anchor="u:t3"]'));

    scrollSpy.mockClear();
    navOut.current!.jumpTurn(-1);
    await Promise.resolve();
    expect(scrollSpy.mock.instances).toContain(document.querySelector('[data-find-anchor="u:t1"]'));
  });

  it("falls back to the row when the rendered marks do not match the indexed occurrence count", async () => {
    const items: RenderItem[] = [{ type: "assistant", id: "a1", text: "x" }];
    const navOut: { current: MessageNav | null } = { current: null };
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");

    render(
      <Harness items={items} seqIndex={new Map([[10, "a:a1"]])} navOut={navOut}>
        <div data-row-index={0} data-find-anchor="a:a1">
          <mark className="find-hit" data-find-key="a:a1/0:0">foo</mark>
          <mark className="find-hit" data-find-key="a:a1/0:1">foo</mark>
        </div>
      </Harness>,
    );

    const key = await navOut.current!.scrollToAnchor("a:a1", { ordinal: 1, expectedMarks: 3 });
    expect(key).toBeNull();
    expect(scrollSpy.mock.instances).toContain(document.querySelector('[data-find-anchor="a:a1"]'));
  });

  describe("virtualized: the visible range comes from the scroll offset, not the mounted rows", () => {
    const items: RenderItem[] = [
      userItem("t1"),
      { type: "assistant", id: "a1", text: "x" },
      userItem("t2"),
      { type: "assistant", id: "a2", text: "y" },
    ];
    // Every row is mounted (overscan), each 100px tall; the viewport shows 310–390px.
    function fakeVirtualizer(scrollOffset: number) {
      return {
        getVirtualItems: () => items.map((_, index) => ({ index, start: index * 100, end: index * 100 + 100 })),
        scrollOffset,
        scrollRect: { height: 80, width: 300 },
        scrollToIndex: vi.fn(),
      } as unknown as Virtualizer<HTMLElement, Element>;
    }

    it("visibleItemRange excludes overscan rows", () => {
      const navOut: { current: MessageNav | null } = { current: null };
      render(
        <Harness items={items} seqIndex={new Map()} navOut={navOut} virtualizer={fakeVirtualizer(310)}>
          <div />
        </Harness>,
      );
      expect(navOut.current!.visibleItemRange()).toEqual([3, 3]);
    });

    it("Alt+Down past the last turn stays put instead of scrolling back up", () => {
      const virtualizer = fakeVirtualizer(310);
      const navOut: { current: MessageNav | null } = { current: null };
      render(
        <Harness items={items} seqIndex={new Map()} navOut={navOut} virtualizer={virtualizer}>
          <div />
        </Harness>,
      );
      navOut.current!.jumpTurn(1);
      expect(virtualizer.scrollToIndex).not.toHaveBeenCalled();

      // From the first turn, Down goes to the next one.
      const top = fakeVirtualizer(10);
      render(
        <Harness items={items} seqIndex={new Map()} navOut={navOut} virtualizer={top}>
          <div />
        </Harness>,
      );
      navOut.current!.jumpTurn(1);
      expect(top.scrollToIndex).toHaveBeenCalledWith(2, { align: "start" });
    });
  });

  describe("messageNav: itemAnchorKey and matchItemAnchor", () => {
    it("itemAnchorKey returns i:<id> for error, status, system_event, session_break", () => {
      const errorItem: RenderItem = { type: "error", id: "err1", text: "Some error" };
      const statusItem: RenderItem = { type: "status", id: "st1", text: "Some status" };
      const systemEventItem: RenderItem = { type: "system_event", id: "se1", text: "Event text" };
      const breakItem: RenderItem = { type: "session_break", id: "sb1", kind: "reset" };

      expect(itemAnchorKey(errorItem)).toBe("i:err1");
      expect(itemAnchorKey(statusItem)).toBe("i:st1");
      expect(itemAnchorKey(systemEventItem)).toBe("i:se1");
      expect(itemAnchorKey(breakItem)).toBe("i:sb1");
    });

    it("itemAnchorKey returns previous anchor formats for user, assistant, thinking, tool, toolRun", () => {
      const userItem: RenderItem = { type: "user", id: "u1", turnId: "turn_1", text: "Hello" };
      const userItemNoTurn: RenderItem = { type: "user", id: "u2", text: "Hello again" };
      const assistantItem: RenderItem = { type: "assistant", id: "as1", text: "Hi" };
      const thinkingItem: RenderItem = {
        type: "thinking",
        id: "th1",
        text: "Thinking...",
        startedTs: "1000",
        openedEmpty: false,
      };
      const toolItem: RenderItem = { type: "tool", id: "t1", toolName: "read" };
      const toolRunItem: RenderItem = {
        type: "toolRun",
        id: "run1",
        tools: [
          { id: "t2", toolName: "write" },
          { id: "t3", toolName: "Task", children: [{ id: "t4", toolName: "nested" }] },
        ],
      };

      expect(itemAnchorKey(userItem)).toBe("u:turn_1");
      expect(itemAnchorKey(userItemNoTurn)).toBe("u:u2");
      expect(itemAnchorKey(assistantItem)).toBe("a:as1");
      expect(itemAnchorKey(thinkingItem)).toBe("th:th1");
      expect(itemAnchorKey(toolItem)).toBe("t:t1");
      expect(itemAnchorKey(toolRunItem)).toBe("t:t2 t:t3 t:t4");
    });

    it("matchItemAnchor matches a tool beat's t: anchor against its toolRun", () => {
      const toolRunItem: RenderItem = {
        type: "toolRun",
        id: "run1",
        tools: [
          { id: "tool_a", toolName: "read" },
          { id: "tool_b", toolName: "edit" },
        ],
      };

      expect(matchItemAnchor(toolRunItem, "t:tool_a")).toBe(true);
      expect(matchItemAnchor(toolRunItem, "t:tool_b")).toBe(true);
      expect(matchItemAnchor(toolRunItem, "t:tool_c")).toBe(false);
    });
  });
});
