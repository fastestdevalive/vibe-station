import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { pickDraftQuote } from "@/components/background/draftQuotes";
import { DraftQuoteLine } from "./DraftQuoteLine";

/** A ResizeObserver whose callback the test drives by hand. */
function stubResizeObserver(): { fire: () => void } {
  const callbacks: ResizeObserverCallback[] = [];
  class Stub {
    constructor(cb: ResizeObserverCallback) {
      callbacks.push(cb);
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = Stub as unknown as typeof ResizeObserver;
  restorers.push(() => {
    globalThis.ResizeObserver = original;
  });
  return {
    fire() {
      const cb = callbacks[callbacks.length - 1];
      if (!cb) throw new Error("no ResizeObserver callback registered");
      act(() => {
        cb([], {} as ResizeObserver);
      });
    },
  };
}

/** jsdom has no layout engine: the body's height, the stage's top and its content height are stubbed. */
function stubRoom(
  body: HTMLElement,
  stage: HTMLElement,
  o: { bodyHeight: number; stageTop: number; contentHeight: number; stageHeight?: number },
): void {
  Object.defineProperty(body, "clientHeight", { configurable: true, value: o.bodyHeight });
  Object.defineProperty(stage, "offsetTop", { configurable: true, value: o.stageTop });
  // A stretched stage (phone) is as tall as the body while its content stays short.
  Object.defineProperty(stage, "offsetHeight", {
    configurable: true,
    value: o.stageHeight ?? o.contentHeight,
  });
  const box = stage.querySelector<HTMLElement>(".draft-composer__box")!;
  Object.defineProperty(box, "offsetTop", { configurable: true, value: o.stageTop });
  Object.defineProperty(box, "offsetHeight", { configurable: true, value: o.contentHeight });
}

/** The quote renders as the last child of `.draft-composer__body`, after the stage. */
function renderQuote(draftId = "d1") {
  const utils = render(
    <div className="draft-composer__body">
      <div className="draft-composer__stage-inner">
        <div className="draft-composer__box" />
      </div>
      <DraftQuoteLine draftId={draftId} />
    </div>,
  );
  const body = utils.container.querySelector<HTMLElement>(".draft-composer__body")!;
  const stage = utils.container.querySelector<HTMLElement>(".draft-composer__stage-inner")!;
  return { ...utils, body, stage };
}

const restorers: Array<() => void> = [];

afterEach(() => {
  while (restorers.length > 0) restorers.pop()!();
});

describe("DraftQuoteLine", () => {
  it("same draft id same line", () => {
    const observer = stubResizeObserver();
    const text = pickDraftQuote("d1")!.text;

    const first = renderQuote("d1");
    stubRoom(first.body, first.stage, { bodyHeight: 500, stageTop: 50, contentHeight: 132 });
    observer.fire();
    expect(screen.getByText(text)).toBeInTheDocument();
    first.unmount();

    const second = renderQuote("d1");
    stubRoom(second.body, second.stage, { bodyHeight: 500, stageTop: 50, contentHeight: 132 });
    observer.fire();
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("hidden when little room, back when it grows", () => {
    const observer = stubResizeObserver();
    const { container, body, stage } = renderQuote("d1");
    const text = pickDraftQuote("d1")!.text;

    // 500 - (50 + 132) - 18 = 300px of room: the line is drawn.
    stubRoom(body, stage, { bodyHeight: 500, stageTop: 50, contentHeight: 132 });
    observer.fire();
    expect(screen.getByText(text)).toBeInTheDocument();

    // 500 - (50 + 402) - 18 = 30px: crowded, the text is dropped.
    stubRoom(body, stage, { bodyHeight: 500, stageTop: 50, contentHeight: 402 });
    observer.fire();
    expect(screen.queryByText(text)).toBeNull();
    // The wrapper stays mounted: it is what measures the body it sits in.
    expect(container.querySelector(".draft-quote-line")).not.toBeNull();

    // The pane grows again: the line comes back.
    stubRoom(body, stage, { bodyHeight: 600, stageTop: 50, contentHeight: 132 });
    observer.fire();
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("shown when the body fills the pane and the stage is short (phone stretch, R3F-05)", () => {
    const observer = stubResizeObserver();
    const { body, stage } = renderQuote("d1");
    const text = pickDraftQuote("d1")!.text;

    // Phone: the body fills the pane (599px), the stage box is STRETCHED to it
    // (551px) while its content ends at 267px, so there is real room below the
    // composer. Measuring the stretched box gave 6px and hid the line.
    stubRoom(body, stage, {
      bodyHeight: 599,
      stageTop: 24,
      contentHeight: 267,
      stageHeight: 551,
    });
    observer.fire();
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});
