import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { TrackMarks } from "./TrackMarks";
import { Minimap } from "./Minimap";

const TRACK_H = 500;

function sizeTrack(el: HTMLElement) {
  Object.defineProperty(el, "clientHeight", { value: TRACK_H, configurable: true });
  el.getBoundingClientRect = () =>
    ({ top: 0, bottom: TRACK_H, height: TRACK_H, left: 0, right: 56, width: 56, x: 0, y: 0, toJSON: () => {} }) as DOMRect;
}

/** Renders `ui()`, sizes its track (500px) and re-renders so the thumb is laid out. */
function renderSized(ui: () => ReactElement, trackSelector: string) {
  const utils = render(ui());
  const track = utils.container.querySelector(trackSelector) as HTMLElement;
  sizeTrack(track);
  utils.rerender(ui());
  return { ...utils, track };
}

function withCapture(el: HTMLElement): HTMLElement {
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  return el;
}

describe("track drag (marks track and minimap container)", () => {
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

  // Lines 41–60 of 100 on a 500px track: the thumb spans 200–300px.
  const range = { first: 41, last: 60 };

  const cases = [
    {
      name: "marks track",
      ui: (onJump: (l: number) => void, onDragEnd?: () => void) => (
        <TrackMarks lineCount={100} marks={[]} visibleRange={range} onJump={onJump} onDragEnd={onDragEnd} />
      ),
      track: ".scrollmap-track-container",
      thumb: ".scrollmap-thumb",
    },
    {
      name: "minimap container",
      ui: (onJump: (l: number) => void, onDragEnd?: () => void) => (
        <Minimap code="x" lineCount={100} marks={[]} visibleRange={range} onJump={onJump} onDragEnd={onDragEnd} />
      ),
      track: ".scrollmap-minimap-container",
      thumb: ".scrollmap-minimap-frame",
    },
  ];

  describe.each(cases)("$name", (c) => {
    it("band grab keeps its offset and does not jump on press", () => {
      const onJump = vi.fn();
      const { container, track } = renderSized(() => c.ui(onJump), c.track);
      withCapture(track);
      const thumb = container.querySelector(c.thumb) as HTMLElement;
      expect(thumb.style.top).toBe("200px");

      // Grab the thumb 50px below its top (y=250 in 200..300 range): no jump on press
      fireEvent.pointerDown(track, { clientY: 250, pointerId: 1 });
      expect(onJump).not.toHaveBeenCalled();
      expect(track.setPointerCapture).toHaveBeenCalledWith(1);

      // Move 10px down: top goes to 210px → line 43
      fireEvent.pointerMove(track, { clientY: 260, pointerId: 1 });
      expect(onJump).toHaveBeenLastCalledWith(43);

      fireEvent.pointerMove(track, { clientY: 250, pointerId: 1 });
      expect(onJump).toHaveBeenLastCalledWith(41);

      fireEvent.pointerUp(track, { clientY: 250, pointerId: 1 });
      expect(track.releasePointerCapture).toHaveBeenCalledWith(1);
    });

    it("pointerdown on empty area calls onJump once with the centred line and starts a drag", () => {
      const onJump = vi.fn();
      const { track } = renderSized(() => c.ui(onJump), c.track);
      withCapture(track);

      // y=100 is outside 200..300: candidate is line 21, centered with 20 visible lines gives line 11
      fireEvent.pointerDown(track, { clientY: 100, pointerId: 1 });
      expect(onJump).toHaveBeenCalledTimes(1);
      expect(onJump).toHaveBeenCalledWith(11);
      expect(track.setPointerCapture).toHaveBeenCalledWith(1);

      // Two pointermoves scroll
      fireEvent.pointerMove(track, { clientY: 350, pointerId: 1 });
      expect(onJump).toHaveBeenLastCalledWith(61);

      fireEvent.pointerMove(track, { clientY: 120, pointerId: 1 });
      expect(onJump).toHaveBeenLastCalledWith(15);

      // Pointerup ends it
      fireEvent.pointerUp(track, { pointerId: 1 });
      expect(track.releasePointerCapture).toHaveBeenCalledWith(1);

      // A later move does nothing
      onJump.mockClear();
      fireEvent.pointerMove(track, { clientY: 350, pointerId: 1 });
      expect(onJump).not.toHaveBeenCalled();
    });

    it("a move beyond the track's bottom yields the last valid top line", () => {
      const onJump = vi.fn();
      const { track } = renderSized(() => c.ui(onJump), c.track);
      withCapture(track);

      fireEvent.pointerDown(track, { clientY: 100, pointerId: 1 });
      fireEvent.pointerMove(track, { clientY: 600, pointerId: 1 });
      // 100 lines - 20 visible lines + 1 = 81
      expect(onJump).toHaveBeenLastCalledWith(81);
    });

    it("a second pointer neither restarts nor drives the drag", () => {
      const onJump = vi.fn();
      const { track } = renderSized(() => c.ui(onJump), c.track);
      withCapture(track);

      fireEvent.pointerDown(track, { clientY: 100, pointerId: 1 });
      expect(onJump).toHaveBeenCalledTimes(1);

      fireEvent.pointerDown(track, { clientY: 400, pointerId: 2 });
      fireEvent.pointerMove(track, { clientY: 450, pointerId: 2 });
      fireEvent.pointerUp(track, { clientY: 450, pointerId: 2 });
      expect(onJump).toHaveBeenCalledTimes(1);

      fireEvent.pointerMove(track, { clientY: 350, pointerId: 1 });
      expect(onJump).toHaveBeenLastCalledWith(61);
    });

    it("pressing again with the same pointer after a missed release restarts the drag", () => {
      const onJump = vi.fn();
      const onDragEnd = vi.fn();
      const { track } = renderSized(() => c.ui(onJump, onDragEnd), c.track);
      withCapture(track);

      fireEvent.pointerDown(track, { clientY: 100, pointerId: 1 });
      // No up, cancel or lost-capture ever arrives (capture failed, released off the track).
      fireEvent.pointerDown(track, { clientY: 350, pointerId: 1 });
      expect(onDragEnd).toHaveBeenCalledTimes(1);
      expect(onJump).toHaveBeenLastCalledWith(61);

      fireEvent.pointerMove(track, { clientY: 450, pointerId: 1 });
      expect(onJump).toHaveBeenLastCalledWith(81);
    });

    it("lost pointer capture ends the drag", () => {
      const onJump = vi.fn();
      const onDragEnd = vi.fn();
      const { track } = renderSized(() => c.ui(onJump, onDragEnd), c.track);
      withCapture(track);

      fireEvent.pointerDown(track, { clientY: 100, pointerId: 1 });
      fireEvent.lostPointerCapture(track, { pointerId: 1 });
      expect(onDragEnd).toHaveBeenCalledTimes(1);

      onJump.mockClear();
      fireEvent.pointerMove(track, { clientY: 350, pointerId: 1 });
      expect(onJump).not.toHaveBeenCalled();
    });

    it("unmounting mid-drag ends the drag", () => {
      const onDragEnd = vi.fn();
      const { track, unmount } = renderSized(() => c.ui(vi.fn(), onDragEnd), c.track);
      withCapture(track);

      fireEvent.pointerDown(track, { clientY: 100, pointerId: 1 });
      expect(onDragEnd).not.toHaveBeenCalled();
      unmount();
      expect(onDragEnd).toHaveBeenCalledTimes(1);
    });

    it("moves under the drag slop from the press point do not jump", () => {
      const onJump = vi.fn();
      const { track } = renderSized(() => c.ui(onJump), c.track);
      withCapture(track);

      fireEvent.pointerDown(track, { clientY: 100, pointerId: 1 });
      expect(onJump).toHaveBeenCalledTimes(1);
      fireEvent.pointerMove(track, { clientY: 101, pointerId: 1 });
      fireEvent.pointerMove(track, { clientY: 98, pointerId: 1 });
      expect(onJump).toHaveBeenCalledTimes(1);

      fireEvent.pointerMove(track, { clientY: 350, pointerId: 1 });
      expect(onJump).toHaveBeenLastCalledWith(61);
    });

    it("pointerType: 'touch' behaves the same", () => {
      const onJump = vi.fn();
      const { track } = renderSized(() => c.ui(onJump), c.track);
      withCapture(track);

      fireEvent.pointerDown(track, { clientY: 100, pointerType: "touch", pointerId: 1 });
      expect(onJump).toHaveBeenCalledWith(11);

      fireEvent.pointerMove(track, { clientY: 350, pointerType: "touch", pointerId: 1 });
      expect(onJump).toHaveBeenLastCalledWith(61);

      fireEvent.pointerUp(track, { pointerType: "touch", pointerId: 1 });
    });

    it("pointerdown + pointerup + click produces exactly ONE onJump", () => {
      const onJump = vi.fn();
      const { track } = renderSized(() => c.ui(onJump), c.track);
      withCapture(track);

      fireEvent.pointerDown(track, { clientY: 100, pointerId: 1 });
      fireEvent.pointerUp(track, { clientY: 100, pointerId: 1 });
      fireEvent.click(track, { clientY: 100 });
      expect(onJump).toHaveBeenCalledTimes(1);
      expect(onJump).toHaveBeenCalledWith(11);
    });

    it("button: 2 is ignored", () => {
      const onJump = vi.fn();
      const { track } = renderSized(() => c.ui(onJump), c.track);
      withCapture(track);

      fireEvent.pointerDown(track, { clientY: 100, pointerType: "mouse", button: 2, pointerId: 1 });
      expect(onJump).not.toHaveBeenCalled();

      fireEvent.pointerMove(track, { clientY: 150, pointerId: 1 });
      expect(onJump).not.toHaveBeenCalled();
    });

    it("pointercancel ends an empty-area drag", () => {
      const onJump = vi.fn();
      const { track } = renderSized(() => c.ui(onJump), c.track);
      withCapture(track);

      fireEvent.pointerDown(track, { clientY: 100, pointerId: 1 });
      onJump.mockClear();

      fireEvent.pointerCancel(track, { pointerId: 1 });
      fireEvent.pointerMove(track, { clientY: 350, pointerId: 1 });
      expect(onJump).not.toHaveBeenCalled();
    });

    describe("coalesced moves with queued animation frames", () => {
      let frames: Array<FrameRequestCallback | null>;
      const flush = () => {
        const current = [...frames];
        frames.length = 0;
        for (const cb of current) {
          if (cb) cb(0);
        }
      };

      beforeEach(() => {
        frames = [];
        vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
          frames.push(cb);
          return frames.length;
        });
        vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
          if (id > 0 && id <= frames.length) {
            frames[id - 1] = null;
          }
        });
      });

      it("empty-area drag applies pending move on pointerup", () => {
        const onJump = vi.fn();
        const { track } = renderSized(() => c.ui(onJump), c.track);
        withCapture(track);

        fireEvent.pointerDown(track, { clientY: 100, pointerId: 1 });
        expect(onJump).toHaveBeenCalledTimes(1);
        expect(onJump).toHaveBeenCalledWith(11);

        fireEvent.pointerMove(track, { clientY: 350, pointerId: 1 });
        expect(onJump).toHaveBeenCalledTimes(1);

        fireEvent.pointerUp(track, { pointerId: 1 });
        expect(onJump).toHaveBeenCalledTimes(2);
        expect(onJump).toHaveBeenLastCalledWith(61);

        flush();
        expect(onJump).toHaveBeenCalledTimes(2);
      });

      it("three moves in one frame apply exactly the last pending move on pointerup", () => {
        const onJump = vi.fn();
        const { track } = renderSized(() => c.ui(onJump), c.track);
        withCapture(track);

        fireEvent.pointerDown(track, { clientY: 100, pointerId: 1 });
        fireEvent.pointerMove(track, { clientY: 200, pointerId: 1 });
        fireEvent.pointerMove(track, { clientY: 300, pointerId: 1 });
        fireEvent.pointerMove(track, { clientY: 350, pointerId: 1 });
        fireEvent.pointerUp(track, { pointerId: 1 });

        expect(onJump).toHaveBeenCalledTimes(2);
        expect(onJump).toHaveBeenNthCalledWith(1, 11);
        expect(onJump).toHaveBeenNthCalledWith(2, 61);
      });

      it("band grab applies pending move on pointerup", () => {
        const onJump = vi.fn();
        const { track } = renderSized(() => c.ui(onJump), c.track);
        withCapture(track);

        fireEvent.pointerDown(track, { clientY: 250, pointerId: 1 });
        expect(onJump).not.toHaveBeenCalled();

        fireEvent.pointerMove(track, { clientY: 260, pointerId: 1 });
        expect(onJump).not.toHaveBeenCalled();

        fireEvent.pointerUp(track, { pointerId: 1 });
        expect(onJump).toHaveBeenCalledTimes(1);
        expect(onJump).toHaveBeenLastCalledWith(43);
      });

      it("pointerCancel with a pending move applies it once as well", () => {
        const onJump = vi.fn();
        const { track } = renderSized(() => c.ui(onJump), c.track);
        withCapture(track);

        fireEvent.pointerDown(track, { clientY: 100, pointerId: 1 });
        expect(onJump).toHaveBeenCalledTimes(1);

        fireEvent.pointerMove(track, { clientY: 350, pointerId: 1 });
        expect(onJump).toHaveBeenCalledTimes(1);

        fireEvent.pointerCancel(track, { pointerId: 1 });
        expect(onJump).toHaveBeenCalledTimes(2);
        expect(onJump).toHaveBeenLastCalledWith(61);
      });
    });
  });
});
