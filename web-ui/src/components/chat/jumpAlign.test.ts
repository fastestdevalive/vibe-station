import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { centeredScrollTop, keepRowCentered, JUMP_SETTLE_MS, JUMP_TOP_GAP } from "./jumpAlign";

describe("centeredScrollTop", () => {
  const list = { viewport: 600, scrollHeight: 10_000 };

  it("puts a row that fits in the middle of the viewport", () => {
    // Row centre 5050, viewport centre = top + 300.
    expect(centeredScrollTop({ ...list, rowTop: 5000, rowHeight: 100 })).toBe(4750);
  });

  it("top-aligns a row taller than the viewport, with a small gap", () => {
    expect(centeredScrollTop({ ...list, rowTop: 5000, rowHeight: 900 })).toBe(5000 - JUMP_TOP_GAP);
    // Exactly viewport-tall counts as not fitting.
    expect(centeredScrollTop({ ...list, rowTop: 5000, rowHeight: 600 })).toBe(5000 - JUMP_TOP_GAP);
  });

  it("clamps at the start of the list", () => {
    expect(centeredScrollTop({ ...list, rowTop: 40, rowHeight: 100 })).toBe(0);
    expect(centeredScrollTop({ ...list, rowTop: 0, rowHeight: 900 })).toBe(0);
  });

  it("clamps at the end of the list", () => {
    expect(centeredScrollTop({ ...list, rowTop: 9850, rowHeight: 100 })).toBe(9400);
  });

  it("is 0 when the whole list is shorter than the viewport", () => {
    expect(centeredScrollTop({ viewport: 600, scrollHeight: 400, rowTop: 300, rowHeight: 80 })).toBe(0);
  });

  it("centres in what an overlay at the top leaves visible", () => {
    // 100px covered: visible 500, row centre sits at 100 + 250.
    expect(centeredScrollTop({ ...list, rowTop: 5000, rowHeight: 100, topInset: 100 })).toBe(4700);
    expect(centeredScrollTop({ ...list, rowTop: 5000, rowHeight: 900, topInset: 100 })).toBe(4900 - JUMP_TOP_GAP);
  });
});

describe("keepRowCentered", () => {
  let scroller: HTMLElement;
  let row: HTMLElement;
  let rowHeight: number;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    scroller = document.createElement("div");
    row = document.createElement("div");
    scroller.appendChild(row);
    document.body.appendChild(scroller);
    rowHeight = 100;
    Object.defineProperty(scroller, "clientHeight", { value: 600 });
    Object.defineProperty(scroller, "scrollHeight", { value: 10_000 });
    scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    // The row sits at content offset 5000, wherever the scroller is.
    row.getBoundingClientRect = () => ({ top: 5000 - scroller.scrollTop, height: rowHeight }) as DOMRect;
  });
  afterEach(() => {
    vi.useRealTimers();
    scroller.remove();
  });

  const setTop = vi.fn((top: number) => {
    scroller.scrollTop = top;
  });
  beforeEach(() => setTop.mockClear());

  it("centres at once and again when the row's height changes", () => {
    keepRowCentered(scroller, () => row, setTop);
    expect(scroller.scrollTop).toBe(4750);
    vi.advanceTimersToNextFrame();
    expect(setTop).toHaveBeenCalledTimes(1);

    rowHeight = 300; // a collapsed tool run opened, markdown laid out
    vi.advanceTimersToNextFrame();
    expect(scroller.scrollTop).toBe(4850);
  });

  it("stops at the user's first scroll input", () => {
    keepRowCentered(scroller, () => row, setTop);
    scroller.dispatchEvent(new Event("wheel"));
    scroller.scrollTop = 1000;
    rowHeight = 300;
    vi.advanceTimersByTime(200);
    expect(scroller.scrollTop).toBe(1000);
  });

  it("stops after the settle window and when cancelled", () => {
    keepRowCentered(scroller, () => row, setTop);
    vi.advanceTimersByTime(JUMP_SETTLE_MS + 50);
    rowHeight = 300;
    vi.advanceTimersByTime(200);
    expect(scroller.scrollTop).toBe(4750);

    const cancel = keepRowCentered(scroller, () => row, setTop);
    expect(scroller.scrollTop).toBe(4850);
    cancel();
    rowHeight = 100;
    vi.advanceTimersByTime(200);
    expect(scroller.scrollTop).toBe(4850);
  });

  it("waits for a row that is not mounted yet", () => {
    let mounted: HTMLElement | null = null;
    keepRowCentered(scroller, () => mounted, setTop);
    expect(setTop).not.toHaveBeenCalled();
    mounted = row;
    vi.advanceTimersToNextFrame();
    expect(scroller.scrollTop).toBe(4750);
  });
});
