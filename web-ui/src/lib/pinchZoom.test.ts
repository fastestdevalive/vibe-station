import { describe, it, expect, vi } from "vitest";
import { attachPinchZoom } from "./pinchZoom";

function makeTouch(clientX: number, clientY: number): Touch {
  return { clientX, clientY } as Touch;
}

function touchEvent(type: string, touches: Touch[]): TouchEvent {
  const e = new Event(type, { cancelable: true }) as unknown as TouchEvent;
  Object.defineProperty(e, "touches", { value: touches, configurable: true });
  return e;
}

function wheelEvent(deltaY: number, ctrlKey: boolean): WheelEvent {
  return new WheelEvent("wheel", { deltaY, ctrlKey, cancelable: true });
}

describe("attachPinchZoom", () => {
  it("ignores a plain (non-ctrl) wheel event — normal scrolling is untouched", () => {
    const el = document.createElement("div");
    const onDelta = vi.fn();
    attachPinchZoom(el, onDelta);

    const e = wheelEvent(-100, false);
    el.dispatchEvent(e);

    expect(onDelta).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("treats a ctrl+wheel event as trackpad pinch: prevents default and reports a signed delta", () => {
    const el = document.createElement("div");
    const onDelta = vi.fn();
    attachPinchZoom(el, onDelta);

    const zoomIn = wheelEvent(-100, true); // negative deltaY == pinch out == zoom in
    el.dispatchEvent(zoomIn);
    expect(zoomIn.defaultPrevented).toBe(true);
    expect(onDelta).toHaveBeenCalledTimes(1);
    expect(onDelta).toHaveBeenCalledWith(expect.any(Number));
    expect(onDelta.mock.calls[0]?.[0]).toBeGreaterThan(0);

    onDelta.mockClear();
    const zoomOut = wheelEvent(100, true);
    el.dispatchEvent(zoomOut);
    expect(onDelta.mock.calls[0]?.[0]).toBeLessThan(0);
  });

  it("two-finger touch spreading apart reports a positive delta; a single finger reports nothing", () => {
    const el = document.createElement("div");
    const onDelta = vi.fn();
    attachPinchZoom(el, onDelta);

    el.dispatchEvent(touchEvent("touchstart", [makeTouch(0, 0), makeTouch(10, 0)]));
    // Single-finger move must never zoom.
    el.dispatchEvent(touchEvent("touchmove", [makeTouch(0, 0)]));
    expect(onDelta).not.toHaveBeenCalled();

    // Re-establish two fingers, then spread them apart.
    el.dispatchEvent(touchEvent("touchstart", [makeTouch(0, 0), makeTouch(10, 0)]));
    const move = touchEvent("touchmove", [makeTouch(0, 0), makeTouch(60, 0)]);
    el.dispatchEvent(move);

    expect(move.defaultPrevented).toBe(true);
    expect(onDelta).toHaveBeenCalledTimes(1);
    expect(onDelta.mock.calls[0]?.[0]).toBeGreaterThan(0);
  });

  it("two-finger touch pinching together reports a negative delta", () => {
    const el = document.createElement("div");
    const onDelta = vi.fn();
    attachPinchZoom(el, onDelta);

    el.dispatchEvent(touchEvent("touchstart", [makeTouch(0, 0), makeTouch(100, 0)]));
    el.dispatchEvent(touchEvent("touchmove", [makeTouch(20, 0), makeTouch(80, 0)]));

    expect(onDelta).toHaveBeenCalledTimes(1);
    expect(onDelta.mock.calls[0]?.[0]).toBeLessThan(0);
  });

  it("touchend resets tracking so the next two-finger touchmove needs a fresh touchstart baseline", () => {
    const el = document.createElement("div");
    const onDelta = vi.fn();
    attachPinchZoom(el, onDelta);

    el.dispatchEvent(touchEvent("touchstart", [makeTouch(0, 0), makeTouch(10, 0)]));
    el.dispatchEvent(touchEvent("touchend", []));
    // No prior baseline for this move (touchend cleared it) — first move
    // after a fresh two-finger contact only records a baseline, no delta yet.
    el.dispatchEvent(touchEvent("touchmove", [makeTouch(0, 0), makeTouch(50, 0)]));
    expect(onDelta).not.toHaveBeenCalled();
  });

  it("cleanup removes all listeners", () => {
    const el = document.createElement("div");
    const onDelta = vi.fn();
    const cleanup = attachPinchZoom(el, onDelta);
    cleanup();

    el.dispatchEvent(wheelEvent(-100, true));
    el.dispatchEvent(touchEvent("touchstart", [makeTouch(0, 0), makeTouch(10, 0)]));
    el.dispatchEvent(touchEvent("touchmove", [makeTouch(0, 0), makeTouch(60, 0)]));

    expect(onDelta).not.toHaveBeenCalled();
  });
});
