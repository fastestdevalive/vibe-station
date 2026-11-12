import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedEvent, TranscriptOutlineTurn } from "@/api/types";
import type { OutlineSummaryState } from "@/hooks/useTranscriptOutline";
import type { OutlineWindows } from "@/hooks/useOutlineWindows";
import { MessageList } from "./MessageList";
import type { OutlineSource } from "./outline/outlineSource";
import { BEAT_DWELL_MS } from "./outline/useBeatWindows";

function userEvent(turnId: string, text: string, logSeq: number): NormalizedEvent {
  return {
    id: `${turnId}-orig`,
    sessionId: "s1",
    ts: new Date().toISOString(),
    provider: "claude",
    kind: "user",
    role: "user",
    text,
    turnId,
    logSeq,
  };
}

/** Forty turns: turn i (1-based) starts at seq i * 10. */
const FORTY_TURNS: TranscriptOutlineTurn[] = Array.from({ length: 40 }, (_, k) => {
  const i = k + 1;
  return { seq: i * 10, turnKey: `t${i}`, label: `prompt ${i}`, counts: { tools: 0, edits: 0, errors: 0 } };
});

/** The chat window holds the last three turns only (indexes 37..39). */
const recent = [userEvent("t38", "prompt 38", 380), userEvent("t39", "prompt 39", 390), userEvent("t40", "prompt 40", 400)];

const zeros = (n: number) => Array.from({ length: n }, () => 0);

function readySummary(total = 40): OutlineSummaryState {
  return {
    status: "ready",
    totalTurns: total,
    bucketSize: 1,
    tools: zeros(total),
    edits: zeros(total),
    errors: zeros(total),
    revision: "1",
  };
}

/** Window loader over `turns` (by index); `turns` may grow between renders to model a landed window. */
function windowsOver(turns: Map<number, TranscriptOutlineTurn>, version = 0): OutlineWindows {
  return {
    turnAt: (i) => turns.get(i),
    peek: (i) => turns.get(i),
    request: vi.fn(),
    fetchNow: vi.fn(async (i: number) => turns.get(i) ?? null),
    version,
  };
}

function allTurns(): Map<number, TranscriptOutlineTurn> {
  return new Map(FORTY_TURNS.map((t, i) => [i, t] as const));
}

function sourceWith(
  summary: OutlineSummaryState,
  windows: OutlineWindows,
  loaders: Partial<Pick<OutlineSource, "viewAround" | "fetchWindow">> = {},
): OutlineSource {
  return {
    summary,
    windows,
    viewAround: vi.fn(async () => {}),
    onMismatch: vi.fn(),
    fetchWindow: () => new Promise<never>(() => {}),
    ...loaders,
  };
}

/** Lets a resolved or rejected loader promise run its handlers. */
const settle = () => act(async () => {});

/** Tap the chain: a sticky list opens. */
function tapChain() {
  const chain = screen.getByRole("button", { name: /^Conversation outline/ });
  fireEvent.pointerDown(chain, { pointerId: 1, pointerType: "mouse", button: 0, clientY: 100 });
  fireEvent.pointerUp(chain, { pointerId: 1, pointerType: "mouse", clientY: 100 });
}

describe("MessageList: whole-chat outline", () => {
  let overlayHost: HTMLElement;

  beforeEach(() => {
    overlayHost = document.createElement("div");
    document.body.appendChild(overlayHost);
  });

  afterEach(() => {
    vi.useRealTimers();
    overlayHost.remove();
  });

  function renderWhole(source: OutlineSource | undefined, events = recent, turnsBefore: number | null = 37) {
    return render(
      <MessageList
        events={events}
        pending={[]}
        hasMore
        turnsBefore={turnsBefore}
        onLoadEarlier={vi.fn()}
        overlayHost={overlayHost}
        outlineSource={source}
      />,
    );
  }

  it("a ready summary covers the whole chat", () => {
    renderWhole(sourceWith(readySummary(), windowsOver(allTurns())));
    expect(screen.getByRole("button", { name: /40 turns/ })).toBeTruthy();
    expect(overlayHost.querySelector(".ol__cap")).toBeNull();

    tapChain();
    expect(screen.queryByRole("button", { name: "Load earlier turns" })).toBeNull();
    expect(screen.getByRole("treeitem", { name: /^Turn 1: / })).toBeTruthy();
    expect(screen.getAllByRole("treeitem")).toHaveLength(40);
  });

  it("a turn whose window has not landed is a skeleton row", () => {
    renderWhole(sourceWith(readySummary(), windowsOver(new Map())));
    tapChain();
    const row = screen.getByRole("treeitem", { name: /^Turn 1: / });
    expect(row).toHaveClass("skeleton");
    expect(row).toHaveTextContent("…");
  });

  it("the loaded turns are numbered from turnsBefore and keep their labels", () => {
    renderWhole(sourceWith(readySummary(), windowsOver(allTurns())));
    tapChain();
    expect(screen.getByRole("treeitem", { name: /^Turn 38: prompt 38/ })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: /^Turn 40: prompt 40/ })).toBeTruthy();
  });

  it("an unsupported summary keeps the loaded-window rail", () => {
    renderWhole(sourceWith({ ...readySummary(0), status: "unsupported" }, windowsOver(new Map())));
    expect(overlayHost.querySelector(".ol__cap")).not.toBeNull();
    tapChain();
    expect(screen.getByRole("button", { name: "Load earlier turns" })).toBeTruthy();
    expect(screen.getAllByRole("treeitem")).toHaveLength(3);
  });

  it("without turnsBefore the outline covers the loaded window only", () => {
    renderWhole(sourceWith(readySummary(), windowsOver(allTurns())), recent, null);
    expect(overlayHost.querySelector(".ol__cap")).not.toBeNull();
  });

  describe("jumping to and resting on unloaded turns", () => {
    it("a click on an unloaded row fetches its window, then opens it", async () => {
      const windows = windowsOver(allTurns());
      const viewAround = vi.fn(async () => {});
      renderWhole(sourceWith(readySummary(), windows, { viewAround }));
      tapChain();
      fireEvent.click(screen.getByRole("treeitem", { name: /^Turn 1: / }));
      await settle();
      expect(viewAround).toHaveBeenCalledTimes(1);
      expect(viewAround).toHaveBeenCalledWith(10);
    });

    it("a click on an unloaded row with no window fetches it first", async () => {
      const windows = windowsOver(new Map());
      windows.fetchNow = vi.fn(async (i: number) => FORTY_TURNS[i] ?? null);
      const viewAround = vi.fn(async () => {});
      renderWhole(sourceWith(readySummary(), windows, { viewAround }));
      tapChain();
      fireEvent.click(screen.getByRole("treeitem", { name: /^Turn 2: / }));
      await settle();
      expect(windows.fetchNow).toHaveBeenCalledWith(1);
      expect(viewAround).toHaveBeenCalledWith(20);
    });

    it("a click on a loaded row never calls viewAround", async () => {
      const windows = windowsOver(allTurns());
      const viewAround = vi.fn(async () => {});
      renderWhole(sourceWith(readySummary(), windows, { viewAround }));
      tapChain();
      fireEvent.click(screen.getByRole("treeitem", { name: /^Turn 40: / }));
      await settle();
      expect(viewAround).not.toHaveBeenCalled();
      expect(windows.fetchNow).not.toHaveBeenCalled();
    });

    it("a failed fetch leaves the chat alone", async () => {
      const windows = windowsOver(new Map());
      windows.fetchNow = vi.fn(async () => null);
      const viewAround = vi.fn(async () => {});
      renderWhole(sourceWith(readySummary(), windows, { viewAround }));
      tapChain();
      expect(() => fireEvent.click(screen.getByRole("treeitem", { name: /^Turn 1: / }))).not.toThrow();
      await settle();
      expect(viewAround).not.toHaveBeenCalled();
    });

    it("a rejected viewAround leaves the chat alone", async () => {
      const viewAround = vi.fn(() => Promise.reject(new Error("offline")));
      renderWhole(sourceWith(readySummary(), windowsOver(allTurns()), { viewAround }));
      tapChain();
      expect(() => fireEvent.click(screen.getByRole("treeitem", { name: /^Turn 1: / }))).not.toThrow();
      await settle();
      expect(viewAround).toHaveBeenCalledTimes(1);
    });

    it("resting on an unloaded row requests its window through the windows owner", () => {
      const windows = windowsOver(new Map());
      renderWhole(sourceWith(readySummary(), windows));
      tapChain();
      expect(windows.request).toHaveBeenCalledWith(expect.any(Number));
      const idx = vi.mocked(windows.request).mock.calls.at(-1)![0] as number;
      expect(idx).toBeLessThan(37);
    });

    it("a marked row asks again when the window store is replaced (a revision refetch)", () => {
      const source = sourceWith(readySummary(), windowsOver(new Map(), 1));
      const { rerender } = renderWhole(source);
      tapChain();
      const idx = vi.mocked(source.windows.request).mock.calls.at(-1)![0] as number;

      const replaced = windowsOver(new Map(), 2);
      rerender(
        <MessageList
          events={recent}
          pending={[]}
          hasMore
          turnsBefore={37}
          onLoadEarlier={vi.fn()}
          overlayHost={overlayHost}
          outlineSource={{ ...source, windows: replaced }}
        />,
      );
      expect(replaced.request).toHaveBeenCalledWith(idx);
    });

    it("a loaded turn that disagrees with its cached window turn reports the mismatch once per revision", () => {
      const turns = allTurns();
      turns.set(37, { ...FORTY_TURNS[37]!, seq: 999 });
      const source = sourceWith(readySummary(), windowsOver(turns));
      const { rerender } = renderWhole(source);
      expect(source.onMismatch).toHaveBeenCalledTimes(1);

      rerender(
        <MessageList
          events={[...recent]}
          pending={[]}
          hasMore
          turnsBefore={37}
          onLoadEarlier={vi.fn()}
          overlayHost={overlayHost}
          outlineSource={{ ...source }}
        />,
      );
      expect(source.onMismatch).toHaveBeenCalledTimes(1);
    });

    it("turns that agree with their window turns report nothing", () => {
      const source = sourceWith(readySummary(), windowsOver(allTurns()));
      renderWhole(source);
      expect(source.onMismatch).not.toHaveBeenCalled();
    });

    it("once its window lands, a marked row fetches its steps without a dwell", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const fetchWindow = vi.fn<OutlineSource["fetchWindow"]>(() => new Promise<never>(() => {}));
      const source = sourceWith(readySummary(), windowsOver(new Map()), { fetchWindow });
      const { rerender } = renderWhole(source);
      tapChain();
      expect(fetchWindow).not.toHaveBeenCalled();

      const idx = vi.mocked(source.windows.request).mock.calls.at(-1)![0] as number;
      const landed = windowsOver(allTurns(), 1);
      rerender(
        <MessageList
          events={recent}
          pending={[]}
          hasMore
          turnsBefore={37}
          onLoadEarlier={vi.fn()}
          overlayHost={overlayHost}
          outlineSource={{ ...source, windows: landed }}
        />,
      );
      act(() => {
        vi.advanceTimersByTime(0);
      });
      expect(fetchWindow).toHaveBeenCalledTimes(1);
      expect(fetchWindow.mock.calls[0]![0]).toBe((idx + 1) * 10);
      expect(screen.getByRole("treeitem", { name: new RegExp(`^Turn ${idx + 1}: `) })).toHaveTextContent("Loading steps…");
    });

    it("an unsupported summary never fetches windows or steps", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const fetchWindow = vi.fn<OutlineSource["fetchWindow"]>(() => new Promise<never>(() => {}));
      const windows = windowsOver(new Map());
      renderWhole(sourceWith({ ...readySummary(0), status: "unsupported" }, windows, { fetchWindow }));
      tapChain();
      act(() => {
        vi.advanceTimersByTime(BEAT_DWELL_MS * 2);
      });
      expect(windows.request).not.toHaveBeenCalledWith(expect.any(Number));
      expect(fetchWindow).not.toHaveBeenCalled();
    });
  });
});
