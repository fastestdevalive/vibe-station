import { describe, it, expect } from "vitest";
import { clampPopupPosition } from "./popupPosition";

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
