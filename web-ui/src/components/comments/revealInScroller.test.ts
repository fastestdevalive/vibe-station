import { describe, expect, it } from "vitest";
import { revealInScroller } from "./revealInScroller";

const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} }) as DOMRect;
function setup(elTop: number, elH: number, scrollTop = 100) {
  const scroller = document.createElement("div");
  const el = document.createElement("div");
  let st = scrollTop;
  Object.defineProperty(scroller, "scrollTop", { get: () => st, set: (v: number) => (st = v) });
  Object.defineProperty(scroller, "clientHeight", { value: 500 });
  scroller.getBoundingClientRect = () => rect(50, 500);
  el.getBoundingClientRect = () => rect(elTop, elH);
  return { run: () => revealInScroller(el, scroller), st: () => st };
}

describe("revealInScroller", () => {
  it("does nothing when the element fits", () => {
    const t = setup(60, 480);
    expect(t.run()).toBe(0);
    expect(t.st()).toBe(100);
  });
  it("scrolls down by the overflow plus margin", () => {
    const t = setup(400, 200); // bottom 600 vs visible bottom 550
    expect(t.run()).toBe(58);
    expect(t.st()).toBe(158);
  });
  it("keeps the top visible for a box taller than the viewport", () => {
    const t = setup(300, 900);
    expect(t.run()).toBe(300 - 50 - 8);
  });
  it("scrolls up when the element starts above the visible area", () => {
    const t = setup(20, 100);
    expect(t.run()).toBe(-38);
    expect(t.st()).toBe(62);
  });
  it("ignores an element with no box (mobile sheet portals its content away)", () => {
    expect(setup(900, 0).run()).toBe(0);
  });
});
