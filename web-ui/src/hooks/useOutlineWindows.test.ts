import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiInstance } from "@/api";
import type { TranscriptOutlineTurn, TranscriptOutlineWindow } from "@/api/types";
import { useOutlineWindows } from "./useOutlineWindows";

interface Call {
  from: number;
  limit: number | undefined;
  signal: AbortSignal;
}

/** A window of `count` turns starting at `from` (turn `from + k` has seq `from + k`). */
function win(from: number, count: number, opts: { revision?: string; ready?: boolean } = {}): TranscriptOutlineWindow {
  const turns: TranscriptOutlineTurn[] = Array.from({ length: count }, (_, k) => ({
    seq: from + k,
    turnKey: `t${from + k}`,
    label: `turn ${from + k}`,
    counts: { tools: 0, edits: 0, errors: 0 },
  }));
  return { ready: opts.ready ?? true, totalTurns: 1000, revision: opts.revision ?? "0", from, turns };
}

/** Fake api whose window fetches resolve at once with a full 40-turn window unless a test overrides them. */
function makeApi(total = 1000) {
  const calls: Call[] = [];
  const getTranscriptOutlineWindow = vi.fn(
    async (_sid: string, params: { from: number; limit?: number }, signal?: AbortSignal): Promise<TranscriptOutlineWindow> => {
      calls.push({ from: params.from, limit: params.limit, signal: signal! });
      return win(params.from, Math.max(0, Math.min(40, total - params.from)));
    },
  );
  const api = { getTranscriptOutlineWindow } as unknown as ApiInstance;
  return { api, calls, getTranscriptOutlineWindow };
}

function hold<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function mount(api: ApiInstance, props: { sid?: string | null; revision?: string | null; onMismatch?: () => void } = {}) {
  return renderHook(
    ({ sid, revision }: { sid: string | null; revision: string | null }) =>
      useOutlineWindows(api, sid, revision, props.onMismatch ?? (() => {})),
    { initialProps: { sid: props.sid === undefined ? "s1" : props.sid, revision: props.revision === undefined ? "0" : props.revision } },
  );
}

describe("useOutlineWindows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetchNow fetches the window starting at floor(index / 40) * 40 with the default limit, without dwell", async () => {
    const { api, calls } = makeApi();
    const { result } = mount(api);

    let turn: TranscriptOutlineTurn | null = null;
    await act(async () => {
      turn = await result.current.fetchNow(45);
    });
    expect(turn).toMatchObject({ seq: 45, label: "turn 45" });
    expect(calls.map((c) => [c.from, c.limit])).toEqual([[40, 40]]);
    expect(result.current.turnAt(40)).toMatchObject({ seq: 40 });
    expect(result.current.turnAt(79)).toMatchObject({ seq: 79 });
    expect(result.current.turnAt(80)).toBeUndefined();
  });

  it("request dwells 300 ms before fetching, and a repeated request for the same window does not restart the dwell", async () => {
    const { api, calls } = makeApi();
    const { result } = mount(api);

    act(() => result.current.request(5));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    act(() => result.current.request(7));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(99);
    });
    expect(calls).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(calls.map((c) => c.from)).toEqual([0]);
    expect(result.current.turnAt(5)).toMatchObject({ seq: 5 });
  });

  it("request(null) and a request for a cached index cancel a pending dwell", async () => {
    const { api, calls } = makeApi();
    const { result } = mount(api);

    act(() => result.current.request(5));
    act(() => result.current.request(null));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(calls).toHaveLength(0);

    await act(async () => {
      await result.current.fetchNow(5);
    });
    act(() => result.current.request(6));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(calls).toHaveLength(1);
  });

  it("a request for another window replaces the dwell", async () => {
    const { api, calls } = makeApi();
    const { result } = mount(api);

    act(() => result.current.request(5));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    act(() => result.current.request(45));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(calls.map((c) => c.from)).toEqual([40]);
  });

  it("fetchNow aborts a dwelling request for another window", async () => {
    const { api, calls } = makeApi();
    const { result } = mount(api);

    act(() => result.current.request(45));
    await act(async () => {
      await result.current.fetchNow(5);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(calls.map((c) => c.from)).toEqual([0]);
  });

  it("fetchNow reuses the in-flight request for the same window", async () => {
    const { api, calls } = makeApi();
    const { result } = mount(api);

    let a: TranscriptOutlineTurn | null = null;
    let b: TranscriptOutlineTurn | null = null;
    await act(async () => {
      const pa = result.current.fetchNow(3);
      const pb = result.current.fetchNow(7);
      [a, b] = await Promise.all([pa, pb]);
    });
    expect(calls).toHaveLength(1);
    expect(a).toMatchObject({ seq: 3 });
    expect(b).toMatchObject({ seq: 7 });
  });

  it("a stale in-flight request is aborted when a fetch for another window starts", async () => {
    const { api, calls, getTranscriptOutlineWindow } = makeApi();
    const pending = hold<TranscriptOutlineWindow>();
    getTranscriptOutlineWindow.mockImplementationOnce(async (_sid, params, signal) => {
      calls.push({ from: params.from, limit: params.limit, signal: signal! });
      return pending.promise;
    });
    const { result } = mount(api);

    let stale: Promise<TranscriptOutlineTurn | null> | undefined;
    act(() => {
      stale = result.current.fetchNow(45);
    });

    await act(async () => {
      await result.current.fetchNow(5);
    });
    expect(calls[0]!.signal.aborted).toBe(true);

    await act(async () => {
      pending.resolve(win(40, 40));
    });
    await expect(stale).resolves.toBeNull();
    expect(result.current.turnAt(40)).toBeUndefined();
  });

  it("keeps at most 64 windows, dropping the least recently used", async () => {
    const { api } = makeApi(64 * 40 + 40);
    const { result } = mount(api);

    for (let w = 0; w < 64; w++) {
      await act(async () => {
        await result.current.fetchNow(w * 40);
      });
    }
    // Reading window 0 makes window 40 the least recently used.
    expect(result.current.turnAt(0)).toBeDefined();
    await act(async () => {
      await result.current.fetchNow(64 * 40);
    });
    expect(result.current.turnAt(0)).toBeDefined();
    expect(result.current.turnAt(40)).toBeUndefined();
    expect(result.current.turnAt(64 * 40)).toBeDefined();
  });

  it("scrubbing past many windows evicts the least recently used one, and bulk peeks never refresh recency", async () => {
    const { api } = makeApi(66 * 40);
    const { result } = mount(api);
    for (let w = 0; w < 64; w++) {
      await act(async () => {
        await result.current.fetchNow(w * 40);
      });
    }
    // Rebuilds visit every index through `peek`: window 0 stays the oldest despite them.
    for (let i = 0; i < 64 * 40; i++) result.current.peek(i);
    // A real use (a dwell request for a cached turn) refreshes window 40's recency, so 80 is evicted second.
    act(() => result.current.request(40));
    await act(async () => {
      await result.current.fetchNow(64 * 40);
    });
    await act(async () => {
      await result.current.fetchNow(65 * 40);
    });
    expect(result.current.peek(0)).toBeUndefined();
    expect(result.current.peek(80)).toBeUndefined();
    expect(result.current.peek(40)).toBeDefined();
    expect(result.current.peek(120)).toBeDefined();
  });

  it("a dwell fetch never aborts an in-flight jump fetch: it waits behind it", async () => {
    const { api, calls, getTranscriptOutlineWindow } = makeApi();
    const jump = hold<TranscriptOutlineWindow>();
    getTranscriptOutlineWindow.mockImplementationOnce(async (_sid, params, signal) => {
      calls.push({ from: params.from, limit: params.limit, signal: signal! });
      return jump.promise;
    });
    const { result } = mount(api);

    let jumped: Promise<TranscriptOutlineTurn | null> | undefined;
    act(() => {
      jumped = result.current.fetchNow(45);
    });
    act(() => result.current.request(500));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal.aborted).toBe(false);

    await act(async () => {
      jump.resolve(win(40, 40));
    });
    await expect(jumped).resolves.toMatchObject({ seq: 45 });
    // The dwell then fetches its own window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls.map((c) => c.from)).toEqual([40, 480]);
  });

  it("a dwell that waited behind a jump is dropped when the mark moved on", async () => {
    const { api, calls, getTranscriptOutlineWindow } = makeApi();
    const jump = hold<TranscriptOutlineWindow>();
    getTranscriptOutlineWindow.mockImplementationOnce(async (_sid, params, signal) => {
      calls.push({ from: params.from, limit: params.limit, signal: signal! });
      return jump.promise;
    });
    const { result } = mount(api);
    act(() => {
      void result.current.fetchNow(45);
    });
    act(() => result.current.request(500));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    act(() => result.current.request(null));
    await act(async () => {
      jump.resolve(win(40, 40));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls).toHaveLength(1);
  });

  it("a partial window misses at and after its end, and a request for that index fetches again", async () => {
    const { api, getTranscriptOutlineWindow } = makeApi();
    getTranscriptOutlineWindow.mockResolvedValueOnce(win(40, 3)).mockResolvedValueOnce(win(40, 3));
    const { result } = mount(api);

    await act(async () => {
      await result.current.fetchNow(41);
    });
    expect(result.current.turnAt(42)).toMatchObject({ seq: 42 });
    expect(result.current.turnAt(43)).toBeUndefined();

    await act(async () => {
      expect(await result.current.fetchNow(43)).toBeNull();
    });
    expect(getTranscriptOutlineWindow).toHaveBeenCalledTimes(2);
  });

  it("a not-ready window is a miss and is never stored", async () => {
    const { api, getTranscriptOutlineWindow } = makeApi();
    getTranscriptOutlineWindow.mockResolvedValueOnce(win(0, 0, { ready: false, revision: "0" }));
    const onMismatch = vi.fn();
    const { result } = mount(api, { onMismatch });
    const versionBefore = result.current.version;

    await act(async () => {
      expect(await result.current.fetchNow(3)).toBeNull();
    });
    expect(result.current.turnAt(3)).toBeUndefined();
    expect(result.current.version).toBe(versionBefore);
    expect(onMismatch).not.toHaveBeenCalled();
  });

  it("a window of another revision is a miss, is not stored, and reports the mismatch once", async () => {
    const { api, getTranscriptOutlineWindow } = makeApi();
    getTranscriptOutlineWindow.mockResolvedValueOnce(win(0, 40, { revision: "9" }));
    const onMismatch = vi.fn();
    const { result } = mount(api, { onMismatch });

    await act(async () => {
      expect(await result.current.fetchNow(3)).toBeNull();
    });
    expect(onMismatch).toHaveBeenCalledTimes(1);
    expect(result.current.turnAt(3)).toBeUndefined();
  });

  it("a failed fetch resolves null and stores nothing", async () => {
    const { api, getTranscriptOutlineWindow } = makeApi();
    getTranscriptOutlineWindow.mockRejectedValueOnce(new Error("network"));
    const { result } = mount(api);

    await act(async () => {
      expect(await result.current.fetchNow(3)).toBeNull();
    });
    expect(result.current.turnAt(3)).toBeUndefined();
  });

  it("with no revision (summary not ready) nothing is fetched", async () => {
    const { api, calls } = makeApi();
    const { result } = mount(api, { revision: null });

    act(() => result.current.request(5));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      expect(await result.current.fetchNow(5)).toBeNull();
    });
    expect(calls).toHaveLength(0);
  });

  it("a new revision or session drops every cached window and bumps the version", async () => {
    const { api, getTranscriptOutlineWindow } = makeApi();
    const { result, rerender } = renderHook(
      ({ sid, revision }: { sid: string | null; revision: string | null }) => useOutlineWindows(api, sid, revision, () => {}),
      { initialProps: { sid: "s1" as string | null, revision: "0" as string | null } },
    );
    await act(async () => {
      await result.current.fetchNow(5);
    });
    const version = result.current.version;

    rerender({ sid: "s1", revision: "1" });
    expect(result.current.turnAt(5)).toBeUndefined();
    expect(result.current.version).not.toBe(version);

    await act(async () => {
      await result.current.fetchNow(5);
    });
    expect(getTranscriptOutlineWindow).toHaveBeenLastCalledWith("s1", { from: 0, limit: 40 }, expect.any(AbortSignal));
    rerender({ sid: "s2", revision: "1" });
    expect(result.current.turnAt(5)).toBeUndefined();
  });

  it("unmounting aborts the in-flight fetch", async () => {
    const { api, calls, getTranscriptOutlineWindow } = makeApi();
    getTranscriptOutlineWindow.mockImplementationOnce(async (_sid, params, signal) => {
      calls.push({ from: params.from, limit: params.limit, signal: signal! });
      return new Promise<TranscriptOutlineWindow>(() => {});
    });
    const { result, unmount } = mount(api);
    void result.current.fetchNow(3);
    unmount();
    expect(calls[0]!.signal.aborted).toBe(true);
  });
});
