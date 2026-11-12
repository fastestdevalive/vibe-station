import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedEvent } from "@/api/types";
import { MessageList } from "./MessageList";
import { NEAR_BOTTOM_LOAD_PX } from "./useLoadLater";

function userEvent(n: number): NormalizedEvent {
  return {
    id: `u${n}`,
    sessionId: "s1",
    ts: "",
    provider: "claude",
    kind: "user",
    role: "user",
    text: `turn ${n}`,
    turnId: `t${n}`,
    logSeq: n,
  };
}
const turns = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => userEvent(from + i));

/** A scroller `height` tall showing `scrollHeight` of content, `fromBottom` px above its end. */
function place(container: HTMLElement, fromBottom: number, scrollHeight = 3000, height = 500) {
  Object.defineProperty(container, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(container, "clientHeight", { value: height, configurable: true });
  container.scrollTop = scrollHeight - height - fromBottom;
}

/** A load the test settles by hand. */
function deferredLoads() {
  const settlers: Array<{ resolve: (moved: boolean) => void; reject: (e: Error) => void }> = [];
  const onLoadLater = vi.fn(
    () => new Promise<boolean>((resolve, reject) => settlers.push({ resolve, reject })),
  );
  return { onLoadLater, settlers };
}
const flush = () => act(async () => {});

/** Mount a detached window scrolled well above its bottom, past the one check a fresh window gets. */
async function renderDetached(events: NormalizedEvent[], onLoadLater: () => Promise<boolean>) {
  const view = render(<MessageList events={events} pending={[]} detached onLoadLater={onLoadLater} />);
  place(view.container, 2000);
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  expect(onLoadLater).not.toHaveBeenCalled();
  return view;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MessageList: newer pages of a detached window", () => {
  it("loads the next page on scrolling near the bottom, one load in flight", async () => {
    const { onLoadLater, settlers } = deferredLoads();
    const { container } = await renderDetached(turns(1, 5), onLoadLater);

    place(container, NEAR_BOTTOM_LOAD_PX + 50);
    fireEvent.scroll(container);
    await flush();
    expect(onLoadLater).not.toHaveBeenCalled();

    place(container, NEAR_BOTTOM_LOAD_PX - 50);
    fireEvent.scroll(container);
    fireEvent.scroll(container);
    fireEvent.wheel(container, { deltaY: 120 });
    await flush();
    expect(onLoadLater).toHaveBeenCalledTimes(1);

    // The page landed and the reader is no longer near the bottom: nothing chains.
    place(container, 2000, 5000);
    await act(async () => settlers[0]!.resolve(true));
    expect(onLoadLater).toHaveBeenCalledTimes(1);

    place(container, 10, 5000);
    fireEvent.scroll(container);
    await flush();
    expect(onLoadLater).toHaveBeenCalledTimes(2);
  });

  it("chains into the next page while the reader is still near the bottom after a page lands", async () => {
    const { onLoadLater, settlers } = deferredLoads();
    const { container } = await renderDetached(turns(1, 5), onLoadLater);
    place(container, 0);
    fireEvent.scroll(container);
    await flush();
    await act(async () => settlers[0]!.resolve(true));
    await flush();
    expect(onLoadLater).toHaveBeenCalledTimes(2);
  });

  it("a load that fails or finds nothing newer does not retry by itself", async () => {
    const { onLoadLater, settlers } = deferredLoads();
    const { container } = await renderDetached(turns(1, 5), onLoadLater);
    place(container, 0);
    fireEvent.scroll(container);
    await flush();
    await act(async () => settlers[0]!.reject(new Error("network")));
    await flush();
    expect(onLoadLater).toHaveBeenCalledTimes(1);

    // The reader pushing against the bottom (no scroll happens there) asks again.
    fireEvent.wheel(container, { deltaY: -120 });
    await flush();
    expect(onLoadLater).toHaveBeenCalledTimes(1);
    fireEvent.wheel(container, { deltaY: 120 });
    await flush();
    expect(onLoadLater).toHaveBeenCalledTimes(2);
    await act(async () => settlers[1]!.resolve(false));
    await flush();
    expect(onLoadLater).toHaveBeenCalledTimes(2);
  });

  it("never loads forward on the live window", async () => {
    const { onLoadLater } = deferredLoads();
    const { container } = render(<MessageList events={turns(1, 5)} pending={[]} onLoadLater={onLoadLater} />);
    place(container, 0);
    fireEvent.scroll(container);
    fireEvent.wheel(container, { deltaY: 120 });
    await flush();
    expect(onLoadLater).not.toHaveBeenCalled();
  });

  it("checks a freshly opened window that cannot be scrolled", async () => {
    vi.useFakeTimers();
    try {
      const { onLoadLater } = deferredLoads();
      const props = { pending: [], onLoadLater };
      const { container, rerender } = render(<MessageList events={turns(1, 5)} {...props} />);
      place(container, 0, 400, 500);
      rerender(<MessageList events={turns(1, 5)} {...props} detached />);
      expect(onLoadLater).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(50);
      });
      await flush();
      expect(onLoadLater).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts the row being read back where it was once the page has rendered", async () => {
    // Row tops relative to the document, by row text; the scroller's own top is 0.
    const tops = new Map<string, number>([["turn 1", -300], ["turn 2", -40], ["turn 3", 220]]);
    const rect = (top: number, height: number) =>
      ({ top, bottom: top + height, left: 0, right: 800, width: 800, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (!(this instanceof HTMLElement) || this.dataset.rowIndex === undefined) return rect(0, 500);
      const label = [...tops.keys()].find((k) => this.textContent?.includes(k));
      return rect(label ? tops.get(label)! : 5000, 260);
    });

    const { onLoadLater, settlers } = deferredLoads();
    const props = { pending: [], detached: true, onLoadLater };
    const { container, rerender } = await renderDetached(turns(1, 3), onLoadLater);
    place(container, 100, 3000);
    const startTop = container.scrollTop;
    // "turn 2" is the first row whose bottom edge is inside the viewport: the anchor.
    fireEvent.scroll(container);
    await flush();
    expect(onLoadLater).toHaveBeenCalledTimes(1);

    // The page renders and the layout above the anchor shifts it 75px down.
    rerender(<MessageList events={turns(1, 9)} {...props} />);
    tops.set("turn 2", 35);
    place(container, 3000, 6000);
    container.scrollTop = startTop;
    await act(async () => settlers[0]!.resolve(true));
    expect(container.scrollTop).toBe(startTop + 75);
  });

  it("the bottom of a detached window is not the live edge, and rejoining the tail does not snap to it", async () => {
    const onAtBottomChange = vi.fn();
    const props = { pending: [], onAtBottomChange };
    const { container, rerender } = render(<MessageList events={turns(1, 5)} {...props} />);
    place(container, 600);
    fireEvent.scroll(container);
    expect(onAtBottomChange).toHaveBeenLastCalledWith(false);
    place(container, 0);
    fireEvent.scroll(container);
    expect(onAtBottomChange).toHaveBeenLastCalledWith(true);

    // Jumping to an older window ends the bottom pin, wherever the scroller sits.
    rerender(<MessageList events={turns(1, 5)} {...props} detached />);
    expect(onAtBottomChange).toHaveBeenLastCalledWith(false);
    onAtBottomChange.mockClear();
    place(container, 0);
    fireEvent.scroll(container);
    expect(onAtBottomChange).not.toHaveBeenCalled();
    const top = container.scrollTop;

    // The last forward page rejoins the live tail: the reader stays on the same rows.
    Object.defineProperty(container, "scrollHeight", { value: 9000, configurable: true });
    rerender(<MessageList events={turns(1, 40)} {...props} />);
    expect(container.scrollTop).toBe(top);
    expect(onAtBottomChange).not.toHaveBeenCalled();

    // Scrolling on to the real end pins the live edge again.
    place(container, 0, 9000);
    fireEvent.scroll(container);
    expect(onAtBottomChange).toHaveBeenLastCalledWith(true);
  });

  it("the explicit Return to latest message lands at the bottom of the rejoined tail", async () => {
    const onAtBottomChange = vi.fn();
    const onReturnToLatest = vi.fn();
    const props = { pending: [], onAtBottomChange, onReturnToLatest };
    const { container, rerender, getByRole } = render(<MessageList events={turns(1, 5)} {...props} detached />);
    place(container, 600);
    fireEvent.click(getByRole("button", { name: "Return to latest message" }));
    expect(onReturnToLatest).toHaveBeenCalledTimes(1);

    // The parent bumps `returnSeq` with the rejoin (ChatPane does it for every entry point).
    Object.defineProperty(container, "scrollHeight", { value: 9000, configurable: true });
    rerender(<MessageList events={turns(1, 40)} {...props} returnSeq={1} />);
    expect(container.scrollTop).toBe(9000);
    expect(onAtBottomChange).toHaveBeenLastCalledWith(true);
  });

  it("a return-to-latest from outside the button (find bar) also lands at the bottom", async () => {
    const props = { pending: [] as never[] };
    const { container, rerender } = render(<MessageList events={turns(1, 5)} {...props} detached />);
    place(container, 600);
    Object.defineProperty(container, "scrollHeight", { value: 9000, configurable: true });
    rerender(<MessageList events={turns(1, 40)} {...props} returnSeq={1} />);
    expect(container.scrollTop).toBe(9000);
  });

  it("with find open the explicit return scrolls but does not pin", async () => {
    const onAtBottomChange = vi.fn();
    const props = { pending: [] as never[], onAtBottomChange, findOpen: true };
    const { container, rerender } = render(<MessageList events={turns(1, 5)} {...props} detached />);
    place(container, 600);
    onAtBottomChange.mockClear();
    Object.defineProperty(container, "scrollHeight", { value: 9000, configurable: true });
    rerender(<MessageList events={turns(1, 40)} {...props} returnSeq={1} />);
    expect(container.scrollTop).toBe(9000);
    expect(onAtBottomChange).not.toHaveBeenCalledWith(true);
  });
});
