import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NormalizedEvent } from "@/api/types";
import { MessageList } from "./MessageList";
import { OUTLINE_LOAD_EARLIER_LIMIT, OUTLINE_TRIM_HOLD_MS } from "./useChatOutline";

function userEvent(turnId: string, text: string): NormalizedEvent {
  return {
    id: `${turnId}-orig`,
    sessionId: "s1",
    ts: new Date().toISOString(),
    provider: "claude",
    kind: "user",
    role: "user",
    text,
    turnId,
  };
}

function stubMetrics(container: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(container, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(container, "clientHeight", { value: clientHeight, configurable: true });
}

/** Virtualizer geometry for jsdom (no layout): a 500px viewport over a tall list. */
function stubScroller(container: HTMLElement) {
  container.getBoundingClientRect = () =>
    ({ top: 0, left: 0, right: 800, bottom: 500, width: 800, height: 500, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  Object.defineProperty(container, "clientHeight", { value: 500, configurable: true });
  Object.defineProperty(container, "offsetHeight", { value: 500, configurable: true });
  Object.defineProperty(container, "offsetTop", { value: 0, configurable: true });
  Object.defineProperty(container, "scrollHeight", { value: 200000, configurable: true });
}

function replies(count: number, start: number): NormalizedEvent[] {
  return Array.from({ length: count }, (_, k) => ({
    id: `a${start + k}`,
    sessionId: "s1",
    ts: "",
    provider: "claude",
    kind: "text",
    role: "assistant",
    text: `reply ${start + k}`,
    turnId: `r${start + k}`,
  }));
}

/** Tap the chain (a sticky list) and click its "Load earlier turns" row. */
function loadFromOutline() {
  const chain = screen.getByRole("button", { name: /^Conversation outline/ });
  fireEvent.pointerDown(chain, { pointerId: 1, pointerType: "mouse", button: 0, clientY: 100 });
  fireEvent.pointerUp(chain, { pointerId: 1, pointerType: "mouse", clientY: 100 });
  fireEvent.click(screen.getByRole("button", { name: "Load earlier turns" }));
}

const recent = [userEvent("t3", "third"), userEvent("t4", "fourth"), userEvent("t5", "fifth")];

describe("MessageList: earlier turns loaded from the outline", () => {
  it("go through the list's guarded load with the outline's page size and keep the chat's read position", () => {
    const overlayHost = document.createElement("div");
    document.body.appendChild(overlayHost);
    const onLoadEarlier = vi.fn();
    const props = { pending: [], hasMore: true, onLoadEarlier, overlayHost };
    const { container, rerender } = render(<MessageList events={recent} {...props} />);
    stubMetrics(container, 1000, 300);
    container.scrollTop = 500;

    // A tap pins the outline open; its "Load earlier turns" row asks for a large page.
    const chain = screen.getByRole("button", { name: /^Conversation outline/ });
    fireEvent.pointerDown(chain, { pointerId: 1, pointerType: "mouse", button: 0, clientY: 100 });
    fireEvent.pointerUp(chain, { pointerId: 1, pointerType: "mouse", clientY: 100 });
    fireEvent.click(screen.getByRole("button", { name: "Load earlier turns" }));
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
    expect(onLoadEarlier).toHaveBeenCalledWith(OUTLINE_LOAD_EARLIER_LIMIT);

    // The list's own near-top trigger is guarded by the same in-flight load.
    container.scrollTop = 0;
    fireEvent.scroll(container);
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);

    rerender(<MessageList events={recent} {...props} loadingEarlier />);
    container.scrollTop = 500;
    // 600px of earlier turns land above: the read position moves down by exactly that.
    stubMetrics(container, 1600, 300);
    rerender(
      <MessageList events={[userEvent("t1", "first"), userEvent("t2", "second"), ...recent]} {...props} />,
    );
    expect(container.scrollTop).toBe(1100);
    overlayHost.remove();
  });

  it("the chat's own near-top load keeps the default page size", () => {
    const onLoadEarlier = vi.fn();
    const { container } = render(<MessageList events={recent} pending={[]} hasMore onLoadEarlier={onLoadEarlier} />);
    stubMetrics(container, 1000, 300);
    container.scrollTop = 0;
    fireEvent.scroll(container);
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
    expect(onLoadEarlier).toHaveBeenCalledWith(undefined);
  });

  it("a virtualized list restores by the key anchor captured when the outline starts the load", async () => {
    let resolveLoad: (() => void) | undefined;
    const onLoadEarlier = vi.fn(() => new Promise<void>((res) => (resolveLoad = res)));
    const overlayHost = document.createElement("div");
    const mountDiv = document.createElement("div");
    document.body.append(overlayHost, mountDiv);
    stubScroller(mountDiv);
    try {
      const before = [...recent, ...replies(500, 0)];
      const props = { pending: [], hasMore: true, onLoadEarlier, overlayHost };
      const { rerender } = render(<MessageList events={before} {...props} />, { container: mountDiv });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      // Reading mid-list; no scroll happens between this and the outline's load.
      mountDiv.scrollTop = 5000;
      fireEvent.scroll(mountDiv);
      loadFromOutline();
      expect(onLoadEarlier).toHaveBeenCalledTimes(1);
      rerender(<MessageList events={before} {...props} loadingEarlier />);
      // A page prepended AND a live event appended in one commit: scrollHeight
      // does not change, so only the key anchor can move the view down.
      rerender(<MessageList events={[...replies(600, 5000), ...before, ...replies(1, 9000)]} {...props} />);
      resolveLoad?.();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(mountDiv.scrollTop).toBeGreaterThan(5000 + 1000);
    } finally {
      mountDiv.remove();
      overlayHost.remove();
    }
  });

  it("holds live trimming while the outline is open and for a while after it loads earlier turns", () => {
    vi.useFakeTimers();
    const overlayHost = document.createElement("div");
    document.body.appendChild(overlayHost);
    try {
      const onOutlineHoldTrim = vi.fn();
      render(
        <MessageList
          events={recent}
          pending={[]}
          hasMore
          onLoadEarlier={vi.fn()}
          overlayHost={overlayHost}
          onOutlineHoldTrim={onOutlineHoldTrim}
        />,
      );
      const esc = () => fireEvent.keyDown(document, { key: "Escape" });
      const chain = screen.getByRole("button", { name: /^Conversation outline/ });
      fireEvent.pointerDown(chain, { pointerId: 1, pointerType: "mouse", button: 0, clientY: 100 });
      fireEvent.pointerUp(chain, { pointerId: 1, pointerType: "mouse", clientY: 100 });
      expect(onOutlineHoldTrim).toHaveBeenLastCalledWith(true);
      esc();
      expect(onOutlineHoldTrim).toHaveBeenLastCalledWith(false);

      loadFromOutline();
      esc();
      expect(screen.queryByRole("dialog")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(OUTLINE_TRIM_HOLD_MS - 1);
      });
      expect(onOutlineHoldTrim).toHaveBeenLastCalledWith(true);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(onOutlineHoldTrim).toHaveBeenLastCalledWith(false);
    } finally {
      overlayHost.remove();
      vi.useRealTimers();
    }
  });
});
