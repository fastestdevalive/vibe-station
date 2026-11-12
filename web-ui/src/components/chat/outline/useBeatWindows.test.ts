import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBeatWindow, BEAT_DWELL_MS, BEAT_WINDOW_LRU, useBeatWindows } from "./useBeatWindows";
import type { BeatWindowItems, OutlineSource } from "./outlineSource";
import { makeUserItem } from "./outlineTestUtils";

type Fetch = OutlineSource["fetchWindow"];

/** A window holding one turn `t{seq}` whose first seq is `seq`. */
function windowAt(seq: number): BeatWindowItems {
  return {
    items: [makeUserItem(`t${seq}`, `prompt ${seq}`)],
    seqIndex: new Map([[seq, `u:t${seq}`]]),
    turnsBefore: 0,
  };
}

interface Deferred {
  call: { seq: number; signal: AbortSignal };
  resolve: (w: BeatWindowItems) => void;
  reject: (e: unknown) => void;
}

/** A fetcher that records each call and leaves it pending until the test settles it. */
function deferredFetch() {
  const calls: Deferred[] = [];
  const fetch = vi.fn<Fetch>(
    (seq, signal) =>
      new Promise<BeatWindowItems>((resolve, reject) => {
        calls.push({ call: { seq, signal }, resolve, reject });
      }),
  );
  return { fetch, calls };
}

/** Advances the fake clock inside act, so the timer's state updates commit. */
const tick = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

/** Lets resolved fetch promises run their handlers. */
const settle = () => act(async () => {});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("buildBeatWindow", () => {
  it("keys the nodes by the turn's first seq", () => {
    const nodes = buildBeatWindow(windowAt(10));
    expect(nodes.get(10)?.key).toBe("t10");
  });
});

describe("useBeatWindows", () => {
  it("waits for the dwell before fetching", () => {
    const { fetch } = deferredFetch();
    const { result } = renderHook(() => useBeatWindows(fetch));
    act(() => result.current.request(10));
    tick(BEAT_DWELL_MS - 1);
    expect(fetch).not.toHaveBeenCalled();
    tick(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(10);
    expect(result.current.pendingSeq).toBe(10);
  });

  it("a request can name its own dwell (0 fetches on the next tick)", () => {
    const { fetch } = deferredFetch();
    const { result } = renderHook(() => useBeatWindows(fetch));
    act(() => result.current.request(10, 0));
    tick(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(10);
  });

  it("entries() lists every fetched turn with steps, by seq", async () => {
    const { fetch, calls } = deferredFetch();
    const { result } = renderHook(() => useBeatWindows(fetch));
    act(() => result.current.request(10, 0));
    tick(0);
    calls[0]!.resolve(windowAt(10));
    await settle();
    expect(result.current.entries().map(([seq, node]) => [seq, node.key])).toEqual([[10, "t10"]]);
  });

  it("a new target before the dwell cancels the first", () => {
    const { fetch } = deferredFetch();
    const { result } = renderHook(() => useBeatWindows(fetch));
    act(() => result.current.request(10));
    tick(100);
    act(() => result.current.request(20));
    tick(BEAT_DWELL_MS);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(20);
  });

  it("a new target during a request aborts it and drops its result", async () => {
    const { fetch, calls } = deferredFetch();
    const { result } = renderHook(() => useBeatWindows(fetch));
    act(() => result.current.request(10));
    tick(BEAT_DWELL_MS);
    act(() => result.current.request(20));
    expect(calls[0]!.call.signal.aborted).toBe(true);
    calls[0]!.resolve(windowAt(10));
    await settle();
    expect(result.current.nodeAt(10)).toBeUndefined();
    expect(result.current.version).toBe(0);
  });

  it("a landed window serves nodeAt, clears pending, bumps version", async () => {
    const { fetch, calls } = deferredFetch();
    const { result } = renderHook(() => useBeatWindows(fetch));
    act(() => result.current.request(10));
    tick(BEAT_DWELL_MS);
    calls[0]!.resolve(windowAt(10));
    await settle();
    expect(result.current.nodeAt(10)?.key).toBe("t10");
    expect(result.current.pendingSeq).toBeNull();
    expect(result.current.version).toBe(1);
  });

  it("a cached turn is not fetched again", async () => {
    const { fetch, calls } = deferredFetch();
    const { result } = renderHook(() => useBeatWindows(fetch));
    act(() => result.current.request(10));
    tick(BEAT_DWELL_MS);
    calls[0]!.resolve(windowAt(10));
    await settle();
    act(() => result.current.request(10));
    tick(BEAT_DWELL_MS * 2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps at most BEAT_WINDOW_LRU windows", async () => {
    const { fetch, calls } = deferredFetch();
    const { result } = renderHook(() => useBeatWindows(fetch));
    const seqs = Array.from({ length: BEAT_WINDOW_LRU + 1 }, (_, i) => (i + 1) * 10);
    for (const seq of seqs) {
      act(() => result.current.request(seq));
      tick(BEAT_DWELL_MS);
      calls[calls.length - 1]!.resolve(windowAt(seq));
      await settle();
    }
    expect(result.current.nodeAt(10)).toBeUndefined();
    expect(result.current.nodeAt(seqs[seqs.length - 1]!)).toBeDefined();
  });

  it("request(null) cancels a pending dwell", () => {
    const { fetch } = deferredFetch();
    const { result } = renderHook(() => useBeatWindows(fetch));
    act(() => result.current.request(10));
    act(() => result.current.request(null));
    tick(BEAT_DWELL_MS * 2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a failed fetch clears pending and keeps the cache", async () => {
    const { fetch, calls } = deferredFetch();
    const { result } = renderHook(() => useBeatWindows(fetch));
    act(() => result.current.request(10));
    tick(BEAT_DWELL_MS);
    calls[0]!.resolve(windowAt(10));
    await settle();
    act(() => result.current.request(20));
    tick(BEAT_DWELL_MS);
    calls[1]!.reject(new Error("offline"));
    await settle();
    expect(result.current.pendingSeq).toBeNull();
    expect(result.current.nodeAt(10)?.key).toBe("t10");
    expect(result.current.nodeAt(20)).toBeUndefined();
  });

  it("a new fetcher drops every window", async () => {
    const first = deferredFetch();
    const { result, rerender } = renderHook(({ f }: { f: Fetch }) => useBeatWindows(f), {
      initialProps: { f: first.fetch },
    });
    act(() => result.current.request(10));
    tick(BEAT_DWELL_MS);
    first.calls[0]!.resolve(windowAt(10));
    await settle();
    expect(result.current.nodeAt(10)).toBeDefined();

    const second = deferredFetch();
    rerender({ f: second.fetch });
    expect(result.current.nodeAt(10)).toBeUndefined();
  });
});

describe("useBeatWindows revision", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("drops every cached window when the summary revision changes", async () => {
    const fetch = vi.fn<Fetch>(async (seq) => windowAt(seq));
    const { result, rerender } = renderHook(({ rev }) => useBeatWindows(fetch, rev), { initialProps: { rev: "1" } });
    act(() => result.current.request(10, 0));
    await act(async () => {
      vi.advanceTimersByTime(0);
    });
    expect(result.current.nodeAt(10)).toBeDefined();
    rerender({ rev: "1" });
    expect(result.current.nodeAt(10)).toBeDefined();
    rerender({ rev: "2" });
    expect(result.current.nodeAt(10)).toBeUndefined();
  });

  it("bumps version when a revision change clears the cache", async () => {
    const { fetch } = deferredFetch();
    const { result, rerender } = renderHook(({ rev }) => useBeatWindows(fetch, rev), { initialProps: { rev: "1" } });
    const before = result.current.version;
    rerender({ rev: "2" });
    expect(result.current.version).toBeGreaterThan(before);
  });
});
