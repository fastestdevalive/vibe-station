import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useKeepFieldAboveBar } from "./useKeepFieldAboveBar";

function Harness() {
  const rootRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const keep = useKeepFieldAboveBar(rootRef, fieldRef);
  return (
    <div data-testid="scroller" style={{ overflowY: "auto" }}>
      <div ref={rootRef}>
        <div ref={fieldRef} data-testid="field" onFocus={keep}>
          <input aria-label="msg" />
        </div>
        <div className="comment-picker__bar" data-testid="bar" />
      </div>
    </div>
  );
}

const rect = (top: number, h: number): DOMRect =>
  ({ top, bottom: top + h, left: 0, right: 100, width: 100, height: h, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

describe("useKeepFieldAboveBar (V-01, V-04)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("after the visual viewport shrinks, a phone-width-agnostic touch device scrolls the field above the bar using the POST-resize geometry", () => {
    // Touch device, any width: the hook must not depend on the 768px breakpoint.
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("any-pointer: coarse"),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const listeners: Record<string, () => void> = {};
    const vv = { height: 800, offsetTop: 0, addEventListener: (t: string, f: () => void) => (listeners[t] = f), removeEventListener: () => {} };
    vi.stubGlobal("visualViewport", vv);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => frames.push(cb));
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const id = this.getAttribute("data-testid");
      if (id === "scroller") return rect(0, 300);
      if (id === "field") return rect(516, 102); // bottom 618, far below the keyboard-shrunk viewport
      if (id === "bar") return rect(312, 65);
      return rect(0, 0);
    });
    const { getByTestId, getByLabelText } = render(<Harness />);
    const scroller = getByTestId("scroller");
    scroller.scrollTop = 0;
    getByLabelText("msg").focus();
    vv.height = 378; // keyboard
    act(() => listeners.resize!());
    // Nothing runs synchronously on the event (the container has not re-fitted yet): two animation frames later it does.
    expect(scroller.scrollTop).toBe(0);
    act(() => frames.splice(0).forEach((f) => f(0)));
    act(() => frames.splice(0).forEach((f) => f(0)));
    // limit = min(bar top 312, vv bottom 378) - 8 = 304; field bottom 618; room above the field = 516 - 0
    expect(scroller.scrollTop).toBe(618 - 304);
  });
});
