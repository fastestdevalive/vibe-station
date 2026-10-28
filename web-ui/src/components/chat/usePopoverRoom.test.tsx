import { render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POPOVER_TINY_ROOM, usePopoverRoom } from "./usePopoverRoom";

function Harness({ active = true, bar = false }: { active?: boolean; bar?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  usePopoverRoom(ref, active);
  return (
    <div data-testid="scroller" style={{ overflowY: "auto" }}>
      <div ref={ref} data-testid="shell" />
      {bar ? <div data-popover-floor /> : null}
    </div>
  );
}

const rect = (top: number, h = 40): DOMRect =>
  ({ top, bottom: top + h, left: 0, right: 200, width: 200, height: h, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

function mockLayout(scrollerTop: number, shellTop: number) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const id = this.getAttribute("data-testid");
    if (id === "scroller") return rect(scrollerTop, 400);
    if (id === "shell") return rect(shellTop);
    return rect(0, 0);
  });
}

describe("usePopoverRoom (P-03)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("publishes the room above the shell inside its scrolling ancestor, less the gap and edge", () => {
    mockLayout(100, 350);
    const { getByTestId } = render(<Harness />);
    // 350 - 100 - 4 (gap) - 8 (edge)
    expect(getByTestId("shell").style.getPropertyValue("--chat-popover-room")).toBe("238px");
  });

  it("a field with little room above and none below is floored, never zero", () => {
    vi.stubGlobal("innerHeight", 200);
    mockLayout(100, 130);
    const { getByTestId } = render(<Harness />);
    expect(getByTestId("shell").style.getPropertyValue("--chat-popover-room")).toBe(`${POPOVER_TINY_ROOM}px`);
  });

  it("sets nothing while inactive or without layout, and clears on deactivate", () => {
    const { getByTestId, rerender } = render(<Harness active={false} />);
    expect(getByTestId("shell").style.getPropertyValue("--chat-popover-room")).toBe("");
    mockLayout(0, 300);
    rerender(<Harness active />);
    expect(getByTestId("shell").style.getPropertyValue("--chat-popover-room")).not.toBe("");
    rerender(<Harness active={false} />);
    expect(getByTestId("shell").style.getPropertyValue("--chat-popover-room")).toBe("");
  });

  it("opens downward (data-popover-side) when there is no room above but room below, up to a sticky bar", () => {
    vi.stubGlobal("innerHeight", 800);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const id = this.getAttribute("data-testid");
      if (id === "scroller") return rect(100, 600);
      if (id === "shell") return rect(130); // 130-170
      if (this.hasAttribute("data-popover-floor")) return rect(400, 40);
      return rect(0, 0);
    });
    const { getByTestId } = render(<Harness bar />);
    const shell = getByTestId("shell");
    expect(shell.dataset.popoverSide).toBe("below");
    // 400 (bar top) - 170 (shell bottom) - 4 - 8
    expect(shell.style.getPropertyValue("--chat-popover-room")).toBe("218px");
  });

  it("re-measures when the shell grows (ResizeObserver) and coalesces a burst of scrolls into one frame", () => {
    let roCallback: () => void = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          roCallback = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => frames.push(cb));
    let top = 350;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const id = this.getAttribute("data-testid");
      if (id === "scroller") return rect(100, 400);
      if (id === "shell") return rect(top);
      return rect(0, 0);
    });
    const cs = vi.spyOn(window, "getComputedStyle");
    const { getByTestId } = render(<Harness />);
    expect(getByTestId("shell").style.getPropertyValue("--chat-popover-room")).toBe("238px");
    const found = cs.mock.calls.length; // the ancestor walk happens once per activation
    for (let i = 0; i < 10; i++) window.dispatchEvent(new Event("scroll"));
    expect(frames).toHaveLength(1);
    top = 300; // the editor grew upward
    roCallback();
    frames.splice(0).forEach((f) => f(0));
    expect(getByTestId("shell").style.getPropertyValue("--chat-popover-room")).toBe("188px");
    expect(cs.mock.calls.length).toBe(found);
  });
});
