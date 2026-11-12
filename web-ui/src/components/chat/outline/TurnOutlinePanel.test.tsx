import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TurnChain } from "./TurnChain";
import { EMPTY_TURN_FILTER, TurnOutlinePanel, filterTurnNodes, type TurnFilter } from "./TurnOutlinePanel";
import type { PanelMode, TreeFocus } from "./outlineTree";
import type { TurnNode } from "./buildTurnOutline";
import type { RenderItem } from "../MessageList";
import { fakeNav, makeBeat, makeChat, makeTurn, makeUserItem, outlineRow } from "./outlineTestUtils";

/** Opens the list the way assistive tech does (a click with no pointer behind it). */
function openList(n: number): HTMLElement {
  const chain = screen.getByRole("button", { name: new RegExp(`^Conversation outline, ${n} turns\\.`) });
  fireEvent.click(chain);
  return chain;
}

/** Opens the list with a mouse tap: a sticky list with no keyboard focus. */
function tapOpen(n: number): void {
  const chain = screen.getByRole("button", { name: new RegExp(`^Conversation outline, ${n} turns\\.`) });
  fireEvent.pointerDown(chain, { pointerId: 1, pointerType: "mouse", button: 0, clientY: 10 });
  fireEvent.pointerUp(chain, { pointerId: 1, pointerType: "mouse", clientY: 10 });
}

/** The panel on its own, for pointer/wheel contracts the chain does not need to be involved in. */
function renderPanel(onHoverChange?: (inside: boolean, to?: EventTarget | null) => void) {
  const nodes = makeChat(3, 1).nodes;
  render(
    <>
      <TurnOutlinePanel
        outlineId="test-outline"
        nodes={nodes}
        filteredNodes={nodes}
        filter={EMPTY_TURN_FILTER}
        onFilterChange={vi.fn()}
        onJump={vi.fn()}
        onClose={vi.fn()}
        visibleTurnIndices={new Set([0])}
        mode="sticky"
        marked={null}
        newBeatKeys={new Set()}
        onHoverChange={onHoverChange}
      />
      <div data-testid="beside" />
    </>,
  );
  return screen.getByRole("dialog");
}

describe("TurnOutlinePanel: pointer and wheel", () => {
  it("reports mouse/pen hover in and out; touch never counts", () => {
    const onHoverChange = vi.fn();
    const nav = renderPanel(onHoverChange);
    fireEvent.pointerOver(nav, { pointerType: "mouse" });
    expect(onHoverChange).toHaveBeenLastCalledWith(true);
    fireEvent.pointerOut(nav, { pointerType: "mouse" });
    // React reports a leave to nowhere (or to a node it does not manage) as one to the window.
    expect(onHoverChange).toHaveBeenLastCalledWith(false, window);
    // A leave onto another element says where it went (the rail tells a crossing from a leave).
    const beside = screen.getByTestId("beside");
    fireEvent.pointerOver(nav, { pointerType: "mouse" });
    fireEvent.pointerOut(nav, { pointerType: "mouse", relatedTarget: beside });
    expect(onHoverChange).toHaveBeenLastCalledWith(false, beside);
    fireEvent.pointerOver(nav, { pointerType: "touch" });
    fireEvent.pointerOut(nav, { pointerType: "touch" });
    expect(onHoverChange).toHaveBeenCalledTimes(4);
  });

  it("never hijacks a wheel over the list: it scrolls natively", () => {
    renderPanel();
    const ev = new WheelEvent("wheel", { deltaY: 120, cancelable: true, bubbles: true });
    fireEvent(document.querySelector(".olp__scroll")!, ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe("TurnOutlinePanel", () => {
  it("lists every turn's steps, always: no chevrons, no step counts, no fold state; a step click jumps and closes", () => {
    const nodes: TurnNode[] = [
      {
        ...makeTurn("t1", 1, "Turn 1"),
        edits: 2,
        errors: 1,
        beats: [makeBeat("b1_1", "text", "Beat 1"), makeBeat("b1_2", "error", "Beat 2"), makeBeat("b1_3", "text", "Beat 3")],
      },
      { ...makeTurn("t2", 2, "Turn 2"), beats: [makeBeat("b2_1", "text", "Beat 2_1")] },
      { ...makeTurn("t3", 3, "Turn 3"), live: true, beats: [makeBeat("b3_1", "todo", "Live Todo")] },
      makeTurn("t4", 4, "Turn 4"),
    ];
    const items = nodes.map((n) => makeUserItem(n.key, n.label));
    const onJump = vi.fn();
    render(<TurnChain nodes={nodes} items={items} nav={fakeNav([0, 3])} onJump={onJump} />);
    openList(4);

    const t1 = outlineRow("t1")!;
    expect(t1.getAttribute("aria-label")).toBe("Turn 1: Turn 1, 2 edits, 1 errors, 3 beats");
    expect(t1.querySelector(".olp__chip--err")!.textContent).toBe("1");
    expect(outlineRow("t3")!.querySelector(".olp__chip--live")).not.toBeNull();
    expect(screen.getByRole("treeitem", { name: /Todo done: Live Todo/ })).toHaveClass("k-live");
    expect(screen.getByRole("treeitem", { name: /Error: Beat 2/ })).toHaveClass("k-error");
    // Each step carries one glyph on the rail; the last step of a turn ends the rail.
    expect(screen.getByRole("treeitem", { name: /Agent said: Beat 3/ })).toHaveClass("last");
    expect(document.querySelectorAll(".olp__gl svg")).toHaveLength(5);
    expect(document.querySelectorAll(".olp__beat")).toHaveLength(5);

    // A flat tree: levels, no expansion state, no fold affordances anywhere.
    const tree = screen.getByRole("tree");
    expect(tree.querySelectorAll("[aria-expanded], [aria-owns]")).toHaveLength(0);
    expect(tree.querySelectorAll('[role="group"]')).toHaveLength(0);
    expect(document.querySelectorAll(".olp__chev, .olp__chev-slot, .olp__steps")).toHaveLength(0);
    expect(screen.getAllByRole("treeitem").map((el) => el.getAttribute("aria-level"))).toEqual(
      ["1", "2", "2", "2", "1", "2", "1", "2", "1"],
    );

    fireEvent.click(screen.getByRole("treeitem", { name: /Agent said: Beat 1/ }));
    expect(onJump).toHaveBeenCalledWith("t:b1_1");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the number column fits the widest number (20px floor)", () => {
    const flat = makeChat(3, 0);
    const { unmount } = render(<TurnChain nodes={flat.nodes} items={flat.items} nav={fakeNav([0, 2])} onJump={vi.fn()} />);
    openList(3);
    expect(screen.getByRole("dialog").style.getPropertyValue("--olp-n-w")).toBe("20px");
    unmount();

    const mixed: TurnNode[] = [
      { ...makeTurn("t1", 1, "Turn 1"), beats: [makeBeat("b1", "text", "B1")] },
      makeTurn("t2", 2, "Turn 2"),
      makeTurn("t3", 120, "Turn 120"),
    ];
    render(<TurnChain nodes={mixed} items={mixed.map((n) => makeUserItem(n.key, n.label))} nav={fakeNav([0, 2])} onJump={vi.fn()} />);
    openList(3);
    expect(screen.getByRole("dialog").style.getPropertyValue("--olp-n-w")).toBe("27px");
  });

  it("only the turn in view carries the current band", () => {
    const { nodes, items } = makeChat(5, 0);
    render(<TurnChain nodes={nodes} items={items} nav={fakeNav([1, 3])} onJump={vi.fn()} />);
    openList(5);
    expect(document.querySelectorAll(".olp__row.cur")).toHaveLength(1);
    expect(outlineRow("t2")).toHaveClass("cur");
  });

  it("re-derives the visible turn when earlier turns are prepended", () => {
    const { nodes, items } = makeChat(4, 0);
    const { rerender } = render(<TurnChain nodes={nodes} items={items} nav={fakeNav([1, 1])} onJump={vi.fn()} />);
    openList(4);
    expect(outlineRow("t2")).toHaveClass("cur");

    // "Load earlier": two turns are prepended, so item index 1 is now the second earlier turn.
    const earlier = [
      { ...makeTurn("e1", 1, "Earlier 1"), number: null },
      { ...makeTurn("e2", 2, "Earlier 2"), number: null },
    ];
    const earlierItems = earlier.map((n) => makeUserItem(n.key, n.label));
    rerender(
      <TurnChain nodes={[...earlier, ...nodes]} items={[...earlierItems, ...items]} nav={fakeNav([1, 1])} onJump={vi.fn()} />,
    );
    expect(outlineRow("e2")).toHaveClass("cur");
    expect(outlineRow("t2")).not.toHaveClass("cur");
  });

  it("the header holds only the title and the count (no Collapse all / Expand all)", () => {
    const { nodes, items } = makeChat(3, 1);
    render(<TurnChain nodes={nodes} items={items} nav={fakeNav([0, 2])} onJump={vi.fn()} />);
    openList(3);
    const head = document.querySelector(".olp__head")!;
    expect(head.querySelector(".olp__title")!.textContent).toBe("Turns");
    expect(head.querySelector(".olp__count")!.textContent).toBe("3");
    expect(head.querySelectorAll("button")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Collapse all|Expand all/ })).toBeNull();
  });

  it("every turn and step row prints its time at the right edge; the tooltip carries the full timestamp and the label speaks the age", () => {
    const ts = new Date(Date.now() - 5 * 60_000 - 5_000).toISOString();
    const later = new Date(Date.now() - 2 * 60_000 - 5_000).toISOString();
    const nodes: TurnNode[] = [
      {
        ...makeTurn("t1", 1, "Turn 1"),
        ts,
        beats: [{ ...makeBeat("b1", "text", "B1"), ts }, { ...makeBeat("b2", "text", "B2"), ts: later }, makeBeat("b3", "text", "B3")],
      },
      { ...makeTurn("t2", 2, "Turn 2"), ts: later },
      makeTurn("t3", 3, "Turn 3"),
    ];
    render(<TurnChain nodes={nodes} items={nodes.map((n) => makeUserItem(n.key, n.label))} nav={fakeNav([0, 2])} onJump={vi.fn()} />);
    openList(3);

    const time = outlineRow("t1")!.querySelector("time.olp__time")!;
    expect(time.textContent).toBe("5m");
    expect(time.getAttribute("dateTime")).toBe(ts);
    expect(time.getAttribute("title")).toBeTruthy();
    expect(outlineRow("t1")!.lastElementChild).toBe(time);
    expect(outlineRow("t1")!.getAttribute("aria-label")).toBe("Turn 1: Turn 1, 3 beats, 5 minutes ago");
    // Repeated times still print: B1 repeats its turn's "5m", Turn 2 repeats B2's "2m".
    const b1 = screen.getByRole("treeitem", { name: "Agent said: B1, 5 minutes ago" });
    expect(b1.querySelector("time")!.textContent).toBe("5m");
    expect(b1.lastElementChild).toBe(b1.querySelector("time"));
    expect(screen.getByRole("treeitem", { name: /Agent said: B2/ }).querySelector("time")!.textContent).toBe("2m");
    expect(outlineRow("t2")!.querySelector("time")!.textContent).toBe("2m");
    // No timestamp: nothing at all, not an empty placeholder.
    expect(screen.getByRole("treeitem", { name: "Agent said: B3" }).querySelector(".olp__time")).toBeNull();
    expect(outlineRow("t3")!.querySelector(".olp__time")).toBeNull();
  });

  it("↓ walks into a turn's steps; ← / → do nothing; Enter jumps and closes; the key hints have no Fold", async () => {
    const user = userEvent.setup();
    const nodes: TurnNode[] = [
      {
        ...makeTurn("t1", 1, "Turn 1"),
        beats: [
          makeBeat("b1", "text", "Beat 1"),
          makeBeat("b2", "text", "Beat 2"),
          makeBeat("b3", "error", "connection refused", 4),
          makeBeat("b4", "text", "Beat 4"),
        ],
      },
      makeTurn("t2", 2, "Turn 2"),
      makeTurn("t3", 3, "Turn 3"),
    ];
    const onJump = vi.fn();
    render(<TurnChain nodes={nodes} items={nodes.map((n) => makeUserItem(n.key, n.label))} nav={fakeNav([0, 0])} onJump={onJump} />);
    const chain = screen.getByRole("button", { name: /^Conversation outline, 3 turns\./ });
    chain.focus();
    await user.keyboard("{Enter}");
    expect(document.querySelector(".olp__foot")!.textContent).not.toContain("Fold");

    await user.keyboard("{ArrowLeft}{ArrowRight}");
    expect(chain.getAttribute("aria-activedescendant")).toBe(outlineRow("t1")!.id);
    expect(document.querySelectorAll(".olp__beat")).toHaveLength(4);
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");

    const dialog = screen.getByRole("dialog");
    const beatId = `${dialog.id}-row-t1-b2`;
    expect(chain.getAttribute("aria-activedescendant")).toBe(beatId);
    const beat = document.getElementById(beatId)!;
    expect(beat).toHaveClass("kfocus");
    expect(beat.getAttribute("aria-level")).toBe("2");
    expect(beat.getAttribute("aria-posinset")).toBe("3");
    expect(beat.getAttribute("aria-setsize")).toBe("4");
    expect(beat.getAttribute("aria-label")).toBe("Error: connection refused, and 3 more");
    expect(beat.querySelector(".olp__plus")!.textContent).toBe("+3");

    await user.keyboard("{Enter}");
    expect(onJump).toHaveBeenCalledWith("t:b3");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the filter shows past 100 turns; ↓ ↓ Enter walks the filtered rows; text keys stay in the box; Esc refocuses the chain", async () => {
    const user = userEvent.setup();
    const { nodes, items } = makeChat(130, 0);
    const onJump = vi.fn();
    render(<TurnChain nodes={nodes} items={items} nav={fakeNav([0, 0])} onJump={onJump} />);
    const chain = openList(130);
    const input = screen.getByRole("textbox", { name: "Filter turns" });
    await user.click(input);
    await user.type(input, "Turn 12");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(chain.getAttribute("aria-activedescendant")).toBe(outlineRow("t120")!.id);
    for (const key of ["Home", "End", "ArrowRight", "ArrowLeft"]) {
      expect(fireEvent.keyDown(input, { key })).toBe(true);
    }
    expect(chain.getAttribute("aria-activedescendant")).toBe(outlineRow("t120")!.id);
    await user.keyboard("{Enter}");
    expect(onJump).toHaveBeenCalledWith("u:t120");

    openList(130);
    await user.type(screen.getByRole("textbox", { name: "Filter turns" }), "deploy");
    expect(screen.getByText("No turns match")).toBeDefined();
    fireEvent.click(chain);
    expect(screen.queryByRole("dialog")).toBeNull();

    openList(130);
    await user.click(screen.getByRole("textbox", { name: "Filter turns" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(chain);
  });

  it("the errors chip reports its pressed state and outline ids are unique per pane", () => {
    const { nodes, items } = makeChat(130, 0);
    render(
      <div>
        <TurnChain nodes={nodes} items={items} nav={fakeNav([0, 0])} onJump={vi.fn()} />
        <TurnChain nodes={nodes} items={items} nav={fakeNav([0, 0])} onJump={vi.fn()} />
      </div>,
    );
    for (const btn of screen.getAllByRole("button", { name: /^Conversation outline, 130 turns\./ })) {
      fireEvent.click(btn);
    }
    const ids = Array.from(document.querySelectorAll("[id]")).map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    const chip = screen.getAllByRole("button", { name: "errors" })[0]!;
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
  });

  it("101 turns x 12 steps: rows are virtualised and the current turn is centred", () => {
    const { nodes, items } = makeChat(101, 12);
    // Every box is 600px tall, so keeping the focused row visible does not move the centred list.
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    render(<TurnChain nodes={nodes} items={items} nav={fakeNav([50, 50])} onJump={vi.fn()} />);
    openList(101);
    expect(document.querySelector('[data-testid="olp-virtual"]')).not.toBeNull();
    expect(document.querySelectorAll(".olp__item").length).toBeLessThan(20);
    // list pad 4 + 50 turns x (32 + 12 x 26), centred in the 600px fallback
    const turnTop = 4 + 50 * (32 + 12 * 26);
    const list = document.querySelector<HTMLElement>(".olp__scroll")!;
    expect(list.scrollTop).toBe(turnTop - (600 - 32) / 2);
    expect(outlineRow("t51")).toHaveClass("kfocus");
    vi.restoreAllMocks();
  });

  it("long-chat rows use the 44px phone heights under the narrow breakpoint", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(max-width: 640px)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    try {
      const { nodes, items } = makeChat(160, 0);
      render(<TurnChain nodes={nodes} items={items} nav={fakeNav([0, 0])} onJump={vi.fn()} />);
      openList(160);
      const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="olp-virtual"] .olp__item'));
      const offset = (el: HTMLElement) => Number(/translateY\((-?\d+(?:\.\d+)?)px\)/.exec(el.style.transform)![1]);
      expect(offset(rows[1]!) - offset(rows[0]!)).toBe(44);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("hasMore shows 'N loaded' and a 'Load earlier turns' row", () => {
    const { nodes, items } = makeChat(4, 0);
    const onLoadEarlier = vi.fn();
    render(<TurnChain nodes={nodes} items={items} hasMore onLoadEarlier={onLoadEarlier} nav={fakeNav([0, 0])} onJump={vi.fn()} />);
    openList(4);
    expect(screen.getByText("4 loaded")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Load earlier turns" }));
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
  });

  it("while earlier turns load the row shows a spinner and takes no click; the cap stays until all are loaded", () => {
    const { nodes, items } = makeChat(4, 0);
    const onLoadEarlier = vi.fn();
    const chain = (loadingEarlier: boolean, hasMore = true) => (
      <TurnChain
        nodes={nodes}
        items={items}
        hasMore={hasMore}
        loadingEarlier={loadingEarlier}
        onLoadEarlier={onLoadEarlier}
        nav={fakeNav([0, 0])}
        onJump={vi.fn()}
      />
    );
    const { container, rerender } = render(chain(true));
    openList(4);
    const row = screen.getByRole("button", { name: "Loading earlier…" });
    expect(row).toBeDisabled();
    expect(row).toHaveAttribute("aria-busy", "true");
    expect(row.querySelector(".olp__load-spin")).not.toBeNull();
    fireEvent.click(row);
    expect(onLoadEarlier).not.toHaveBeenCalled();
    expect(container.querySelector(".ol__cap")).not.toBeNull();

    rerender(chain(false));
    expect(screen.getByRole("button", { name: "Load earlier turns" })).not.toBeDisabled();
    expect(container.querySelector(".olp__load-spin")).toBeNull();

    rerender(chain(false, false));
    expect(screen.queryByRole("button", { name: /Load earlier/ })).toBeNull();
    expect(container.querySelector(".ol__cap")).toBeNull();
  });

  it("a new live step is marked new for 1200ms; the current find hit's step is marked", () => {
    vi.useFakeTimers();
    try {
      const nodes: TurnNode[] = [
        { ...makeTurn("t1", 1, "Turn 1"), beats: [makeBeat("b1", "text", "Beat 1")] },
        makeTurn("t2", 2, "Turn 2"),
        { ...makeTurn("t3", 3, "Turn 3"), live: true, beats: [makeBeat("b3_1", "text", "Live 1")] },
      ];
      const items: RenderItem[] = nodes.map((n) => makeUserItem(n.key, n.label));
      const { rerender } = render(
        <TurnChain nodes={nodes} items={items} nav={fakeNav([0, 2])} onJump={vi.fn()} currentHitAnchor="t:b1" />,
      );
      openList(3);
      expect(screen.getByRole("treeitem", { name: /Agent said: Beat 1/ })).toHaveClass("find-cur");

      const next = [nodes[0]!, nodes[1]!, { ...nodes[2]!, beats: [...nodes[2]!.beats, makeBeat("b3_2", "text", "Live 2")] }];
      rerender(<TurnChain nodes={next} items={items} nav={fakeNav([0, 2])} onJump={vi.fn()} />);
      const fresh = screen.getByRole("treeitem", { name: /Agent said: Live 2/ });
      expect(fresh).toHaveClass("new");
      act(() => {
        vi.advanceTimersByTime(1200);
      });
      expect(fresh).not.toHaveClass("new");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an appended live step keeps scrollTop when far from the end, follows it when at the end", () => {
    const nodes: TurnNode[] = [
      makeTurn("t1", 1, "Turn 1"),
      makeTurn("t2", 2, "Turn 2"),
      { ...makeTurn("t3", 3, "Turn 3"), live: true, beats: [makeBeat("b1", "text", "B1")] },
    ];
    const items = nodes.map((n) => makeUserItem(n.key, n.label));
    const { rerender } = render(<TurnChain nodes={nodes} items={items} nav={fakeNav([0, 2])} onJump={vi.fn()} />);
    tapOpen(3);
    const list = document.querySelector<HTMLElement>(".olp__scroll")!;
    Object.defineProperty(list, "clientHeight", { value: 100, configurable: true });
    Object.defineProperty(list, "scrollHeight", { value: 500, configurable: true });
    const withBeats = (n: number): TurnNode[] => [
      nodes[0]!,
      nodes[1]!,
      { ...nodes[2]!, beats: Array.from({ length: n }, (_, k) => makeBeat(`b${k + 1}`, "text", `B${k + 1}`)) },
    ];

    list.scrollTop = 0;
    rerender(<TurnChain nodes={withBeats(2)} items={items} nav={fakeNav([0, 2])} onJump={vi.fn()} />);
    expect(list.scrollTop).toBe(0);

    list.scrollTop = 400;
    rerender(<TurnChain nodes={withBeats(3)} items={items} nav={fakeNav([0, 2])} onJump={vi.fn()} />);
    expect(list.scrollTop).toBe(500);
  });
});

describe("TurnOutlinePanel: the marked row", () => {
  const nodes = makeChat(3, 1).nodes;

  function panelEl(mode: PanelMode, marked: TreeFocus | null) {
    return (
      <TurnOutlinePanel
        outlineId="test-outline"
        nodes={nodes}
        filteredNodes={nodes}
        filter={EMPTY_TURN_FILTER}
        onFilterChange={vi.fn()}
        onJump={vi.fn()}
        onClose={vi.fn()}
        visibleTurnIndices={new Set([0])}
        mode={mode}
        marked={marked}
        newBeatKeys={new Set()}
      />
    );
  }

  it("a sticky list rings the turn a tap marked, and a new mark does not re-centre it", () => {
    const { rerender } = render(panelEl("sticky", { turnKey: "t2", beat: null }));
    expect(outlineRow("t2")).toHaveClass("scrub");
    expect(document.querySelectorAll(".olp__row.scrub")).toHaveLength(1);

    const list = document.querySelector<HTMLElement>(".olp__scroll")!;
    list.scrollTop = 100;
    rerender(panelEl("sticky", { turnKey: "t3", beat: null }));
    expect(outlineRow("t3")).toHaveClass("scrub");
    expect(outlineRow("t2")).not.toHaveClass("scrub");
    expect(list.scrollTop).toBe(100);
  });

  it("a sticky list rings the step a tap marked", () => {
    render(panelEl("sticky", { turnKey: "t2", beat: 0 }));
    const beat = document.getElementById("test-outline-row-t2-b0")!;
    expect(beat).toHaveClass("scrub");
    expect(outlineRow("t2")).not.toHaveClass("scrub");
  });

  it("a keyboard list rings the focused row and never the scrub class", () => {
    render(panelEl("keyboard", { turnKey: "t2", beat: null }));
    const row = outlineRow("t2")!;
    expect(row).toHaveClass("kfocus");
    expect(row).not.toHaveClass("scrub");
    expect(document.querySelectorAll(".olp__row.scrub, .olp__beat.scrub")).toHaveLength(0);
  });
});

describe("TurnOutlinePanel: header count, tree positions and compact layout", () => {
  /** The panel with an explicit filter (the chain normally owns `filteredNodes`). */
  function renderFiltered(opts: {
    nodes: TurnNode[];
    filter: TurnFilter;
    filteredNodes?: TurnNode[];
    hasMore?: boolean;
    compact?: boolean;
  }) {
    const filteredNodes = opts.filteredNodes ?? filterTurnNodes(opts.nodes, opts.filter);
    const utils = render(
      <TurnOutlinePanel
        outlineId="test-outline"
        nodes={opts.nodes}
        filteredNodes={filteredNodes}
        filter={opts.filter}
        onFilterChange={vi.fn()}
        onJump={vi.fn()}
        onClose={vi.fn()}
        visibleTurnIndices={new Set()}
        mode="sticky"
        marked={null}
        newBeatKeys={new Set()}
        hasMore={opts.hasMore}
        compact={opts.compact}
      />,
    );
    return { ...utils, dialog: screen.getByRole("dialog"), filteredNodes };
  }

  const count = () => document.querySelector(".olp__count")!.textContent;
  const turnRows = () =>
    screen.getAllByRole("treeitem").filter((el) => el.getAttribute("aria-level") === "1");

  it("the count follows the filter: '1 of 3' filtered, '3' unfiltered, 'loaded' when hasMore", () => {
    const nodes = [makeTurn("t1", 1, "Turn 1"), makeTurn("t2", 2, "Turn 2"), makeTurn("t3", 3, "Turn 3")];
    const first = renderFiltered({ nodes, filter: EMPTY_TURN_FILTER });
    expect(count()).toBe("3");
    first.unmount();

    const second = renderFiltered({ nodes, filter: { text: "Turn 1", errorsOnly: false } });
    expect(count()).toBe("1 of 3");
    second.unmount();

    const withErrors = [
      { ...makeTurn("t1", 1, "Turn 1"), errors: 2 },
      makeTurn("t2", 2, "Turn 2"),
      makeTurn("t3", 3, "Turn 3"),
    ];
    const third = renderFiltered({ nodes: withErrors, filter: { text: "", errorsOnly: true } });
    expect(count()).toBe("1 of 3");
    third.unmount();

    const fourth = renderFiltered({ nodes, filter: { text: "Turn 1", errorsOnly: false }, hasMore: true });
    expect(count()).toBe("1 of 3 loaded");
    fourth.unmount();
  });

  it("a virtualised tree reports every turn's position in the set", () => {
    const nodes = makeChat(160, 0).nodes;
    const { unmount } = renderFiltered({ nodes, filter: EMPTY_TURN_FILTER });
    expect(screen.getByTestId("olp-virtual")).toBeTruthy();
    const rows = turnRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(nodes.length);
    for (const row of rows) {
      expect(row.getAttribute("aria-setsize")).toBe("160");
    }
    // The rendered window starts at the top row and runs contiguously.
    expect(rows.map((r) => Number(r.getAttribute("aria-posinset")))).toEqual(
      Array.from({ length: rows.length }, (_, i) => i + 1),
    );
    unmount();

    // Under a filter both follow the filtered list.
    const many = Array.from({ length: 400 }, (_, i) =>
      makeTurn(`t${i + 1}`, i + 1, i % 4 === 0 ? `Skipped ${i + 1}` : `Kept ${i + 1}`),
    );
    const filtered = renderFiltered({ nodes: many, filter: { text: "kept", errorsOnly: false } });
    expect(filtered.filteredNodes).toHaveLength(300);
    expect(screen.getByTestId("olp-virtual")).toBeTruthy();
    const kept = turnRows();
    expect(kept.length).toBeGreaterThan(0);
    for (const row of kept) {
      expect(row.getAttribute("aria-setsize")).toBe("300");
    }
    expect(kept[0]!.getAttribute("aria-posinset")).toBe("1");
    expect(kept[0]!.id).toBe(`test-outline-row-${filtered.filteredNodes[0]!.key}`);
  });

  it("compact hides an idle filter row but keeps an active one", () => {
    const nodes = makeChat(130, 0).nodes;
    const idle = renderFiltered({ nodes, filter: EMPTY_TURN_FILTER, compact: true });
    expect(idle.dialog).toHaveClass("olp--compact");
    expect(screen.queryByRole("textbox", { name: "Filter turns" })).toBeNull();
    idle.unmount();

    const active = renderFiltered({ nodes, filter: { text: "Turn 12", errorsOnly: false }, compact: true });
    expect(active.dialog).toHaveClass("olp--compact");
    expect(screen.getByRole("textbox", { name: "Filter turns" })).not.toBeNull();
  });
});
