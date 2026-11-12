import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TurnChain } from "./TurnChain";
import { SCRUB_TOP_LOAD_DWELL_MS, SCRUB_TOP_LOADS_PER_REST } from "./useTopLoadDwell";
import { WHEEL_JUMP_IDLE_MS } from "./useWheelAutoJump";
import { WHEEL_CHAT_GUARD_MS } from "./useRailWheel";
import type { TurnNode } from "./buildTurnOutline";
import type { RenderItem } from "../MessageList";
import { fakeNav, makeBeat, makeChat, makeTurn, makeUserItem } from "./outlineTestUtils";

/*
 * The chain is 600px tall in jsdom with its top at 0. With `hasMore` the hatched
 * cap takes the top 16px (12px cap + 4px gap); `makeChat(10, 2)` spreads its 30
 * flat rows over the remaining 584px, so row 0 spans y 16..35.5.
 */
const capture = { set: vi.fn(), release: vi.fn(), has: vi.fn(() => true) };

beforeEach(() => {
  vi.useFakeTimers();
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
  vi.useRealTimers();
  vi.clearAllMocks();
});

const tick = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

/** Lets the load's settle callbacks run. */
const flushSettle = () => act(async () => {});

const wheelOn = (el: Element, deltaY: number) =>
  fireEvent(el, new WheelEvent("wheel", { deltaY, deltaMode: 0, cancelable: true, bubbles: true }));
const press = (el: Element, y: number) =>
  fireEvent.pointerDown(el, { pointerId: 1, pointerType: "mouse", button: 0, clientY: y });
const move = (el: Element, y: number) => fireEvent.pointerMove(el, { pointerId: 1, pointerType: "mouse", clientY: y });

const rowOf = (key: string) => document.getElementById(`${screen.getByRole("dialog").id}-row-${key}`)!;

/** Two earlier turns (`{tag}1`, `{tag}2`, two steps each) to prepend. */
function earlierTurns(tag: string): { nodes: TurnNode[]; items: RenderItem[] } {
  const nodes = [`${tag}1`, `${tag}2`].map((key, i) => ({
    ...makeTurn(key, i - 1, `Earlier ${key}`),
    beats: [0, 1].map((k) => makeBeat(`${key}_${k}`, "text", `Earlier ${key}.${k}`)),
  }));
  return { nodes, items: nodes.map((n) => makeUserItem(n.key, n.label)) };
}

interface Props {
  nodes: TurnNode[];
  items: RenderItem[];
  hasMore?: boolean;
  loadingEarlier?: boolean;
}

function setup(initial: Partial<Props> = {}, chat = makeChat(10, 2)) {
  const onLoadEarlier = vi.fn();
  const onJump = vi.fn();
  const nav = fakeNav([0, 0]);
  let props: Props = { nodes: chat.nodes, items: chat.items, hasMore: true, loadingEarlier: false, ...initial };
  const el = (p: Props) => (
    <TurnChain {...p} nav={nav} onJump={onJump} onLoadEarlier={onLoadEarlier} />
  );
  const utils = render(el(props));
  const update = (next: Partial<Props>) => {
    props = { ...props, ...next };
    utils.rerender(el(props));
  };
  /** Commit a prepend of two earlier turns (`p*`, then `q*`, ...) and settle the load. */
  let pages = 0;
  const prepend = () => {
    const earlier = earlierTurns("pqrstu"[pages++]!);
    update({ nodes: [...earlier.nodes, ...props.nodes], items: [...earlier.items, ...props.items], loadingEarlier: false });
  };
  const chain = screen.getByRole("button", { name: /^Conversation outline/ });
  return { ...utils, chain, onLoadEarlier, onJump, update, prepend };
}

describe("TurnChain: top-of-rail auto-load", () => {
  it("a wheel resting on the top row loads earlier turns once, after the dwell", () => {
    const { chain, onLoadEarlier } = setup();
    // The load stays out for the whole test.
    onLoadEarlier.mockReturnValue(new Promise<void>(() => {}));
    wheelOn(chain, -100);
    expect(rowOf("t1")).toHaveClass("scrub");
    tick(SCRUB_TOP_LOAD_DWELL_MS - 1);
    expect(onLoadEarlier).not.toHaveBeenCalled();
    tick(1);
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
    // Over-scrolling at the top while the load is out never fans out a second one.
    wheelOn(chain, -100);
    tick(16);
    tick(SCRUB_TOP_LOAD_DWELL_MS * 4);
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
  });

  it("loads nothing when every turn is loaded", () => {
    const { chain, onLoadEarlier } = setup({ hasMore: false });
    wheelOn(chain, -100);
    tick(SCRUB_TOP_LOAD_DWELL_MS * 4);
    expect(onLoadEarlier).not.toHaveBeenCalled();
  });

  it("loads nothing while a load is already in flight", () => {
    const { chain, onLoadEarlier } = setup({ loadingEarlier: true });
    wheelOn(chain, -100);
    tick(SCRUB_TOP_LOAD_DWELL_MS * 4);
    expect(onLoadEarlier).not.toHaveBeenCalled();
  });

  it("a scrub that leaves the top row before the dwell loads nothing", () => {
    const { chain, onLoadEarlier } = setup();
    wheelOn(chain, -100);
    tick(SCRUB_TOP_LOAD_DWELL_MS - 50);
    wheelOn(chain, 100);
    tick(16);
    expect(rowOf("t1")).not.toHaveClass("scrub");
    tick(SCRUB_TOP_LOAD_DWELL_MS * 4);
    expect(onLoadEarlier).not.toHaveBeenCalled();
  });

  it("after the prepend the marked turn stays marked and wheeling up continues into the new rows", () => {
    const { chain, onLoadEarlier, update, prepend } = setup();
    wheelOn(chain, -100);
    tick(SCRUB_TOP_LOAD_DWELL_MS);
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
    update({ loadingEarlier: true });
    prepend();
    expect(rowOf("t1")).toHaveClass("scrub");
    expect(document.querySelectorAll(".scrub")).toHaveLength(1);
    // The marked turn is no longer the top row: no second load.
    tick(SCRUB_TOP_LOAD_DWELL_MS * 4);
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
    // One row up is the last step of the newest earlier turn.
    wheelOn(chain, -28);
    tick(16);
    expect(rowOf("p2-b1")).toHaveClass("scrub");
  });

  it("wheeling back to the new top row loads the next page after another dwell", () => {
    const { chain, onLoadEarlier, update, prepend } = setup();
    wheelOn(chain, -100);
    tick(SCRUB_TOP_LOAD_DWELL_MS);
    update({ loadingEarlier: true });
    prepend();
    wheelOn(chain, -28 * 10);
    tick(16);
    expect(rowOf("p1")).toHaveClass("scrub");
    tick(SCRUB_TOP_LOAD_DWELL_MS);
    expect(onLoadEarlier).toHaveBeenCalledTimes(2);
  });

  it("a drag into the hatched cap or onto the top row loads after the dwell", async () => {
    const { chain, onLoadEarlier } = setup();
    press(chain, 300);
    move(chain, 4);
    tick(16);
    expect(rowOf("t1")).toHaveClass("scrub");
    tick(SCRUB_TOP_LOAD_DWELL_MS - 1);
    expect(onLoadEarlier).not.toHaveBeenCalled();
    tick(1);
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(chain, { pointerId: 1, pointerType: "mouse", clientY: 4 });
    await flushSettle();

    press(chain, 300);
    tick(SCRUB_TOP_LOAD_DWELL_MS * 2);
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
    move(chain, 20);
    tick(16);
    tick(SCRUB_TOP_LOAD_DWELL_MS);
    expect(onLoadEarlier).toHaveBeenCalledTimes(2);
  });

  it("a drag held still in the cap keeps the held turn and chains a capped number of loads; a move re-arms", () => {
    const { chain, onLoadEarlier, update, prepend } = setup();
    press(chain, 300);
    move(chain, 4);
    tick(16);
    for (let n = 1; n <= SCRUB_TOP_LOADS_PER_REST; n++) {
      tick(SCRUB_TOP_LOAD_DWELL_MS);
      expect(onLoadEarlier).toHaveBeenCalledTimes(n);
      update({ loadingEarlier: true });
      prepend();
      // No pointer move: the target stays on the held turn.
      expect(rowOf("t1")).toHaveClass("scrub");
    }
    tick(SCRUB_TOP_LOAD_DWELL_MS * 4);
    expect(onLoadEarlier).toHaveBeenCalledTimes(SCRUB_TOP_LOADS_PER_REST);
    move(chain, 3);
    tick(16);
    tick(SCRUB_TOP_LOAD_DWELL_MS);
    expect(onLoadEarlier).toHaveBeenCalledTimes(SCRUB_TOP_LOADS_PER_REST + 1);
  });

  it("releasing a held drag after a prepend jumps to the highlighted turn, not the new top row", () => {
    const { chain, onJump, update, prepend } = setup();
    press(chain, 300);
    move(chain, 4);
    tick(16);
    tick(SCRUB_TOP_LOAD_DWELL_MS);
    update({ loadingEarlier: true });
    prepend();
    fireEvent.pointerUp(chain, { pointerId: 1, pointerType: "mouse", clientY: 4 });
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith("u:t1");
  });

  it("a jittery tap on the top row loads nothing", () => {
    const { chain, onLoadEarlier } = setup();
    press(chain, 20);
    move(chain, 22);
    tick(16);
    tick(SCRUB_TOP_LOAD_DWELL_MS * 4);
    expect(onLoadEarlier).not.toHaveBeenCalled();
  });

  it("a load that settles with nothing new is not retried while the scrub rests; the auto-jump still fires", async () => {
    const { chain, onLoadEarlier, onJump, update } = setup();
    wheelOn(chain, -100);
    tick(SCRUB_TOP_LOAD_DWELL_MS);
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
    update({ loadingEarlier: true });
    update({ loadingEarlier: false });
    await flushSettle();
    tick(SCRUB_TOP_LOAD_DWELL_MS * 8);
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith("u:t1");
    // New input at the top is a new rest: it may try again (past the momentum guard of the closed list).
    tick(WHEEL_CHAT_GUARD_MS);
    wheelOn(chain, -100);
    tick(16);
    tick(SCRUB_TOP_LOAD_DWELL_MS);
    expect(onLoadEarlier).toHaveBeenCalledTimes(2);
  });

  it("with a filter showing none of the prepended turns, one wheel rest chains a capped number of loads", () => {
    // The filter box appears past 100 turns.
    const { chain, onLoadEarlier, update, prepend } = setup({}, makeChat(120, 0));
    wheelOn(chain, 100);
    fireEvent.change(screen.getByRole("textbox", { name: "Filter turns" }), { target: { value: "Turn 1" } });
    // The prepended "Earlier ..." turns never match: the first listed row stays the top after each prepend.
    wheelOn(chain, -28 * 200);
    tick(16);
    expect(rowOf("t1")).toHaveClass("scrub");
    for (let n = 1; n <= SCRUB_TOP_LOADS_PER_REST; n++) {
      tick(SCRUB_TOP_LOAD_DWELL_MS);
      expect(onLoadEarlier).toHaveBeenCalledTimes(n);
      update({ loadingEarlier: true });
      prepend();
    }
    tick(SCRUB_TOP_LOAD_DWELL_MS * 4);
    expect(onLoadEarlier).toHaveBeenCalledTimes(SCRUB_TOP_LOADS_PER_REST);
  });

  it("a press that never moves loads nothing", () => {
    const { chain, onLoadEarlier } = setup();
    press(chain, 20);
    tick(SCRUB_TOP_LOAD_DWELL_MS * 4);
    expect(onLoadEarlier).not.toHaveBeenCalled();
  });

  it("the wheel's auto-jump waits while earlier turns load and fires on the scrub row after", () => {
    const { chain, onJump, update, prepend } = setup();
    wheelOn(chain, -100);
    tick(SCRUB_TOP_LOAD_DWELL_MS);
    update({ loadingEarlier: true });
    tick(WHEEL_JUMP_IDLE_MS * 2);
    expect(onJump).not.toHaveBeenCalled();
    prepend();
    tick(WHEEL_JUMP_IDLE_MS - 1);
    expect(onJump).not.toHaveBeenCalled();
    tick(1);
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith("u:t1");
  });

  it("unmounting clears a pending dwell", () => {
    const { chain, onLoadEarlier, unmount } = setup();
    wheelOn(chain, -100);
    unmount();
    tick(SCRUB_TOP_LOAD_DWELL_MS * 4);
    expect(onLoadEarlier).not.toHaveBeenCalled();
  });
});
