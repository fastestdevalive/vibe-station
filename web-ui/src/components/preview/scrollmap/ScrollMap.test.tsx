import { act, fireEvent, render } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ScrollMap } from "./ScrollMap";
import { __resetFileScrollMapForTests } from "@/hooks/useFileScrollMap";
import * as mobileHook from "@/hooks/useIsMobile";
import * as fileScrollMapHook from "@/hooks/useFileScrollMap";
import type { DiffHunk } from "@/preview/diffParser";
import { scrollToLine } from "./codeLines";

/** Stand-in for the minimap's summary worker (jsdom has no `Worker`). */
class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: { preventDefault: () => void }) => void) | null = null;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage() {}
  terminate() {}
}

/** Sets the scroller's border-box width (what ScrollMap measures) and its clientWidth. */
function setScrollerWidth(el: HTMLElement, width: number) {
  Object.defineProperty(el, "clientWidth", { value: width, configurable: true });
  const height = el.clientHeight;
  el.getBoundingClientRect = () =>
    ({ top: 0, bottom: height, height, left: 0, right: width, width, x: 0, y: 0, toJSON: () => {} }) as DOMRect;
}

function makeScroller(fits = false, clientWidth = 600) {
  const el = document.createElement("div");
  el.className = "preview-body";
  const clientHeight = 500;
  const scrollHeight = fits ? 400 : 2000;
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: clientWidth, configurable: true });
  el.getBoundingClientRect = () =>
    ({
      top: 0,
      bottom: clientHeight,
      height: clientHeight,
      left: 0,
      right: clientWidth,
      width: clientWidth,
      x: 0,
      y: 0,
      toJSON: () => {},
    }) as DOMRect;
  return el;
}

describe("ScrollMap", () => {
  beforeEach(() => {
    __resetFileScrollMapForTests();
    vi.restoreAllMocks();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        cb: (entries: ResizeObserverEntry[]) => void;
        constructor(cb: (entries: ResizeObserverEntry[]) => void) {
          this.cb = cb;
        }
        observe() {
          this.cb([] as never);
        }
        unobserve() {}
        disconnect() {}
      },
    );
  });

  it("fitting content renders nothing", () => {
    const scroller = makeScroller(true); // fits: scrollHeight 400 <= clientHeight 500
    const onDisplayChange = vi.fn();
    const { container } = render(
      <ScrollMap
        scrollEl={scroller}
        mode="code"
        code="some short text"
        lineCount={10}
        onDisplayChange={onDisplayChange}
      />
    );

    expect(container.firstChild).toBeNull();
    expect(onDisplayChange).toHaveBeenCalledWith(expect.objectContaining({ display: "none" }));
  });

  it("setting 'marks' renders the track", () => {
    vi.spyOn(fileScrollMapHook, "useFileScrollMap").mockReturnValue(["marks", vi.fn()]);
    vi.spyOn(mobileHook, "useIsMobile").mockReturnValue(false);

    const scroller = makeScroller(false);
    const onDisplayChange = vi.fn();
    const { container } = render(
      <ScrollMap
        scrollEl={scroller}
        mode="code"
        code="line 1\nline 2"
        lineCount={100}
        onDisplayChange={onDisplayChange}
      />
    );

    expect(container.querySelector(".scrollmap-track-container")).toBeTruthy();
    expect(container.querySelector(".scrollmap-minimap-container")).toBeNull();
    expect(onDisplayChange).toHaveBeenCalledWith(expect.objectContaining({ display: "marks" }));
  });

  it("setting 'minimap' renders the minimap (canvas context null in jsdom must not throw)", () => {
    vi.spyOn(fileScrollMapHook, "useFileScrollMap").mockReturnValue(["minimap", vi.fn()]);
    vi.spyOn(mobileHook, "useIsMobile").mockReturnValue(false);
    vi.stubGlobal("Worker", FakeWorker);

    const scroller = makeScroller(false);
    const onDisplayChange = vi.fn();
    const { container } = render(
      <ScrollMap
        scrollEl={scroller}
        mode="code"
        code="line 1\nline 2"
        lineCount={100}
        onDisplayChange={onDisplayChange}
      />
    );

    expect(container.querySelector(".scrollmap-minimap-container")).toBeTruthy();
    expect(container.querySelector(".scrollmap-track-container")).toBeNull();
    expect(onDisplayChange).toHaveBeenCalledWith(expect.objectContaining({ display: "minimap" }));
  });

  it("a 400px-wide scroller with setting minimap renders the track; widening to 600 swaps to the minimap", () => {
    vi.spyOn(fileScrollMapHook, "useFileScrollMap").mockReturnValue(["minimap", vi.fn()]);
    vi.spyOn(mobileHook, "useIsMobile").mockReturnValue(false);
    vi.stubGlobal("Worker", FakeWorker);

    let resizeCb: (() => void) | null = null;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          resizeCb = cb;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );

    const scroller = makeScroller(false, 400);
    const onDisplayChange = vi.fn();
    const { container } = render(
      <ScrollMap
        scrollEl={scroller}
        mode="code"
        code="line 1\nline 2"
        lineCount={100}
        onDisplayChange={onDisplayChange}
      />,
    );

    // Narrow pane (400px < 480px) -> falls back to track marks
    expect(container.querySelector(".scrollmap-track-container")).toBeTruthy();
    expect(container.querySelector(".scrollmap-minimap-container")).toBeNull();
    expect(onDisplayChange).toHaveBeenLastCalledWith(expect.objectContaining({ forced: "narrow" }));

    // Widening to 600 swaps to the minimap
    act(() => {
      setScrollerWidth(scroller, 600);
      resizeCb?.();
    });

    expect(container.querySelector(".scrollmap-minimap-container")).toBeTruthy();
    expect(container.querySelector(".scrollmap-track-container")).toBeNull();
    expect(onDisplayChange).toHaveBeenLastCalledWith(expect.objectContaining({ forced: null }));
  });

  it("a pane just over the threshold keeps the minimap although its shown scrollbar shrinks clientWidth", () => {
    vi.spyOn(fileScrollMapHook, "useFileScrollMap").mockReturnValue(["minimap", vi.fn()]);
    vi.spyOn(mobileHook, "useIsMobile").mockReturnValue(false);
    vi.stubGlobal("Worker", FakeWorker);

    let resizeCb: (() => void) | null = null;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          resizeCb = cb;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );

    // 484px border box: the minimap shows the 6px scrollbar (clientWidth 478), marks hide it (484).
    const scroller = makeScroller(false, 484);
    Object.defineProperty(scroller, "clientWidth", {
      configurable: true,
      get: () => (scroller.classList.contains("preview-body--minimap") ? 478 : 484),
    });
    const { container } = render(
      <ScrollMap scrollEl={scroller} mode="code" code="line 1\nline 2" lineCount={100} />,
    );
    expect(container.querySelector(".scrollmap-minimap-container")).toBeTruthy();

    for (let i = 0; i < 3; i++) {
      act(() => resizeCb?.());
      expect(container.querySelector(".scrollmap-minimap-container")).toBeTruthy();
      expect(container.querySelector(".scrollmap-track-container")).toBeNull();
    }
  });

  it("minimap falls back to marks when there is no Worker", () => {
    vi.spyOn(fileScrollMapHook, "useFileScrollMap").mockReturnValue(["minimap", vi.fn()]);
    vi.spyOn(mobileHook, "useIsMobile").mockReturnValue(false);
    vi.stubGlobal("Worker", undefined);

    const { container } = render(
      <ScrollMap scrollEl={makeScroller(false)} mode="code" code={"line 1\nline 2"} lineCount={100} />,
    );

    expect(container.querySelector(".scrollmap-track-container")).toBeTruthy();
    expect(container.querySelector(".scrollmap-minimap-container")).toBeNull();
  });

  it("minimap falls back to marks when its worker errors", () => {
    vi.spyOn(fileScrollMapHook, "useFileScrollMap").mockReturnValue(["minimap", vi.fn()]);
    vi.spyOn(mobileHook, "useIsMobile").mockReturnValue(false);
    vi.stubGlobal("Worker", FakeWorker);

    const scroller = makeScroller(false);
    const { container, rerender } = render(
      <ScrollMap scrollEl={scroller} mode="code" code={"line 1\nline 2"} lineCount={100} />,
    );
    expect(container.querySelector(".scrollmap-minimap-container")).toBeTruthy();

    const preventDefault = vi.fn();
    act(() => {
      FakeWorker.last!.onerror!({ preventDefault });
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(container.querySelector(".scrollmap-minimap-container")).toBeNull();
    expect(container.querySelector(".scrollmap-track-container")).toBeTruthy();

    // Another file gets the minimap again.
    rerender(<ScrollMap scrollEl={scroller} mode="code" code={"other 1\nother 2"} lineCount={100} />);
    expect(container.querySelector(".scrollmap-minimap-container")).toBeTruthy();
  });

  it("coalesces scroll measurements to one per animation frame", () => {
    vi.spyOn(fileScrollMapHook, "useFileScrollMap").mockReturnValue(["marks", vi.fn()]);
    vi.spyOn(mobileHook, "useIsMobile").mockReturnValue(false);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });

    const scroller = makeScroller(false);
    render(<ScrollMap scrollEl={scroller} mode="code" code={"line 1\nline 2"} lineCount={100} />);
    const querySpy = vi.spyOn(scroller, "querySelectorAll");

    for (let i = 0; i < 5; i++) fireEvent.scroll(scroller);
    expect(frames).toHaveLength(1);
    expect(querySpy).not.toHaveBeenCalled();

    act(() => frames[0]!(0));
    expect(querySpy).toHaveBeenCalled();
  });

  it("mobile renders the read-only track", () => {
    vi.spyOn(fileScrollMapHook, "useFileScrollMap").mockReturnValue(["minimap", vi.fn()]);
    vi.spyOn(mobileHook, "useIsMobile").mockReturnValue(true);

    const scroller = makeScroller(false);
    const { container } = render(
      <ScrollMap
        scrollEl={scroller}
        mode="code"
        code="line 1\nline 2"
        lineCount={100}
      />
    );

    const trackContainer = container.querySelector(".scrollmap-track-container");
    expect(trackContainer).toBeTruthy();
    expect(trackContainer?.getAttribute("data-readonly")).toBe("true");
    expect(container.querySelector(".scrollmap-minimap-container")).toBeNull();
  });

  it("over the cap renders the track and publishes overCap", () => {
    vi.spyOn(fileScrollMapHook, "useFileScrollMap").mockReturnValue(["minimap", vi.fn()]);
    vi.spyOn(mobileHook, "useIsMobile").mockReturnValue(false);

    const scroller = makeScroller(false);
    const onDisplayChange = vi.fn();
    const { container } = render(
      <ScrollMap
        scrollEl={scroller}
        mode="code"
        code="line"
        lineCount={1_000_005} // Over 1,000,000 lines
        onDisplayChange={onDisplayChange}
      />
    );

    expect(container.querySelector(".scrollmap-track-container")).toBeTruthy();
    expect(container.querySelector(".scrollmap-minimap-container")).toBeNull();
    expect(onDisplayChange).toHaveBeenCalledWith(expect.objectContaining({ display: "marks", forced: "overCap" }));
  });

  it("for a 300-line (non-virtualized) file, clicking a mark changes the scroller's scrollTop", () => {
    vi.spyOn(fileScrollMapHook, "useFileScrollMap").mockReturnValue(["marks", vi.fn()]);
    vi.spyOn(mobileHook, "useIsMobile").mockReturnValue(false);

    const scroller = makeScroller(false);
    scroller.scrollTop = 0;

    // Populate rows in scroller for 300 lines
    for (let i = 1; i <= 300; i++) {
      const row = document.createElement("div");
      row.className = "workspace-code-line";
      row.setAttribute("data-line", String(i));
      // Each row 20px high
      const top = (i - 1) * 20;
      row.getBoundingClientRect = () =>
        ({
          top: top - scroller.scrollTop,
          bottom: top + 20 - scroller.scrollTop,
          height: 20,
          left: 0,
          right: 500,
          width: 500,
          x: 0,
          y: top - scroller.scrollTop,
          toJSON: () => {},
        }) as DOMRect;
      scroller.appendChild(row);
    }

    const onJump = (line: number) => {
      scrollToLine(scroller, null, line);
    };

    const { container, rerender } = render(
      <ScrollMap
        scrollEl={scroller}
        mode="code"
        code={Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n")}
        lineCount={300}
        gutter={new Map([[100, new Set(["added"])]])}
        onJump={onJump}
      />
    );

    const trackContainer = container.querySelector(".scrollmap-track-container") as HTMLElement;
    expect(trackContainer).toBeTruthy();

    Object.defineProperty(trackContainer, "clientHeight", { value: 600, configurable: true });
    trackContainer.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 600,
        height: 600,
        left: 0,
        right: 12,
        width: 12,
        x: 0,
        y: 0,
        toJSON: () => {},
      }) as DOMRect;

    rerender(
      <ScrollMap
        scrollEl={scroller}
        mode="code"
        code={Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n")}
        lineCount={300}
        gutter={new Map([[100, new Set(["added"])]])}
        onJump={onJump}
      />
    );

    // Line 100 on 600px track is ((100-1)/300)*600 = 198px.
    // Pressing centers line 100 in the 25-line viewport: centeredTopLine(100, 25, 300) = 88.
    // Top of line 88 is (88 - 1) * 20 = 1740px.
    fireEvent.pointerDown(trackContainer, { clientY: 200 });

    expect(scroller.scrollTop).toBeGreaterThan(0);
    expect(scroller.scrollTop).toBe(1740);
  });

  it("diff mode: renders track marks, computes visible range from data-diff-row, and manages --tracked class", () => {
    vi.spyOn(fileScrollMapHook, "useFileScrollMap").mockReturnValue(["marks", vi.fn()]);
    vi.spyOn(mobileHook, "useIsMobile").mockReturnValue(false);

    const scroller = makeScroller(false);
    for (let i = 1; i <= 50; i++) {
      const row = document.createElement("div");
      row.className = "diff-line";
      // Diff rows carry the flattened row index (`data-diff-row`); `data-line`
      // is the new-file line number and is a different scale entirely.
      row.setAttribute("data-diff-row", String(i));
      row.setAttribute("data-line", String(i + 799));
      const top = (i - 1) * 20;
      row.getBoundingClientRect = () =>
        ({
          top: top - scroller.scrollTop,
          bottom: top + 20 - scroller.scrollTop,
          height: 20,
          left: 0,
          right: 500,
          width: 500,
          x: 0,
          y: top - scroller.scrollTop,
          toJSON: () => {},
        }) as DOMRect;
      scroller.appendChild(row);
    }

    const diffHunks: DiffHunk[] = [
      {
        header: "@@ -1,25 +1,25 @@",
        lines: Array.from({ length: 25 }, (_, i) => ({
          type: "added" as const,
          content: `added ${i + 1}`,
          oldLineNumber: null,
          newLineNumber: i + 1,
        })),
      },
      {
        header: "@@ -26,25 +26,25 @@",
        lines: Array.from({ length: 25 }, (_, i) => ({
          type: "removed" as const,
          content: `removed ${i + 26}`,
          oldLineNumber: i + 26,
          newLineNumber: null,
        })),
      },
    ];

    const onJump = vi.fn();

    const { container, rerender } = render(
      <ScrollMap
        scrollEl={scroller}
        mode="diff"
        lineCount={50}
        diffHunks={diffHunks}
        onJump={onJump}
      />
    );

    const track = container.querySelector(".scrollmap-track-container") as HTMLElement;
    expect(track).toBeTruthy();
    expect(container.querySelector(".scrollmap-minimap-container")).toBeNull();

    Object.defineProperty(track, "clientHeight", { value: 500, configurable: true });
    track.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 500,
        height: 500,
        left: 0,
        right: 12,
        width: 12,
        x: 0,
        y: 0,
        toJSON: () => {},
      }) as DOMRect;

    rerender(
      <ScrollMap
        scrollEl={scroller}
        mode="diff"
        lineCount={50}
        diffHunks={diffHunks}
        onJump={onJump}
      />
    );

    expect(container.querySelector(".scrollmap-thumb")).toBeTruthy();
    // Rows 1..25 are visible in the 500px scroller, on the 50-row scale: the
    // thumb is half the track tall and starts at the top — i.e. it is drawn
    // from row indices, not from the 800..849 file line numbers.
    const thumb = container.querySelector(".scrollmap-thumb") as HTMLElement;
    expect(thumb.style.height).toBe("250px");
    expect(thumb.style.top).toBe("0px");
    expect(scroller.classList.contains("preview-body--tracked")).toBe(true);

    // Empty track press outside the thumb (0..250px) jumps to that row
    fireEvent.pointerDown(track!, { clientY: 350 });
    expect(onJump).toHaveBeenLastCalledWith(24);

    // When mobile (readOnly), preview-body--tracked is NOT added
    vi.spyOn(mobileHook, "useIsMobile").mockReturnValue(true);
    rerender(
      <ScrollMap
        scrollEl={scroller}
        mode="diff"
        lineCount={50}
        diffHunks={diffHunks}
        onJump={onJump}
      />
    );
    expect(scroller.classList.contains("preview-body--tracked")).toBe(false);
  });

  it("a swapped scroller with no rows mounted drops the old scroller's range", () => {
    vi.spyOn(fileScrollMapHook, "useFileScrollMap").mockReturnValue(["marks", vi.fn()]);
    vi.spyOn(mobileHook, "useIsMobile").mockReturnValue(false);

    const first = makeScroller(false);
    for (let i = 1; i <= 50; i++) {
      const row = document.createElement("div");
      row.className = "diff-line";
      row.setAttribute("data-diff-row", String(i));
      const top = (i - 1) * 20;
      row.getBoundingClientRect = () =>
        ({ top, bottom: top + 20, height: 20, left: 0, right: 500, width: 500, x: 0, y: top, toJSON: () => {} }) as DOMRect;
      first.appendChild(row);
    }
    const hunks: DiffHunk[] = [
      {
        header: "@@ -1,50 +1,50 @@",
        lines: Array.from({ length: 50 }, (_, i) => ({
          type: "added" as const,
          content: `added ${i + 1}`,
          oldLineNumber: null,
          newLineNumber: i + 1,
        })),
      },
    ];

    const { rerender } = render(<ScrollMap scrollEl={first} mode="diff" lineCount={50} diffHunks={hunks} />);
    expect(first.classList.contains("preview-body--tracked")).toBe(true);

    const second = makeScroller(false);
    rerender(<ScrollMap scrollEl={second} mode="diff" lineCount={50} diffHunks={hunks} />);
    expect(second.classList.contains("preview-body--tracked")).toBe(false);
  });

  it("minimap: null range after a valid one keeps the band mounted while content still scrolls", async () => {
    vi.spyOn(fileScrollMapHook, "useFileScrollMap").mockReturnValue(["minimap", vi.fn()]);
    vi.spyOn(mobileHook, "useIsMobile").mockReturnValue(false);
    vi.stubGlobal("Worker", FakeWorker);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      Promise.resolve().then(() => cb(0));
      return 1;
    });

    const scroller = makeScroller(false);
    scroller.scrollTop = 0;

    for (let i = 1; i <= 100; i++) {
      const row = document.createElement("div");
      row.className = "workspace-code-line";
      row.setAttribute("data-line", String(i));
      const top = (i - 1) * 20;
      row.getBoundingClientRect = () =>
        ({
          top: top - scroller.scrollTop,
          bottom: top + 20 - scroller.scrollTop,
          height: 20,
          left: 0,
          right: 500,
          width: 500,
          x: 0,
          y: top - scroller.scrollTop,
          toJSON: () => {},
        }) as DOMRect;
      scroller.appendChild(row);
    }

    const { container, rerender } = render(
      <ScrollMap
        scrollEl={scroller}
        mode="code"
        code={Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")}
        lineCount={100}
      />
    );

    const minimapContainer = container.querySelector(".scrollmap-minimap-container") as HTMLElement;
    expect(minimapContainer).toBeTruthy();

    Object.defineProperty(minimapContainer, "clientHeight", { value: 500, configurable: true });
    minimapContainer.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 500,
        height: 500,
        left: 0,
        right: 48,
        width: 48,
        x: 0,
        y: 0,
        toJSON: () => {},
      }) as DOMRect;

    rerender(
      <ScrollMap
        scrollEl={scroller}
        mode="code"
        code={Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")}
        lineCount={100}
      />
    );

    const initialFrame = container.querySelector(".scrollmap-minimap-frame");
    expect(initialFrame).toBeTruthy();

    // Transient state: rows temporarily unmounted after jump/scroll
    scroller.replaceChildren();

    await act(async () => {
      fireEvent.scroll(scroller);
    });

    // Content still scrolls (!contentFits): band remains mounted
    const frameAfterTransient = container.querySelector(".scrollmap-minimap-frame");
    expect(frameAfterTransient).toBe(initialFrame);

    // Clears when file no longer scrolls
    Object.defineProperty(scroller, "scrollHeight", { value: 400, configurable: true });
    await act(async () => {
      fireEvent.scroll(scroller);
    });
    expect(container.querySelector(".scrollmap-minimap-frame")).toBeNull();

    // Clears when lineCount drops to 0
    Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
    rerender(
      <ScrollMap
        scrollEl={scroller}
        mode="code"
        code=""
        lineCount={0}
      />
    );
    expect(container.querySelector(".scrollmap-minimap-frame")).toBeNull();
  });

  it("band is redrawn when scroller rows change without firing scroll (MutationObserver)", async () => {
    vi.spyOn(fileScrollMapHook, "useFileScrollMap").mockReturnValue(["marks", vi.fn()]);
    vi.spyOn(mobileHook, "useIsMobile").mockReturnValue(false);

    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });

    const scroller = makeScroller(false);
    scroller.scrollTop = 0;

    // Initial rows: lines 1..25 visible in 500px viewport (each 20px tall)
    for (let i = 1; i <= 25; i++) {
      const row = document.createElement("div");
      row.className = "workspace-code-line";
      row.setAttribute("data-line", String(i));
      const top = (i - 1) * 20;
      row.getBoundingClientRect = () =>
        ({
          top,
          bottom: top + 20,
          height: 20,
          left: 0,
          right: 500,
          width: 500,
          x: 0,
          y: top,
          toJSON: () => {},
        }) as DOMRect;
      scroller.appendChild(row);
    }

    const { container, rerender } = render(
      <ScrollMap
        scrollEl={scroller}
        mode="code"
        code={Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")}
        lineCount={100}
      />
    );

    const trackContainer = container.querySelector(".scrollmap-track-container") as HTMLElement;
    expect(trackContainer).toBeTruthy();
    Object.defineProperty(trackContainer, "clientHeight", { value: 500, configurable: true });
    trackContainer.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 500,
        height: 500,
        left: 0,
        right: 48,
        width: 48,
        x: 0,
        y: 0,
        toJSON: () => {},
      }) as DOMRect;

    rerender(
      <ScrollMap
        scrollEl={scroller}
        mode="code"
        code={Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")}
        lineCount={100}
      />
    );

    const thumb = container.querySelector(".scrollmap-thumb") as HTMLElement;
    expect(thumb).toBeTruthy();
    expect(thumb.style.top).toBe("0px");

    // Replace rows with rows all above the viewport (top = -500 to -400)
    scroller.replaceChildren();
    for (let i = 1; i <= 5; i++) {
      const row = document.createElement("div");
      row.className = "workspace-code-line";
      row.setAttribute("data-line", String(i));
      const top = -500 + (i - 1) * 20;
      row.getBoundingClientRect = () =>
        ({
          top,
          bottom: top + 20,
          height: 20,
          left: 0,
          right: 500,
          width: 500,
          x: 0,
          y: top,
          toJSON: () => {},
        }) as DOMRect;
      scroller.appendChild(row);
    }

    // Fire scroll: mounted rows are above viewport -> visibleLineRange is null, visibleRange is kept (thumb still at 0px)
    fireEvent.scroll(scroller);
    act(() => {
      while (frames.length > 0) frames.shift()!(0);
    });
    expect(thumb.style.top).toBe("0px");

    // Now replace rows with ones inside the viewport (lines 51..75) WITHOUT firing scroll
    scroller.replaceChildren();
    for (let i = 51; i <= 75; i++) {
      const row = document.createElement("div");
      row.className = "workspace-code-line";
      row.setAttribute("data-line", String(i));
      const top = (i - 51) * 20;
      row.getBoundingClientRect = () =>
        ({
          top,
          bottom: top + 20,
          height: 20,
          left: 0,
          right: 500,
          width: 500,
          x: 0,
          y: top,
          toJSON: () => {},
        }) as DOMRect;
      scroller.appendChild(row);
    }

    // MutationObserver triggers in a microtask
    await act(async () => {
      await Promise.resolve();
    });

    // Run the animation frame scheduled by MutationObserver
    act(() => {
      while (frames.length > 0) frames.shift()!(0);
    });

    // Thumb top reflects the new rows: ((51 - 1) / 100) * 500 = 250px
    expect(thumb.style.top).toBe("250px");
  });

  it("after onJump the rendered band is at the target immediately before any measurement, then measured range replaces it", async () => {
    vi.spyOn(fileScrollMapHook, "useFileScrollMap").mockReturnValue(["marks", vi.fn()]);
    vi.spyOn(mobileHook, "useIsMobile").mockReturnValue(false);

    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });

    const scroller = makeScroller(false);
    scroller.scrollTop = 0;

    // Initial rows: lines 1..25 visible in 500px viewport (each 20px tall)
    for (let i = 1; i <= 25; i++) {
      const row = document.createElement("div");
      row.className = "workspace-code-line";
      row.setAttribute("data-line", String(i));
      const top = (i - 1) * 20;
      row.getBoundingClientRect = () =>
        ({
          top,
          bottom: top + 20,
          height: 20,
          left: 0,
          right: 500,
          width: 500,
          x: 0,
          y: top,
          toJSON: () => {},
        }) as DOMRect;
      scroller.appendChild(row);
    }

    const onJump = vi.fn();
    const { container, rerender } = render(
      <ScrollMap
        scrollEl={scroller}
        mode="code"
        code={Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")}
        lineCount={100}
        onJump={onJump}
      />
    );

    const trackContainer = container.querySelector(".scrollmap-track-container") as HTMLElement;
    expect(trackContainer).toBeTruthy();
    Object.defineProperty(trackContainer, "clientHeight", { value: 500, configurable: true });
    trackContainer.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 500,
        height: 500,
        left: 0,
        right: 48,
        width: 48,
        x: 0,
        y: 0,
        toJSON: () => {},
      }) as DOMRect;

    rerender(
      <ScrollMap
        scrollEl={scroller}
        mode="code"
        code={Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")}
        lineCount={100}
        onJump={onJump}
      />
    );

    const thumb = container.querySelector(".scrollmap-thumb") as HTMLElement;
    expect(thumb).toBeTruthy();
    // Initially at top: lines 1..25 -> ((1 - 1) / 100) * 500 = 0px
    expect(thumb.style.top).toBe("0px");

    // Click track at y=300: candidate line is 61, centered with 25 lines gives target = 49
    // In track coordinates: ((49 - 1) / 100) * 500 = 240px
    fireEvent.pointerDown(trackContainer, { clientY: 300 });
    expect(onJump).toHaveBeenCalledWith(49);

    // Immediately before any measurement (no rAF flushed, no DOM mutations):
    // The rendered band is at the target immediately!
    expect(thumb.style.top).toBe("240px");

    // Now rows 49..73 mount in the viewport
    scroller.replaceChildren();
    for (let i = 49; i <= 73; i++) {
      const row = document.createElement("div");
      row.className = "workspace-code-line";
      row.setAttribute("data-line", String(i));
      const top = (i - 49) * 20;
      row.getBoundingClientRect = () =>
        ({
          top,
          bottom: top + 20,
          height: 20,
          left: 0,
          right: 500,
          width: 500,
          x: 0,
          y: top,
          toJSON: () => {},
        }) as DOMRect;
      scroller.appendChild(row);
    }

    // Flush MutationObserver and rAF
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      while (frames.length > 0) frames.shift()!(0);
    });

    // Measured range matches target (49 == 49), so measured range replaces optimisticRange
    expect(thumb.style.top).toBe("240px");
  });

  it("timeout clears optimisticRange if no matching measurement arrives", async () => {
    vi.useFakeTimers();
    vi.spyOn(fileScrollMapHook, "useFileScrollMap").mockReturnValue(["marks", vi.fn()]);
    vi.spyOn(mobileHook, "useIsMobile").mockReturnValue(false);

    const scroller = makeScroller(false);
    scroller.scrollTop = 0;

    for (let i = 1; i <= 25; i++) {
      const row = document.createElement("div");
      row.className = "workspace-code-line";
      row.setAttribute("data-line", String(i));
      const top = (i - 1) * 20;
      row.getBoundingClientRect = () =>
        ({
          top,
          bottom: top + 20,
          height: 20,
          left: 0,
          right: 500,
          width: 500,
          x: 0,
          y: top,
          toJSON: () => {},
        }) as DOMRect;
      scroller.appendChild(row);
    }

    const onJump = vi.fn();
    const { container, rerender } = render(
      <ScrollMap
        scrollEl={scroller}
        mode="code"
        code={Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")}
        lineCount={100}
        onJump={onJump}
      />
    );

    const trackContainer = container.querySelector(".scrollmap-track-container") as HTMLElement;
    Object.defineProperty(trackContainer, "clientHeight", { value: 500, configurable: true });
    trackContainer.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 500,
        height: 500,
        left: 0,
        right: 48,
        width: 48,
        x: 0,
        y: 0,
        toJSON: () => {},
      }) as DOMRect;

    rerender(
      <ScrollMap
        scrollEl={scroller}
        mode="code"
        code={Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")}
        lineCount={100}
        onJump={onJump}
      />
    );

    const thumb = container.querySelector(".scrollmap-thumb") as HTMLElement;
    expect(thumb.style.top).toBe("0px");

    // Click track at y=300 -> target = 49 (240px)
    fireEvent.pointerDown(trackContainer, { clientY: 300 });
    expect(thumb.style.top).toBe("240px");

    // Advance 1400ms: still within timeout
    act(() => {
      vi.advanceTimersByTime(1400);
    });
    expect(thumb.style.top).toBe("240px");

    // Advance past 1500ms: optimisticRange clears, falls back to measured visibleRange (0px)
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(thumb.style.top).toBe("0px");

    vi.useRealTimers();
  });

  it("real scroll not caused by us clears optimisticRange", async () => {
    vi.useFakeTimers();
    vi.spyOn(fileScrollMapHook, "useFileScrollMap").mockReturnValue(["marks", vi.fn()]);
    vi.spyOn(mobileHook, "useIsMobile").mockReturnValue(false);

    const scroller = makeScroller(false);
    scroller.scrollTop = 0;

    for (let i = 1; i <= 25; i++) {
      const row = document.createElement("div");
      row.className = "workspace-code-line";
      row.setAttribute("data-line", String(i));
      const top = (i - 1) * 20;
      row.getBoundingClientRect = () =>
        ({
          top,
          bottom: top + 20,
          height: 20,
          left: 0,
          right: 500,
          width: 500,
          x: 0,
          y: top,
          toJSON: () => {},
        }) as DOMRect;
      scroller.appendChild(row);
    }

    const onJump = vi.fn();
    const { container, rerender } = render(
      <ScrollMap
        scrollEl={scroller}
        mode="code"
        code={Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")}
        lineCount={100}
        onJump={onJump}
      />
    );

    const trackContainer = container.querySelector(".scrollmap-track-container") as HTMLElement;
    Object.defineProperty(trackContainer, "clientHeight", { value: 500, configurable: true });
    trackContainer.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 500,
        height: 500,
        left: 0,
        right: 48,
        width: 48,
        x: 0,
        y: 0,
        toJSON: () => {},
      }) as DOMRect;

    rerender(
      <ScrollMap
        scrollEl={scroller}
        mode="code"
        code={Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")}
        lineCount={100}
        onJump={onJump}
      />
    );

    const thumb = container.querySelector(".scrollmap-thumb") as HTMLElement;
    expect(thumb.style.top).toBe("0px");

    // Click track at y=300 -> target = 49 (240px)
    fireEvent.pointerDown(trackContainer, { clientY: 300 });
    expect(thumb.style.top).toBe("240px");

    // Release pointer so drag ends
    fireEvent.pointerUp(trackContainer, { clientY: 300 });

    // Advance 250ms past the jump settling window (200ms)
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(thumb.style.top).toBe("240px");

    // Now a scroll event arrives from external/user scrolling (not caused by us)
    fireEvent.scroll(scroller);

    // optimisticRange is cleared immediately
    expect(thumb.style.top).toBe("0px");

    vi.useRealTimers();
  });
});
