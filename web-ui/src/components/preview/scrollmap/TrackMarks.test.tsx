import { fireEvent, render } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TrackMarks } from "./TrackMarks";
import type { Mark } from "./buildMarks";

describe("TrackMarks", () => {
  beforeEach(() => {
    // Stub ResizeObserver for measuring trackHeight
    vi.stubGlobal(
      "ResizeObserver",
      class {
        cb: (entries: ResizeObserverEntry[]) => void;
        constructor(cb: (entries: ResizeObserverEntry[]) => void) {
          this.cb = cb;
        }
        observe() {
          // Trigger measurement callback immediately
          this.cb([] as never);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clicking a mark calls onJump(startLine)", () => {
    const onJump = vi.fn();
    const marks: Mark[] = [
      { kind: "added", startLine: 10, endLine: 15 },
    ];

    const { container, rerender } = render(
      <TrackMarks
        lineCount={100}
        marks={marks}
        visibleRange={null}
        onJump={onJump}
      />
    );

    const trackContainer = container.querySelector(".scrollmap-track-container") as HTMLElement;
    Object.defineProperty(trackContainer, "clientHeight", { value: 500, configurable: true });
    vi.spyOn(trackContainer, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 500,
      height: 500,
      left: 0,
      right: 12,
      width: 12,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    rerender(
      <TrackMarks
        lineCount={100}
        marks={marks}
        visibleRange={null}
        onJump={onJump}
      />
    );

    // Press at y = 46 snaps to mark start line 10
    fireEvent.pointerDown(trackContainer, { clientY: 46 });
    fireEvent.pointerUp(trackContainer, { clientY: 46 });
    expect(onJump).toHaveBeenCalledWith(10);
  });

  it("clicking inside a large mark jumps positionally to line under pointer", () => {
    const onJump = vi.fn();
    const marks: Mark[] = [
      { kind: "added", startLine: 1, endLine: 3000 },
    ];

    const { container, rerender } = render(
      <TrackMarks
        lineCount={3000}
        marks={marks}
        visibleRange={null}
        onJump={onJump}
      />
    );

    const trackContainer = container.querySelector(".scrollmap-track-container") as HTMLElement;
    Object.defineProperty(trackContainer, "clientHeight", { value: 500, configurable: true });
    vi.spyOn(trackContainer, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 500,
      height: 500,
      left: 0,
      right: 12,
      width: 12,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    rerender(
      <TrackMarks
        lineCount={3000}
        marks={marks}
        visibleRange={null}
        onJump={onJump}
      />
    );

    // Press at y = 350: line under pointer is 2101, no visibleRange so no centering
    fireEvent.pointerDown(trackContainer, { clientY: 350 });
    fireEvent.pointerUp(trackContainer, { clientY: 350 });
    expect(onJump).toHaveBeenCalledWith(2101);
  });

  it("clicking a mark inflated to 2px snaps to mark start line", () => {
    const onJump = vi.fn();
    const marks: Mark[] = [
      { kind: "added", startLine: 10, endLine: 10 },
    ];

    const { container, rerender } = render(
      <TrackMarks
        lineCount={10000}
        marks={marks}
        visibleRange={null}
        onJump={onJump}
      />
    );

    const trackContainer = container.querySelector(".scrollmap-track-container") as HTMLElement;
    Object.defineProperty(trackContainer, "clientHeight", { value: 500, configurable: true });
    vi.spyOn(trackContainer, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 500,
      height: 500,
      left: 0,
      right: 12,
      width: 12,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    rerender(
      <TrackMarks
        lineCount={10000}
        marks={marks}
        visibleRange={null}
        onJump={onJump}
      />
    );

    // Mark 10 in 10000 lines on 500px track has top = ((10-1)/10000)*500 = 0.45px, inflated to height 2px ([0, 2]).
    // Click at y = 1. candidate lineAtFraction(1/500, 10000) = line 21, but inside is false, so it snaps to startLine 10.
    fireEvent.pointerDown(trackContainer, { clientY: 1 });
    fireEvent.pointerUp(trackContainer, { clientY: 1 });
    expect(onJump).toHaveBeenCalledWith(10);
  });

  it("with visibleRange 1-40 on a 3000-line file, press at y=350 of 500 -> onJump(2081)", () => {
    const onJump = vi.fn();
    const { container, rerender } = render(
      <TrackMarks
        lineCount={3000}
        marks={[]}
        visibleRange={{ first: 1, last: 40 }}
        onJump={onJump}
      />
    );

    const trackContainer = container.querySelector(".scrollmap-track-container") as HTMLElement;
    Object.defineProperty(trackContainer, "clientHeight", { value: 500, configurable: true });
    vi.spyOn(trackContainer, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 500,
      height: 500,
      left: 0,
      right: 12,
      width: 12,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    rerender(
      <TrackMarks
        lineCount={3000}
        marks={[]}
        visibleRange={{ first: 1, last: 40 }}
        onJump={onJump}
      />
    );

    fireEvent.pointerDown(trackContainer, { clientY: 350 });
    fireEvent.pointerUp(trackContainer, { clientY: 350 });
    // lineAtFraction(350/500, 3000) = 2101, centered with 40 lines (visibleLines/2 = 20): 2101 - 20 = 2081.
    expect(onJump).toHaveBeenCalledWith(2081);
  });

  it("press-on-empty then move produces a second onJump", () => {
    const onJump = vi.fn();
    const { container, rerender } = render(
      <TrackMarks
        lineCount={100}
        marks={[]}
        visibleRange={{ first: 1, last: 20 }}
        onJump={onJump}
      />
    );

    const trackContainer = container.querySelector(".scrollmap-track-container") as HTMLElement;
    Object.defineProperty(trackContainer, "clientHeight", { value: 500, configurable: true });
    vi.spyOn(trackContainer, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 500,
      height: 500,
      left: 0,
      right: 12,
      width: 12,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    rerender(
      <TrackMarks
        lineCount={100}
        marks={[]}
        visibleRange={{ first: 1, last: 20 }}
        onJump={onJump}
      />
    );

    // Empty press at y=250 (thumb spans 0..100)
    fireEvent.pointerDown(trackContainer, { clientY: 250, pointerId: 1 });
    expect(onJump).toHaveBeenCalledTimes(1);

    // Drag move to y=350
    fireEvent.pointerMove(trackContainer, { clientY: 350, pointerId: 1 });
    expect(onJump).toHaveBeenCalledTimes(2);

    fireEvent.pointerUp(trackContainer, { pointerId: 1 });
  });

  it("read-only track ignores the press", () => {
    const onJump = vi.fn();
    const { container, rerender } = render(
      <TrackMarks
        lineCount={100}
        marks={[]}
        visibleRange={{ first: 1, last: 20 }}
        onJump={onJump}
        readOnly={true}
      />
    );

    const trackContainer = container.querySelector(".scrollmap-track-container") as HTMLElement;
    Object.defineProperty(trackContainer, "clientHeight", { value: 500, configurable: true });
    vi.spyOn(trackContainer, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 500,
      height: 500,
      left: 0,
      right: 12,
      width: 12,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    rerender(
      <TrackMarks
        lineCount={100}
        marks={[]}
        visibleRange={{ first: 1, last: 20 }}
        onJump={onJump}
        readOnly={true}
      />
    );

    fireEvent.pointerDown(trackContainer, { clientY: 100 });
    expect(onJump).not.toHaveBeenCalled();
  });

  it("hovering shows the card copy", () => {
    const marks: Mark[] = [
      { kind: "modified", startLine: 20, endLine: 25 },
    ];
    const code = Array.from({ length: 100 }, (_, i) => `code line ${i + 1}`).join("\n");

    const { container, rerender } = render(
      <TrackMarks
        lineCount={100}
        marks={marks}
        visibleRange={{ first: 1, last: 20 }}
        code={code}
      />
    );

    const trackContainer = container.querySelector(".scrollmap-track-container") as HTMLElement;
    Object.defineProperty(trackContainer, "clientHeight", { value: 500, configurable: true });
    vi.spyOn(trackContainer, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 500,
      height: 500,
      left: 0,
      right: 12,
      width: 12,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    rerender(
      <TrackMarks
        lineCount={100}
        marks={marks}
        visibleRange={{ first: 1, last: 20 }}
        code={code}
      />
    );

    // Line 20 on 500px track: top = ((20-1)/100)*500 = 95px, height = (6/100)*500 = 30px -> [95, 125]
    fireEvent.mouseMove(trackContainer, { clientY: 100 });

    const card = container.querySelector(".scrollmap-hover-card");
    expect(card).toBeTruthy();
    expect(card?.textContent).toContain("Modified");
    expect(card?.textContent).toContain("· L20–25 (6 lines)");
    expect(card?.textContent).toContain("code line 20");
    expect(card?.textContent).toContain("Click to jump");
  });

  it("a merged mark lists both kinds", () => {
    // Both lines fall onto the same pixel mark
    const marks: Mark[] = [
      { kind: "modified", startLine: 10, endLine: 12 },
      { kind: "added", startLine: 11, endLine: 13 },
    ];

    const { container, rerender } = render(
      <TrackMarks
        lineCount={100}
        marks={marks}
        visibleRange={{ first: 1, last: 20 }}
      />
    );

    const trackContainer = container.querySelector(".scrollmap-track-container") as HTMLElement;
    Object.defineProperty(trackContainer, "clientHeight", { value: 500, configurable: true });
    vi.spyOn(trackContainer, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 500,
      height: 500,
      left: 0,
      right: 12,
      width: 12,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    rerender(
      <TrackMarks
        lineCount={100}
        marks={marks}
        visibleRange={{ first: 1, last: 20 }}
      />
    );

    // Line 10..13 on 500px track falls around y = 45..65
    fireEvent.mouseMove(trackContainer, { clientY: 50 });

    const card = container.querySelector(".scrollmap-hover-card");
    expect(card).toBeTruthy();
    expect(card?.textContent).toContain("Merged");
    expect(card?.textContent).toContain("modified");
    expect(card?.textContent).toContain("added");
    expect(card?.textContent).toContain("Click: first of them");
  });
});
