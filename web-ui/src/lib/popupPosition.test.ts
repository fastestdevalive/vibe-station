import { afterEach, describe, it, expect } from "vitest";
import { clampPopupPosition, startAlignedPopupPosition, usablePopupHeight } from "./popupPosition";

describe("clampPopupPosition", () => {
  it("opens below the trigger when there is ample space below", () => {
    const trigger = { top: 100, bottom: 128, left: 200, right: 228 };
    const pos = clampPopupPosition(trigger, 160, 120, 1024, 768);
    expect(pos.top).toBe(128 + 6); // 134
    expect(pos.left).toBe(228 - 160); // 68
  });

  it("flips above the trigger when opening below would overflow the bottom edge", () => {
    // Window height: 600. Trigger is near bottom at bottom: 570, top: 542.
    // Popup height: 120. If below: 570 + 6 = 576; 576 + 120 = 696 > 592 (overflow!).
    const trigger = { top: 542, bottom: 570, left: 200, right: 228 };
    const pos = clampPopupPosition(trigger, 160, 120, 1024, 600);
    // Should flip above: 542 - 120 - 6 = 416
    expect(pos.top).toBe(416);
    expect(pos.top + 120).toBeLessThanOrEqual(600 - 8);
    expect(pos.top).toBeGreaterThanOrEqual(8);
  });

  it("clamps to right boundary when trigger is near right edge", () => {
    // Window width: 300. Trigger right: 295. Popup width: 160.
    // 295 - 160 = 135; 135 + 160 = 295 > 292 (300 - 8).
    const trigger = { top: 100, bottom: 128, left: 267, right: 295 };
    const pos = clampPopupPosition(trigger, 160, 120, 300, 600);
    expect(pos.left).toBe(300 - 160 - 8); // 132
    expect(pos.left + 160).toBeLessThanOrEqual(300 - 8);
  });

  it("clamps to left boundary when trigger is near left edge", () => {
    // Window width: 300. Trigger right: 50. Popup width: 160.
    // 50 - 160 = -110 < 8.
    const trigger = { top: 100, bottom: 128, left: 22, right: 50 };
    const pos = clampPopupPosition(trigger, 160, 120, 300, 600);
    expect(pos.left).toBe(8);
  });

  it("clamps to top boundary when window is extremely small", () => {
    // Window height: 100. Trigger top: 40, bottom: 68. Popup height: 120.
    const trigger = { top: 40, bottom: 68, left: 100, right: 128 };
    const pos = clampPopupPosition(trigger, 160, 120, 300, 100);
    expect(pos.top).toBe(8);
  });
});

describe("startAlignedPopupPosition", () => {
  it("opens below a trigger at the top, left edge on the trigger", () => {
    const pos = startAlignedPopupPosition({ top: 0, bottom: 28, left: 100, right: 130 }, 300, 170, 1024, 768);
    expect(pos).toEqual({ top: 32, left: 100 });
  });

  it("opens above a trigger near the bottom", () => {
    const pos = startAlignedPopupPosition({ top: 700, bottom: 728, left: 100, right: 130 }, 300, 170, 1024, 768);
    expect(pos.top).toBe(700 - 170 - 4);
  });

  it("clamps the left edge inside the right side of the viewport", () => {
    const pos = startAlignedPopupPosition({ top: 0, bottom: 28, left: 900, right: 930 }, 300, 170, 1024, 768);
    expect(pos.left).toBe(1024 - 300 - 8);
  });

  it("keeps at least 8px from the left edge", () => {
    const pos = startAlignedPopupPosition({ top: 0, bottom: 28, left: 2, right: 30 }, 300, 170, 1024, 768);
    expect(pos.left).toBeGreaterThanOrEqual(8);
  });
});

describe("startAlignedPopupPosition with a real-DOMRect-like trigger", () => {
  // DOMRect exposes its fields as prototype getters, which `{ ...rect }` drops.
  class GetterRect {
    constructor(private r: { top: number; bottom: number; left: number; right: number }) {}
    get top() { return this.r.top; }
    get bottom() { return this.r.bottom; }
    get left() { return this.r.left; }
    get right() { return this.r.right; }
  }

  it("opens above a trigger near the bottom with a finite top", () => {
    const pos = startAlignedPopupPosition(new GetterRect({ top: 735, bottom: 755, left: 234, right: 300 }), 336, 173, 1400, 813);
    expect(Number.isFinite(pos.top)).toBe(true);
    expect(pos.top).toBe(735 - 173 - 4);
    expect(pos.left).toBe(234);
  });

  it("opens below a trigger near the top", () => {
    const pos = startAlignedPopupPosition(new GetterRect({ top: 20, bottom: 40, left: 100, right: 160 }), 300, 150, 1400, 813);
    expect(pos.top).toBe(44);
    expect(pos.left).toBe(100);
  });
});

describe("usablePopupHeight", () => {
  afterEach(() => {
    document.querySelectorAll(".global-status-bar").forEach((n) => n.remove());
  });
  function bar(top: number, height: number) {
    const el = document.createElement("div");
    el.className = "global-status-bar";
    el.getBoundingClientRect = () => ({ top, height, bottom: top + height }) as DOMRect;
    document.body.appendChild(el);
  }
  it("returns the client height without a status bar", () => {
    expect(usablePopupHeight(document)).toBe(document.documentElement.clientHeight);
  });
  it("returns the bar's top when it has height", () => {
    const full = document.documentElement.clientHeight;
    bar(full - 24 || 500, 24);
    expect(usablePopupHeight(document)).toBe(full - 24 || 500);
  });
  it("ignores a zero-height bar", () => {
    bar(10, 0);
    expect(usablePopupHeight(document)).toBe(document.documentElement.clientHeight);
  });
});
