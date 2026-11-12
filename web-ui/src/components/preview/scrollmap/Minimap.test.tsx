import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Minimap } from "./Minimap";

const TRACK_H = 500;

function sizeTrack(el: HTMLElement) {
  Object.defineProperty(el, "clientHeight", { value: TRACK_H, configurable: true });
  el.getBoundingClientRect = () =>
    ({ top: 0, bottom: TRACK_H, height: TRACK_H, left: 0, right: 56, width: 56, x: 0, y: 0, toJSON: () => {} }) as DOMRect;
}

function withCapture(el: HTMLElement): HTMLElement {
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  return el;
}

describe("Minimap", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        cb: () => void;
        constructor(cb: () => void) {
          this.cb = cb;
        }
        observe() {
          this.cb();
        }
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("Worker", undefined);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("1,000 lines, 500px track, visible range 1-50: pointerdown at y=300 -> onJump(576); move to y=400 -> onJump(776); container has no click side effect", () => {
    const onJump = vi.fn();
    const { container, rerender } = render(
      <Minimap
        code="test"
        lineCount={1000}
        marks={[]}
        visibleRange={{ first: 1, last: 50 }}
        onJump={onJump}
      />
    );

    const track = container.querySelector(".scrollmap-minimap-container") as HTMLElement;
    expect(track).toBeTruthy();
    sizeTrack(track);
    withCapture(track);

    rerender(
      <Minimap
        code="test"
        lineCount={1000}
        marks={[]}
        visibleRange={{ first: 1, last: 50 }}
        onJump={onJump}
      />
    );

    // Frame spans lines 1–50: frameTop = 0px, frameHeight = (50 / 1000) * 500 = 25px
    // Press at y=300: empty area -> centre drag -> lineAtFraction(300 / 500, 1000) = 601,
    // centeredTopLine(601, 50, 1000) = 601 - 25 = 576.
    fireEvent.pointerDown(track, { clientY: 300, pointerId: 1 });
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith(576);

    // Move to y=400 -> lineAtFraction(400 / 500, 1000) = 801,
    // centeredTopLine(801, 50, 1000) = 801 - 25 = 776.
    fireEvent.pointerMove(track, { clientY: 400, pointerId: 1 });
    expect(onJump).toHaveBeenCalledTimes(2);
    expect(onJump).toHaveBeenLastCalledWith(776);

    // End drag with pointerUp
    fireEvent.pointerUp(track, { clientY: 400, pointerId: 1 });

    // The container has no click handler side effect
    onJump.mockClear();
    fireEvent.click(track, { clientY: 400 });
    expect(onJump).not.toHaveBeenCalled();
  });
});
