import { useRef } from "react";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Virtualizer } from "@tanstack/react-virtual";
import {
  JUMP_FLASH_ATTR,
  JUMP_FLASH_FADE_MS,
  JUMP_FLASH_MS,
  createJumpFlash,
} from "./jumpFlash";
import { useMessageNav, type MessageNav } from "./messageNav";
import type { RenderItem } from "./MessageList";

function setReducedMotion(reduce: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: reduce && query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("jumpFlash", () => {
  it("lights the row, fades it after 2s, and removes it once the fade ends", () => {
    setReducedMotion(false);
    const el = document.createElement("div");
    const f = createJumpFlash();
    f.flash(el);
    expect(el.getAttribute(JUMP_FLASH_ATTR)).toBe("on");
    vi.advanceTimersByTime(JUMP_FLASH_MS - 1);
    expect(el.getAttribute(JUMP_FLASH_ATTR)).toBe("on");
    vi.advanceTimersByTime(1);
    expect(el.getAttribute(JUMP_FLASH_ATTR)).toBe("out");
    vi.advanceTimersByTime(JUMP_FLASH_FADE_MS);
    expect(el.hasAttribute(JUMP_FLASH_ATTR)).toBe(false);
  });

  it("under reduced motion the tint is removed at 2s with no fade step", () => {
    setReducedMotion(true);
    const el = document.createElement("div");
    const f = createJumpFlash();
    f.flash(el);
    vi.advanceTimersByTime(JUMP_FLASH_MS);
    expect(el.hasAttribute(JUMP_FLASH_ATTR)).toBe(false);
  });

  it("a newer jump ends the running flash at once and restarts the timer", () => {
    setReducedMotion(false);
    const a = document.createElement("div");
    const b = document.createElement("div");
    const f = createJumpFlash();
    f.flash(a);
    vi.advanceTimersByTime(1500);
    f.flash(b);
    expect(a.hasAttribute(JUMP_FLASH_ATTR)).toBe(false);
    vi.advanceTimersByTime(1500);
    expect(b.getAttribute(JUMP_FLASH_ATTR)).toBe("on");
    f.clear();
    expect(b.hasAttribute(JUMP_FLASH_ATTR)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("nav.flashAnchor tints the row holding the anchor and unmount clears it", () => {
    setReducedMotion(false);
    const items: RenderItem[] = [{ type: "assistant", id: "a1", text: "x" }];
    const navOut: { current: MessageNav | null } = { current: null };
    function Harness() {
      const listRef = useRef<HTMLDivElement>(null);
      navOut.current = useMessageNav({
        items,
        seqIndex: new Map(),
        virtualizer: {} as Virtualizer<HTMLElement, Element>,
        virtualized: false,
        listRef,
      });
      return (
        <div>
          <div ref={listRef}>
            <div data-row-index={0} data-find-anchor="t:x t:y">row</div>
          </div>
        </div>
      );
    }
    const { container, unmount } = render(<Harness />);
    const row = container.querySelector("[data-find-anchor]")!;
    navOut.current!.flashAnchor("t:y");
    expect(row.getAttribute(JUMP_FLASH_ATTR)).toBe("on");
    unmount();
    expect(row.hasAttribute(JUMP_FLASH_ATTR)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
