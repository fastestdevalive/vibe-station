import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HOVER_GRACE_MS, SETTLE_HIDE_MS, TurnChain } from "./TurnChain";
import { WHEEL_ARM_MS, WHEEL_JUMP_IDLE_MS } from "./useWheelAutoJump";
import { WHEEL_CHAT_GUARD_MS } from "./useRailWheel";
import type { TurnNode } from "./buildTurnOutline";
import type { RenderItem } from "../MessageList";
import { fakeNav, flushFrame, makeBeat, makeChat, makeTurn, makeUserItem, outlineRow } from "./outlineTestUtils";

/*
 * The chain is 600px tall in jsdom (its fallback height) with its top at 0.
 * `makeChat(10, 2)` is 30 flat rows, so each row is 20px: turn i (0-based) sits
 * at y = 60i + 10 and its step k at y = 60i + 30 + 20k.
 */
const turnY = (i: number) => 60 * i + 10;
const stepY = (i: number, k: number) => 60 * i + 30 + 20 * k;

const capture = { set: vi.fn(), release: vi.fn(), has: vi.fn(() => true) };

beforeEach(() => {
  Object.assign(HTMLElement.prototype, {
    setPointerCapture: capture.set,
    releasePointerCapture: capture.release,
    hasPointerCapture: capture.has,
  });
});

afterEach(() => {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  delete proto.setPointerCapture;
  delete proto.releasePointerCapture;
  delete proto.hasPointerCapture;
  vi.clearAllMocks();
});

function renderChat(n = 10, beats = 2, onJump = vi.fn()) {
  const { nodes, items } = makeChat(n, beats);
  const utils = render(<TurnChain nodes={nodes} items={items} nav={fakeNav([0, 0])} onJump={onJump} />);
  const chain = screen.getByRole("button", { name: new RegExp(`^Conversation outline, ${n} turns\\.`) });
  return { ...utils, chain, nodes, onJump };
}

const press = (el: Element, y: number, init: Record<string, unknown> = {}) =>
  fireEvent.pointerDown(el, { pointerId: 1, pointerType: "mouse", button: 0, clientY: y, ...init });
const move = (el: Element, y: number, init: Record<string, unknown> = {}) =>
  fireEvent.pointerMove(el, { pointerId: 1, pointerType: "mouse", clientY: y, ...init });
const release = (el: Element, y: number, init: Record<string, unknown> = {}) =>
  fireEvent.pointerUp(el, { pointerId: 1, pointerType: "mouse", clientY: y, ...init });
const wheelOn = (el: Element, init: WheelEventInit = {}) => {
  const ev = new WheelEvent("wheel", { deltaY: 100, deltaMode: 0, cancelable: true, bubbles: true, ...init });
  fireEvent(el, ev);
  return ev;
};
/** The outline row of turn `key`, or of its step (e.g. `t2-b0`). */
const rowOf = (key: string) => document.getElementById(`${screen.getByRole("dialog").id}-row-${key}`)!;

describe("TurnChain: the chain", () => {
  it("renders for a single long turn with enough beats; renders nothing for a short chat", () => {
    const nodes = [{ ...makeTurn("t1", 1, "Long"), beats: [0, 1, 2].map((k) => makeBeat(`b${k}`, "text", `S${k}`)) }];
    const { unmount } = render(<TurnChain nodes={nodes} items={[makeUserItem("t1", "Long")]} onJump={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Conversation outline/ })).toBeDefined();
    unmount();

    const short = [makeTurn("t1", 1, "A"), makeTurn("t2", 2, "B")];
    const { container } = render(<TurnChain nodes={short} items={[]} onJump={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("draws lines in one SVG (no per-turn DOM nodes), as tall as the chain, with no scrolling", () => {
    const { container } = renderChat(10, 2);
    const svg = container.querySelector("svg.ol__marks")!;
    expect(svg.getAttribute("height")).toBe("600");
    expect(container.querySelectorAll(".nd, .bt")).toHaveLength(0);
    // One path per mark kind present (+ the spine), not one per turn or step.
    const paths = svg.querySelectorAll("path");
    expect(paths.length).toBeLessThanOrEqual(13);
    const turnPath = svg.querySelector('path[data-kind="turn"]')!;
    const stepPath = svg.querySelector('path[data-kind="step"]')!;
    expect(turnPath.getAttribute("d")!.match(/M/g)).toHaveLength(9);
    expect(stepPath.getAttribute("d")!.match(/M/g)).toHaveLength(20);
    expect(turnPath.getAttribute("d")).toContain(`M1 ${turnY(1)}h10`);
    expect(stepPath.getAttribute("d")).toContain(`M3 ${stepY(0, 1)}h6`);
    const ol = container.querySelector<HTMLElement>(".ol")!;
    expect(ol.style.overflow).toBe("");
    expect(ol.scrollHeight).toBe(ol.clientHeight);
  });

  it("dense chats drop the step lines; the in-view band and the hatched cap for unloaded turns stay", () => {
    const { nodes, items } = makeChat(412, 3);
    const { container } = render(
      <TurnChain nodes={nodes} items={items} hasMore nav={fakeNav([0, 0])} onJump={vi.fn()} />,
    );
    expect(container.querySelector('path[data-kind="step"]')).toBeNull();
    expect(container.querySelector('path[data-kind="turn"]')).not.toBeNull();
    expect(container.querySelector(".ol__cap")).not.toBeNull();
    expect(container.querySelector(".ol__inview")).not.toBeNull();
  });

  it("a same-length window swap moves the in-view band without a scroll", () => {
    const { nodes } = makeChat(10, 2);
    const reply = (id: string): RenderItem => ({ type: "assistant", id, text: "" });
    // Item 4 is in view. Window A: users at 0, 3, 6 (item 4 is turn 2). Window B:
    // users at 0, 5, 6 (item 4 is turn 1) — same length, different rows.
    const windowA = [makeUserItem("t1", "1"), reply("a1"), reply("a2"), makeUserItem("t2", "2"), reply("a3"), reply("a4"), makeUserItem("t3", "3")];
    const windowB = [makeUserItem("t1", "1"), reply("b1"), reply("b2"), reply("b3"), reply("b4"), makeUserItem("t2", "2"), makeUserItem("t3x", "3")];
    const nav = fakeNav([4, 4]);
    const { container, rerender } = render(<TurnChain nodes={nodes} items={windowA} nav={nav} onJump={vi.fn()} />);
    const bandTop = () => container.querySelector<HTMLElement>(".ol__inview")!.style.top;
    const before = bandTop();
    rerender(<TurnChain nodes={nodes} items={windowB} nav={nav} onJump={vi.fn()} />);
    expect(bandTop()).not.toBe(before);
  });

  it("find hits, the current hit and the peeked turn draw their own marks", () => {
    const { nodes, items } = makeChat(10, 0);
    const { container } = render(
      <TurnChain
        nodes={nodes}
        items={items}
        nav={fakeNav([0, 0])}
        onJump={vi.fn()}
        hitTurns={new Set(["u:t2", "u:t5"])}
        currentTurn="u:t5"
        peekTurn="u:t2"
      />,
    );
    // 10 rows over 600px: turn i at 60i + 30
    expect(container.querySelector('path[data-kind="hit"]')!.getAttribute("d")).toBe("M12 90h4M12 270h4");
    expect(container.querySelector('path[data-kind="hitCur"]')!.getAttribute("d")).toBe("M11 270h5");
    expect(container.querySelector('path[data-kind="hitPeek"]')!.getAttribute("d")).toBe("M11 90h5");
  });

  it("hovering the chain opens nothing", () => {
    vi.useFakeTimers();
    try {
      const { container, chain } = renderChat();
      const ol = container.querySelector(".ol")!;
      fireEvent.pointerEnter(ol, { pointerType: "mouse" });
      fireEvent.pointerOver(chain, { pointerType: "mouse", clientY: 100 });
      move(chain, 100, { buttons: 0 });
      fireEvent.mouseMove(chain, { clientY: 120 });
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(chain).toHaveAttribute("aria-expanded", "false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("focusing the chain does not open it", async () => {
    const user = userEvent.setup();
    const { chain } = renderChat();
    await user.tab();
    expect(document.activeElement).toBe(chain);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("TurnChain: press, scrub, release", () => {
  it("pointerdown opens the list at once, captures the pointer and targets the row under it", () => {
    const { chain } = renderChat();
    press(chain, turnY(3));
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(capture.set).toHaveBeenCalledWith(1);
    expect(outlineRow("t4")).toHaveClass("scrub");
    expect(document.querySelectorAll(".scrub")).toHaveLength(1);
    expect(document.querySelector(".ol__scrub")).not.toBeNull();
    expect(document.querySelector(".olp__foot")).toBeNull();
  });

  it("dragging maps y over the whole chain to turn and step rows and holds the target on the list's centre line", async () => {
    const { chain } = renderChat();
    press(chain, turnY(0));
    const list = document.querySelector<HTMLElement>(".olp__scroll")!;
    Object.defineProperty(list, "clientHeight", { value: 200, configurable: true });

    move(chain, stepY(7, 0));
    await flushFrame();
    const dialogId = screen.getByRole("dialog").id;
    expect(document.getElementById(`${dialogId}-row-t8-b0`)).toHaveClass("scrub");
    // list pad 4 + 7 turns x (32 + 2 x 26) + the turn row 32 = 624; centred in 200px: 624 - (200 - 26) / 2
    expect(list.scrollTop).toBe(537);

    move(chain, turnY(9));
    await flushFrame();
    expect(outlineRow("t10")).toHaveClass("scrub");
    expect(document.querySelectorAll(".scrub")).toHaveLength(1);

    // Past either end clamps to the first / last row.
    move(chain, -200);
    await flushFrame();
    expect(outlineRow("t1")).toHaveClass("scrub");
    move(chain, 5000);
    await flushFrame();
    expect(document.getElementById(`${dialogId}-row-t10-b1`)).toHaveClass("scrub");
  });

  it("releasing after a drag jumps once to the row under the pointer and hides the list SETTLE_HIDE_MS later", async () => {
    const { chain, onJump } = renderChat();
    press(chain, turnY(0));
    move(chain, stepY(4, 1));
    await flushFrame();
    release(chain, stepY(4, 1));
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith("t:b5_1");
    expect(capture.release).toHaveBeenCalledWith(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: SETTLE_HIDE_MS + 1000 });
  });

  it("a new press within the settle second cancels the hide and scrubs again", () => {
    vi.useFakeTimers();
    try {
      const { chain, onJump } = renderChat();
      press(chain, turnY(9));
      release(chain, turnY(2));
      expect(onJump).toHaveBeenCalledTimes(1);
      act(() => {
        vi.advanceTimersByTime(SETTLE_HIDE_MS - 100);
      });
      press(chain, turnY(4));
      act(() => {
        vi.advanceTimersByTime(SETTLE_HIDE_MS * 2);
      });
      expect(screen.getByRole("dialog")).toBeDefined();
      release(chain, turnY(4) + 3);
      expect(screen.getByRole("dialog")).toBeDefined(); // a tap: sticky, no hide
    } finally {
      vi.useRealTimers();
    }
  });

  it("a drag onto a turn row jumps to the turn's anchor", () => {
    const { chain, onJump } = renderChat();
    press(chain, turnY(9));
    release(chain, turnY(2));
    expect(onJump).toHaveBeenCalledWith("u:t3");
  });

  it("a tap keeps the list open as a sticky list: rows jump and close, pressing the chain again closes", () => {
    const { chain, onJump } = renderChat();
    press(chain, turnY(2));
    release(chain, turnY(2) + 3);
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(onJump).not.toHaveBeenCalled();
    // The sticky list rings the tapped row, the same row the rail marks.
    expect(document.querySelectorAll(".scrub")).toHaveLength(1);
    expect(outlineRow("t3")).toHaveClass("scrub");
    expect(document.querySelector(".olp__foot")).toBeNull();

    press(chain, turnY(5));
    release(chain, turnY(5));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onJump).not.toHaveBeenCalled();

    press(chain, turnY(2));
    release(chain, turnY(2));
    fireEvent.click(outlineRow("t6")!);
    expect(onJump).toHaveBeenCalledWith("u:t6");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a press outside the chain and the list, or Esc, closes the sticky list", () => {
    const { chain } = renderChat();
    press(chain, turnY(1));
    release(chain, turnY(1));
    fireEvent.pointerDown(screen.getByRole("dialog"));
    expect(screen.getByRole("dialog")).toBeDefined();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();

    press(chain, turnY(1));
    release(chain, turnY(1));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("pointercancel closes without a jump", async () => {
    const { chain, onJump } = renderChat();
    press(chain, turnY(0));
    move(chain, turnY(6));
    await flushFrame();
    fireEvent.pointerCancel(chain, { pointerId: 1, pointerType: "touch" });
    expect(screen.queryByRole("dialog")).toBeNull();
    release(chain, turnY(6));
    expect(onJump).not.toHaveBeenCalled();
  });

  it("a second pointer never steals the press", async () => {
    const { chain, onJump } = renderChat();
    press(chain, turnY(1), { pointerType: "touch" });
    press(chain, turnY(8), { pointerId: 2, pointerType: "touch" });
    move(chain, turnY(8), { pointerId: 2, pointerType: "touch" });
    await flushFrame();
    expect(outlineRow("t2")).toHaveClass("scrub");
    release(chain, turnY(8), { pointerId: 2, pointerType: "touch" });
    fireEvent.pointerCancel(chain, { pointerId: 2, pointerType: "touch" });
    expect(screen.getByRole("dialog")).toBeDefined();

    // A second finger landing elsewhere does not close the list mid-press either.
    fireEvent.pointerDown(document.body, { pointerId: 2, pointerType: "touch" });
    expect(screen.getByRole("dialog")).toBeDefined();

    move(chain, turnY(4), { pointerType: "touch" });
    release(chain, turnY(4), { pointerType: "touch" });
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith("u:t5");
  });

  it("a touch press opens the list with 44px rows and a close button", () => {
    const { chain } = renderChat();
    press(chain, turnY(0), { pointerType: "touch" });
    release(chain, turnY(0), { pointerType: "touch" });
    expect(screen.getByRole("dialog")).toHaveClass("olp--touch");
    fireEvent.click(screen.getByRole("button", { name: "Close outline" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a scrub over a turn's steps always targets the step (nothing folds)", async () => {
    const { chain, onJump } = renderChat(10, 2);
    press(chain, turnY(0));
    move(chain, stepY(2, 1));
    await flushFrame();
    const dialogId = screen.getByRole("dialog").id;
    expect(document.getElementById(`${dialogId}-row-t3-b1`)).toHaveClass("scrub");
    release(chain, stepY(2, 1));
    expect(onJump).toHaveBeenCalledWith("t:b3_1");
  });
});

/** The chain is visible, interactive and painted (no hiding attribute or style on it or its ancestors). */
function expectChainShown(container: HTMLElement, chain: HTMLElement) {
  const ol = container.querySelector<HTMLElement>(".ol")!;
  expect(ol).toBeInTheDocument();
  expect(ol.contains(chain)).toBe(true);
  expect(container.querySelector("svg.ol__marks")).not.toBeNull();
  for (let el: HTMLElement | null = chain; el && el !== document.body; el = el.parentElement) {
    expect(el.hidden, el.className).toBe(false);
    expect(el.hasAttribute("inert"), el.className).toBe(false);
    expect(el.getAttribute("aria-hidden"), el.className).not.toBe("true");
    expect(el.style.visibility, el.className).not.toBe("hidden");
    expect(el.style.display, el.className).not.toBe("none");
    expect(el.style.opacity, el.className).toBe("");
    expect(el.style.pointerEvents, el.className).not.toBe("none");
  }
  expect(chain).not.toBeDisabled();
  // The panel is a sibling beside the chain, never wrapped around or inside it.
  const dialog = screen.getByRole("dialog");
  expect(ol.contains(dialog)).toBe(false);
  expect(dialog.contains(ol)).toBe(false);
}

describe("TurnChain: the chain stays shown while the list is open", () => {
  it("during a scrub the chain stays visible and marks the row under the pointer", async () => {
    const { container, chain } = renderChat();
    press(chain, turnY(2));
    expectChainShown(container, chain);
    expect(container.querySelector(".ol")).toHaveClass("ol--open");
    expect(container.querySelector<HTMLElement>(".ol__scrub")!.style.top).toBe(`${turnY(2)}px`);

    move(chain, stepY(5, 1));
    await flushFrame();
    expectChainShown(container, chain);
    expect(container.querySelector<HTMLElement>(".ol__scrub")!.style.top).toBe(`${stepY(5, 1)}px`);
  });

  it("after a tap the chain stays visible, keeps marking the tapped row and takes the next press", () => {
    const { container, chain } = renderChat();
    press(chain, turnY(4));
    release(chain, turnY(4) + 2);
    expect(screen.getByRole("dialog")).toBeDefined();
    expectChainShown(container, chain);
    expect(container.querySelector<HTMLElement>(".ol__scrub")!.style.top).toBe(`${turnY(4)}px`);
    press(chain, turnY(4));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container.querySelector(".ol__scrub")).toBeNull();
  });

  it("a keyboard open marks the focused row on the chain and follows the arrows", async () => {
    const user = userEvent.setup();
    const { container, chain } = renderChat(10, 2);
    chain.focus();
    await user.keyboard("{Enter}");
    expectChainShown(container, chain);
    // Focus starts on the turn in view: turn 1.
    expect(container.querySelector<HTMLElement>(".ol__scrub")!.style.top).toBe(`${turnY(0)}px`);
    await user.keyboard("{ArrowDown}");
    expect(container.querySelector<HTMLElement>(".ol__scrub")!.style.top).toBe(`${stepY(0, 0)}px`);
  });
});

describe("TurnChain: keyboard", () => {
  it("Enter opens with key hints; arrows move; Enter jumps and closes; Esc closes and keeps focus", async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    const { nodes, items } = makeChat(5, 0);
    render(<TurnChain nodes={nodes} items={items} nav={fakeNav([0, 0])} onJump={onJump} />);
    const chain = screen.getByRole("button", { name: /^Conversation outline, 5 turns\./ });
    chain.focus();

    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(document.querySelector(".olp__foot")!.textContent).toContain("Jump");
    expect(outlineRow("t1")).toHaveClass("kfocus");
    expect(chain).toHaveAttribute("aria-activedescendant", outlineRow("t1")!.id);

    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(chain).toHaveAttribute("aria-activedescendant", outlineRow("t3")!.id);
    await user.keyboard("{Enter}");
    expect(onJump).toHaveBeenCalledWith("u:t3");
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.keyboard(" ");
    expect(screen.getByRole("dialog")).toBeDefined();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(chain);
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it("starts keyboard focus on the turn in view", async () => {
    const user = userEvent.setup();
    const { nodes, items } = makeChat(8, 0);
    render(<TurnChain nodes={nodes} items={items} nav={fakeNav([4, 4])} onJump={vi.fn()} />);
    screen.getByRole("button", { name: /Conversation outline/ }).focus();
    await user.keyboard("{Enter}");
    expect(outlineRow("t5")).toHaveClass("kfocus");
    expect(outlineRow("t5")).toHaveClass("cur");
  });

  it("Esc from an outside focused field closes the list and stops propagation", () => {
    const wrapKeyDown = vi.fn();
    const { nodes, items } = makeChat(3, 0);
    render(
      <div onKeyDown={wrapKeyDown}>
        <textarea data-testid="composer" />
        <TurnChain nodes={nodes} items={items} nav={fakeNav([0, 2])} onJump={vi.fn()} />
      </div>,
    );
    const chain = screen.getByRole("button", { name: /Conversation outline/ });
    press(chain, 10);
    release(chain, 10);
    const textarea = screen.getByTestId("composer");
    textarea.focus();
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(textarea);
    expect(wrapKeyDown).not.toHaveBeenCalled();
  });
});

describe("TurnChain: wheel scrub", () => {
  const leaveRail = (container: HTMLElement) =>
    fireEvent.pointerOut(container.querySelector(".ol")!, { pointerType: "mouse" });

  it("a wheel on the rail opens the list, prevents the chat scroll and marks the row", () => {
    vi.useFakeTimers();
    try {
      const { chain, onJump } = renderChat();
      const ev = wheelOn(chain);
      expect(ev.defaultPrevented).toBe(true);
      expect(screen.getByRole("dialog")).toBeDefined();
      expect(chain).toHaveAttribute("aria-expanded", "true");
      // 100px is 3.57 rows from turn 1's row: flat row 4 is turn 2's first step.
      expect(rowOf("t2-b0")).toHaveClass("scrub");
      expect(document.querySelectorAll(".scrub")).toHaveLength(1);
      expect(document.querySelector(".ol__scrub")).not.toBeNull();
      expect(onJump).not.toHaveBeenCalled();
      // The panel's live region speaks the resting row after its 300ms debounce.
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(document.querySelector(".olp__sr")!.textContent).toBe("Beat 2.0");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a second wheel moves the scrub row and the chain marker", () => {
    vi.useFakeTimers();
    try {
      const { chain, container } = renderChat();
      wheelOn(chain);
      const marker = container.querySelector<HTMLElement>(".ol__scrub")!;
      const firstTop = marker.style.top;
      wheelOn(chain);
      act(() => {
        vi.advanceTimersByTime(16);
      });
      expect(rowOf("t3-b0")).toHaveClass("scrub");
      expect(marker.style.top).not.toBe(firstTop);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the list stays open for 2s after the pointer leaves the rail and the panel, then closes without jumping", () => {
    vi.useFakeTimers();
    try {
      const { chain, container, onJump } = renderChat();
      wheelOn(chain);
      leaveRail(container);
      act(() => {
        vi.advanceTimersByTime(HOVER_GRACE_MS - 1);
      });
      expect(screen.getByRole("dialog")).toBeDefined();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(onJump).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaving and then entering the panel cancels the grace", () => {
    vi.useFakeTimers();
    try {
      const { chain, container } = renderChat();
      wheelOn(chain);
      leaveRail(container);
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      fireEvent.pointerOver(screen.getByRole("dialog"), { pointerType: "mouse" });
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(screen.getByRole("dialog")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Esc during the grace closes at once", () => {
    vi.useFakeTimers();
    try {
      const { chain, container, onJump } = renderChat();
      wheelOn(chain);
      leaveRail(container);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(onJump).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clicking a row from wheel mode jumps and closes", () => {
    vi.useFakeTimers();
    try {
      const { chain, onJump } = renderChat();
      wheelOn(chain);
      fireEvent.click(rowOf("t2-b0"));
      expect(onJump).toHaveBeenCalledWith("t:b2_0");
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores rail wheels within the chat-wheel guard, extended by the momentum it swallows", () => {
    vi.useFakeTimers();
    try {
      const scroller = document.createElement("div");
      const { nodes, items } = makeChat(10, 2);
      render(
        <TurnChain nodes={nodes} items={items} nav={fakeNav([0, 0])} onJump={vi.fn()} scrollElement={scroller} />,
      );
      const chain = screen.getByRole("button", { name: /^Conversation outline, 10 turns\./ });
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, cancelable: true, bubbles: true }));
      act(() => {
        vi.advanceTimersByTime(WHEEL_CHAT_GUARD_MS - 1);
      });
      const momentum = wheelOn(chain);
      expect(momentum.defaultPrevented).toBe(false);
      act(() => {
        vi.advanceTimersByTime(WHEEL_CHAT_GUARD_MS - 1);
      });
      expect(wheelOn(chain).defaultPrevented).toBe(false);
      expect(screen.queryByRole("dialog")).toBeNull();

      act(() => {
        vi.advanceTimersByTime(WHEEL_CHAT_GUARD_MS);
      });
      const later = wheelOn(chain);
      expect(later.defaultPrevented).toBe(true);
      expect(screen.getByRole("dialog")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pressing the rail in wheel mode starts the normal press-scrub: a drag jumps on release", () => {
    vi.useFakeTimers();
    try {
      const { chain, onJump } = renderChat();
      wheelOn(chain);
      press(chain, turnY(0));
      move(chain, turnY(5));
      act(() => {
        vi.advanceTimersByTime(16);
      });
      expect(rowOf("t6")).toHaveClass("scrub");
      release(chain, turnY(5));
      expect(onJump).toHaveBeenCalledWith("u:t6");
      act(() => {
        vi.advanceTimersByTime(SETTLE_HIDE_MS);
      });
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a sticky list never gets a leave timer", () => {
    vi.useFakeTimers();
    try {
      const { chain, container } = renderChat();
      press(chain, turnY(2));
      release(chain, turnY(2));
      expect(screen.getByRole("dialog")).toBeDefined();
      leaveRail(container);
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(screen.getByRole("dialog")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a wheel during a held press neither scrubs nor drops the press: the tap still pins the list", () => {
    vi.useFakeTimers();
    try {
      const { chain, container } = renderChat();
      press(chain, turnY(2));
      const ev = wheelOn(chain);
      expect(ev.defaultPrevented).toBe(true);
      expect(rowOf("t3")).toHaveClass("scrub");
      release(chain, turnY(2));
      leaveRail(container);
      act(() => {
        vi.advanceTimersByTime(HOVER_GRACE_MS * 2);
      });
      expect(screen.getByRole("dialog")).toBeDefined();
      expect(rowOf("t3")).toHaveClass("scrub");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a wheel over a sticky list starts from the tapped row, not the turn in view", () => {
    vi.useFakeTimers();
    try {
      const { chain } = renderChat();
      press(chain, turnY(4));
      release(chain, turnY(4));
      expect(rowOf("t5")).toHaveClass("scrub");
      wheelOn(chain);
      // 100px is 3.57 rows from turn 5's row (flat row 12): row 16 is turn 6's first step.
      expect(rowOf("t6-b0")).toHaveClass("scrub");
      expect(document.querySelectorAll(".scrub")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaving the rail before the wheel's render commits still starts the grace", () => {
    vi.useFakeTimers();
    try {
      const { chain, container } = renderChat();
      act(() => {
        chain.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, cancelable: true, bubbles: true }));
        fireEvent.pointerOver(container.querySelector(".ol")!, { pointerType: "mouse" });
        leaveRail(container);
      });
      expect(screen.getByRole("dialog")).toBeDefined();
      act(() => {
        vi.advanceTimersByTime(HOVER_GRACE_MS);
      });
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("window blur starts the grace; focus back with the pointer still on the rail cancels it", () => {
    vi.useFakeTimers();
    try {
      const { chain, container } = renderChat();
      wheelOn(chain);
      fireEvent.pointerOver(container.querySelector(".ol")!, { pointerType: "mouse" });
      act(() => {
        window.dispatchEvent(new Event("blur"));
      });
      act(() => {
        vi.advanceTimersByTime(HOVER_GRACE_MS / 2);
      });
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      act(() => {
        vi.advanceTimersByTime(HOVER_GRACE_MS * 2);
      });
      expect(screen.getByRole("dialog")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("window blur with the pointer off the rail closes after the grace even if focus returns", () => {
    vi.useFakeTimers();
    try {
      const { chain } = renderChat();
      wheelOn(chain);
      act(() => {
        window.dispatchEvent(new Event("blur"));
        window.dispatchEvent(new Event("focus"));
      });
      act(() => {
        vi.advanceTimersByTime(HOVER_GRACE_MS);
      });
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("unmounting clears the grace timer", () => {
    vi.useFakeTimers();
    try {
      const { chain, container, unmount } = renderChat();
      wheelOn(chain);
      leaveRail(container);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TurnChain: wheel auto-jump", () => {
  const leaveRail = (container: HTMLElement, init: Record<string, unknown> = {}) =>
    fireEvent.pointerOut(container.querySelector(".ol")!, { pointerType: "mouse", ...init });
  const tick = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("jumps to the highlighted row once the wheel rests, then hides the list SETTLE_HIDE_MS later", () => {
    const { chain, onJump } = renderChat();
    wheelOn(chain);
    tick(WHEEL_JUMP_IDLE_MS - 1);
    expect(onJump).not.toHaveBeenCalled();
    tick(1);
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith("t:b2_0");
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(rowOf("t2-b0")).toHaveClass("scrub");
    tick(SETTLE_HIDE_MS - 1);
    expect(screen.getByRole("dialog")).toBeDefined();
    tick(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    // The hide is the only timer left; nothing re-opens or jumps again.
    expect(vi.getTimerCount()).toBe(0);
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it("a list opened after the hide shows the live rows again, not the settled snapshot", () => {
    const { chain, rerender, nodes, onJump } = renderChat();
    wheelOn(chain);
    tick(WHEEL_JUMP_IDLE_MS + SETTLE_HIDE_MS);
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<TurnChain nodes={nodes.slice(5)} items={[]} nav={fakeNav([0, 0])} onJump={onJump} />);
    tick(WHEEL_CHAT_GUARD_MS);
    wheelOn(chain);
    expect(screen.queryByRole("treeitem", { name: /^Turn 2:/ })).toBeNull();
    expect(screen.getByRole("treeitem", { name: /^Turn 6:/ })).toBeDefined();
  });

  it("a wheel frame landing after a leave-commit does not cancel the hide", () => {
    const { chain, container } = renderChat();
    wheelOn(chain);
    tick(WHEEL_ARM_MS);
    wheelOn(chain);
    leaveRail(container);
    tick(16 + SETTLE_HIDE_MS);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a wheel within the settle second cancels the hide and keeps the list open", () => {
    const { chain, onJump } = renderChat();
    wheelOn(chain);
    tick(WHEEL_JUMP_IDLE_MS);
    tick(SETTLE_HIDE_MS - 100);
    wheelOn(chain);
    tick(16 + 200);
    expect(screen.getByRole("dialog")).toBeDefined();
    tick(WHEEL_JUMP_IDLE_MS);
    expect(onJump).toHaveBeenCalledTimes(2);
    tick(SETTLE_HIDE_MS);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the settled list keeps its rows (no rebuilt list from turn 1) while the chat's outline changes", () => {
    const { chain, rerender, nodes, onJump } = renderChat();
    wheelOn(chain);
    tick(WHEEL_JUMP_IDLE_MS);
    const before = screen.getAllByRole("treeitem").length;
    // The jump swaps the chat window: the outline is rebuilt without the marked row.
    rerender(<TurnChain nodes={nodes.slice(5)} items={[]} nav={fakeNav([0, 0])} onJump={onJump} />);
    tick(SETTLE_HIDE_MS / 2);
    expect(screen.getAllByRole("treeitem").length).toBe(before);
    expect(rowOf("t2-b0")).toHaveClass("scrub");
  });

  it("debounces: wheels 200ms apart never jump until the wheel has rested", () => {
    const { chain, onJump } = renderChat();
    wheelOn(chain);
    for (let i = 0; i < 3; i++) {
      tick(200);
      wheelOn(chain);
    }
    expect(onJump).not.toHaveBeenCalled();
    // Over 1s since the first wheel, yet the last one (its row lands on the next frame) re-armed the wait.
    tick(WHEEL_JUMP_IDLE_MS - 1);
    expect(onJump).not.toHaveBeenCalled();
    tick(50);
    expect(onJump).toHaveBeenCalledTimes(1);
    // Four 100px wheels from turn 1's row: flat row 14 is turn 5's second step.
    expect(onJump).toHaveBeenCalledWith("t:b5_1");
  });

  it("a later wheel jumps again, also when it clamps to the same row", () => {
    const { chain, onJump } = renderChat();
    wheelOn(chain);
    tick(WHEEL_JUMP_IDLE_MS);
    wheelOn(chain);
    tick(16 + WHEEL_JUMP_IDLE_MS);
    expect(onJump).toHaveBeenCalledTimes(2);
    expect(onJump).toHaveBeenLastCalledWith("t:b3_0");

    wheelOn(chain, { deltaY: 5000 });
    tick(16 + WHEEL_JUMP_IDLE_MS);
    expect(onJump).toHaveBeenCalledTimes(3);
    expect(onJump).toHaveBeenLastCalledWith("t:b10_1");
    wheelOn(chain, { deltaY: 5000 });
    tick(16 + WHEEL_JUMP_IDLE_MS);
    // The list hides after each settle, so a rest on the same row jumps again.
    expect(onJump).toHaveBeenCalledTimes(4);
  });

  it("leaving the region before the wheel session is armed cancels the jump", () => {
    const { chain, container, onJump } = renderChat();
    wheelOn(chain);
    tick(WHEEL_ARM_MS - 100);
    leaveRail(container);
    tick(WHEEL_JUMP_IDLE_MS);
    expect(onJump).not.toHaveBeenCalled();
    tick(HOVER_GRACE_MS);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onJump).not.toHaveBeenCalled();
  });

  it("leaving once armed commits at once, and the settle hide then closes with no second jump", () => {
    const { chain, container, onJump } = renderChat();
    wheelOn(chain);
    tick(WHEEL_ARM_MS);
    leaveRail(container);
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith("t:b2_0");
    expect(screen.getByRole("dialog")).toBeDefined();
    // The settle's hide closes it, not the 2 s grace.
    tick(SETTLE_HIDE_MS);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it("after a leave the same row jumps again: the chat may have moved meanwhile", () => {
    const { chain, container, onJump } = renderChat();
    wheelOn(chain);
    tick(WHEEL_JUMP_IDLE_MS);
    expect(onJump).toHaveBeenCalledTimes(1);
    leaveRail(container);
    fireEvent.pointerOver(container.querySelector(".ol")!, { pointerType: "mouse" });
    wheelOn(chain, { deltaY: 1 });
    tick(16 + WHEEL_JUMP_IDLE_MS);
    expect(onJump).toHaveBeenCalledTimes(2);
    expect(onJump).toHaveBeenLastCalledWith("t:b2_0");
  });

  it("crossing between the rail and the list keeps the pending jump", () => {
    const { chain, container, onJump } = renderChat();
    wheelOn(chain);
    tick(WHEEL_ARM_MS - 200);
    const dialog = screen.getByRole("dialog");
    leaveRail(container, { relatedTarget: dialog });
    expect(onJump).not.toHaveBeenCalled();
    tick(100);
    fireEvent.pointerOut(dialog, { pointerType: "mouse", relatedTarget: chain });
    expect(onJump).not.toHaveBeenCalled();
    tick(WHEEL_JUMP_IDLE_MS - (WHEEL_ARM_MS - 100));
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("crossing once armed never commits early: the jump still waits for the idle", () => {
    const { chain, container, onJump } = renderChat();
    wheelOn(chain);
    tick(WHEEL_ARM_MS + 50);
    leaveRail(container, { relatedTarget: screen.getByRole("dialog") });
    expect(onJump).not.toHaveBeenCalled();
    tick(WHEEL_JUMP_IDLE_MS - (WHEEL_ARM_MS + 50) - 1);
    expect(onJump).not.toHaveBeenCalled();
    tick(1);
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it("a wheel frame landing after an armed leave neither re-arms a jump nor holds the list open", () => {
    const { chain, container, onJump } = renderChat();
    wheelOn(chain);
    tick(WHEEL_ARM_MS);
    // Its row lands on the next frame, after the pointer has gone.
    wheelOn(chain);
    leaveRail(container);
    expect(onJump).toHaveBeenCalledTimes(1);
    tick(16 + WHEEL_JUMP_IDLE_MS + HOVER_GRACE_MS);
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a flick after coming back during the grace is a new session: leaving at once jumps nowhere", () => {
    const { chain, container, onJump } = renderChat();
    wheelOn(chain);
    tick(WHEEL_ARM_MS + 100);
    leaveRail(container);
    expect(onJump).toHaveBeenCalledTimes(1);
    tick(500);
    fireEvent.pointerOver(container.querySelector(".ol")!, { pointerType: "mouse" });
    wheelOn(chain);
    tick(16);
    leaveRail(container);
    tick(WHEEL_JUMP_IDLE_MS + HOVER_GRACE_MS);
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it("after the list leaves wheel mode, wheeling back onto the auto-jumped row jumps again", () => {
    const { chain, onJump } = renderChat();
    chain.focus();
    wheelOn(chain);
    tick(WHEEL_JUMP_IDLE_MS);
    expect(onJump).toHaveBeenLastCalledWith("t:b2_0");
    // An arrow key pins the list (the chat may now be scrolled by hand), focus on turn 2's second step.
    fireEvent.keyDown(chain, { key: "ArrowDown" });
    // Past the momentum guard that leaving wheel mode sets; one row up is the auto-jumped row again.
    tick(WHEEL_CHAT_GUARD_MS);
    wheelOn(chain, { deltaY: -28 });
    expect(rowOf("t2-b0")).toHaveClass("scrub");
    tick(WHEEL_JUMP_IDLE_MS);
    expect(onJump).toHaveBeenCalledTimes(2);
    expect(onJump).toHaveBeenLastCalledWith("t:b2_0");
  });

  it("a filter edit cancels the pending jump", () => {
    // Long enough for the list to show its filter box.
    const { chain, onJump } = renderChat(120, 0);
    wheelOn(chain);
    fireEvent.change(screen.getByRole("textbox", { name: "Filter turns" }), { target: { value: "Turn" } });
    tick(WHEEL_JUMP_IDLE_MS * 2);
    expect(onJump).not.toHaveBeenCalled();
  });

  it("window blur cancels the pending jump", () => {
    const { chain, onJump } = renderChat();
    wheelOn(chain);
    tick(WHEEL_ARM_MS);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    tick(WHEEL_JUMP_IDLE_MS);
    expect(onJump).not.toHaveBeenCalled();
  });

  it("Esc cancels the pending jump and closes", () => {
    const { chain, onJump } = renderChat();
    wheelOn(chain);
    tick(WHEEL_ARM_MS);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    tick(WHEEL_JUMP_IDLE_MS);
    expect(onJump).not.toHaveBeenCalled();
  });

  it("a press on the rail cancels the pending jump; the drag's release jumps exactly once", () => {
    const { chain, onJump } = renderChat();
    wheelOn(chain);
    tick(WHEEL_ARM_MS);
    press(chain, turnY(0));
    tick(WHEEL_JUMP_IDLE_MS);
    expect(onJump).not.toHaveBeenCalled();
    move(chain, turnY(5));
    tick(16);
    release(chain, turnY(5));
    tick(WHEEL_JUMP_IDLE_MS);
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith("u:t6");
  });

  it("Enter jumps at once and no timer jump follows", () => {
    const { chain, onJump } = renderChat();
    chain.focus();
    wheelOn(chain);
    fireEvent.keyDown(chain, { key: "Enter" });
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith("t:b2_0");
    tick(WHEEL_JUMP_IDLE_MS * 2);
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it("a row click always jumps, even to the row the auto-jump just reached, and no timer jump follows", () => {
    const { chain, onJump } = renderChat();
    wheelOn(chain);
    tick(WHEEL_JUMP_IDLE_MS);
    expect(onJump).toHaveBeenCalledTimes(1);
    wheelOn(chain, { deltaY: 1 });
    tick(16);
    fireEvent.click(rowOf("t2-b0"));
    expect(onJump).toHaveBeenCalledTimes(2);
    expect(onJump).toHaveBeenLastCalledWith("t:b2_0");
    expect(screen.queryByRole("dialog")).toBeNull();
    tick(WHEEL_JUMP_IDLE_MS * 2);
    expect(onJump).toHaveBeenCalledTimes(2);
  });

  it("ArrowDown cancels the pending jump", () => {
    const { chain, onJump } = renderChat();
    chain.focus();
    wheelOn(chain);
    fireEvent.keyDown(chain, { key: "ArrowDown" });
    tick(WHEEL_JUMP_IDLE_MS * 2);
    expect(onJump).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("unmounting clears a pending jump", () => {
    const { chain, unmount, onJump } = renderChat();
    wheelOn(chain);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(onJump).not.toHaveBeenCalled();
  });
});

describe("TurnChain: keys follow the marked row", () => {
  const leaveRail = (container: HTMLElement) =>
    fireEvent.pointerOut(container.querySelector(".ol")!, { pointerType: "mouse" });

  it("Enter after a wheel jumps to the ringed row, not the turn in view", () => {
    vi.useFakeTimers();
    try {
      const { chain, onJump } = renderChat();
      chain.focus();
      wheelOn(chain);
      wheelOn(chain);
      act(() => {
        vi.advanceTimersByTime(16);
      });
      // Two 100px wheels from turn 1's row land on turn 3's first step.
      expect(rowOf("t3-b0")).toHaveClass("scrub");
      fireEvent.keyDown(chain, { key: "Enter" });
      expect(onJump).toHaveBeenCalledTimes(1);
      expect(onJump).toHaveBeenCalledWith("t:b3_0");
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ArrowDown after a wheel continues from the ringed row", () => {
    vi.useFakeTimers();
    try {
      const { chain } = renderChat();
      chain.focus();
      wheelOn(chain);
      expect(rowOf("t2-b0")).toHaveClass("scrub");
      fireEvent.keyDown(chain, { key: "ArrowDown" });
      // Turn 2's second step, not the turn in view's first step.
      expect(rowOf("t2-b1")).toHaveClass("kfocus");
      expect(document.querySelectorAll(".kfocus")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Enter after a tap jumps to the tapped row", () => {
    const { chain, onJump } = renderChat();
    chain.focus();
    press(chain, turnY(4));
    release(chain, turnY(4));
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(rowOf("t5")).toHaveClass("scrub");
    fireEvent.keyDown(chain, { key: "Enter" });
    expect(onJump).toHaveBeenCalledWith("u:t5");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Enter in the filter box jumps to the first listed turn when the filter hides the turn in view", () => {
    const { nodes, items } = makeChat(120, 0);
    const onJump = vi.fn();
    render(<TurnChain nodes={nodes} items={items} nav={fakeNav([0, 0])} onJump={onJump} />);
    const chain = screen.getByRole("button", { name: /^Conversation outline, 120 turns\./ });
    // 120 turn rows over 600px: 5px each, turn 1's centre at 2.5.
    press(chain, 2.5);
    release(chain, 2.5);
    const input = screen.getByRole("textbox", { name: "Filter turns" });
    fireEvent.change(input, { target: { value: "Turn 100" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onJump).toHaveBeenCalledWith("u:t100");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a wheel list that becomes a keyboard pin never gets the leave timer", () => {
    vi.useFakeTimers();
    try {
      const { chain, container } = renderChat();
      chain.focus();
      wheelOn(chain);
      leaveRail(container);
      fireEvent.keyDown(chain, { key: "ArrowDown" });
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(screen.getByRole("dialog")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the rail's tooltip is dropped while the list is open", () => {
    vi.useFakeTimers();
    try {
      const { chain } = renderChat();
      expect(chain).toHaveAttribute("title", "Scroll or drag to move through the chat");
      wheelOn(chain);
      expect(chain).not.toHaveAttribute("title");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TurnChain: panel placement", () => {
  it("the list is a dialog with a tree, and the chain controls it", () => {
    const { chain } = renderChat(4, 1);
    press(chain, 10);
    release(chain, 10);
    const dialog = screen.getByRole("dialog");
    expect(chain).toHaveAttribute("aria-controls", dialog.id);
    expect(chain).toHaveAttribute("aria-expanded", "true");
    expect(dialog.querySelector('[role="tree"]')).not.toBeNull();
    expect(document.querySelector(".olscrim")).toBeNull();
  });

  it("live turns stay marked on the chain", () => {
    const nodes: TurnNode[] = makeChat(4, 0).nodes;
    nodes[3] = { ...nodes[3]!, live: true };
    const { container } = render(<TurnChain nodes={nodes} items={[]} onJump={vi.fn()} />);
    expect(container.querySelector('path[data-kind="turnLive"]')).not.toBeNull();
  });

  it("a chain under OLP_COMPACT_MAX_H opens a compact list; a tall chain does not", () => {
    const tall = renderChat(4, 1);
    press(tall.chain, 10);
    release(tall.chain, 10);
    expect(screen.getByRole("dialog")).not.toHaveClass("olp--compact");
    tall.unmount();

    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(117);
    try {
      const short = renderChat(4, 1);
      press(short.chain, 10);
      release(short.chain, 10);
      expect(screen.getByRole("dialog")).toHaveClass("olp--compact");
    } finally {
      vi.restoreAllMocks();
    }
  });
});
