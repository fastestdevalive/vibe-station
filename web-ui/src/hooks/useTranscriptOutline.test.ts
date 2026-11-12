import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiInstance } from "@/api";
import { ApiError } from "@/api/errors";
import type { NormalizedEvent, TranscriptOutlineSummary, WSEvent } from "@/api/types";
import { useTranscriptOutline, type OutlineSummaryState } from "./useTranscriptOutline";
import * as outlineCache from "./transcriptOutlineCache";

type Handler = (e: WSEvent) => void;

function makeFakeApi() {
  const listeners = new Map<string, Set<Handler>>();
  const on = (type: string, handler: Handler) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(handler);
    return () => {
      listeners.get(type)?.delete(handler);
    };
  };
  const emit = (type: string, payload: Record<string, unknown> = {}) => {
    for (const h of listeners.get(type) ?? []) h({ type, ...payload } as unknown as WSEvent);
  };
  const getTranscriptOutline = vi.fn<(sid: string, signal?: AbortSignal) => Promise<TranscriptOutlineSummary>>();
  const api = { on, getTranscriptOutline } as unknown as ApiInstance;
  return { api, emit, getTranscriptOutline };
}

function summary(totalTurns: number, opts: { revision?: string; bucketSize?: number } = {}): TranscriptOutlineSummary {
  const bucketSize = opts.bucketSize ?? 1;
  const buckets = Math.ceil(totalTurns / bucketSize);
  return {
    ready: true,
    totalTurns,
    revision: opts.revision ?? "0",
    bucketSize,
    tools: new Array<number>(buckets).fill(1),
    edits: new Array<number>(buckets).fill(0),
    errors: new Array<number>(buckets).fill(0),
  };
}

const BUILDING: TranscriptOutlineSummary = { ready: false, totalTurns: 0, revision: "0", bucketSize: 1, tools: [], edits: [], errors: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function userEvent(logSeq: number, extra: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return { id: `u${logSeq}`, sessionId: "s1", ts: "", provider: "claude", kind: "user", logSeq, turnId: `t${logSeq}`, text: "q", ...extra };
}

describe("useTranscriptOutline", () => {
  beforeEach(() => {
    outlineCache.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads a ready summary and keeps the revision", async () => {
    const { api, getTranscriptOutline } = makeFakeApi();
    getTranscriptOutline.mockResolvedValueOnce(summary(3, { revision: "4", bucketSize: 1 }));

    const { result } = renderHook(() => useTranscriptOutline(api, "s1"));
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toMatchObject({ totalTurns: 3, bucketSize: 1, revision: "4", tools: [1, 1, 1] });
    expect(getTranscriptOutline).toHaveBeenCalledWith("s1", expect.any(AbortSignal));
  });

  it("is idle when disabled or without a session, and never fetches", () => {
    const { api, getTranscriptOutline } = makeFakeApi();
    expect(renderHook(() => useTranscriptOutline(api, "s1", false)).result.current.status).toBe("idle");
    expect(renderHook(() => useTranscriptOutline(api, null)).result.current.status).toBe("idle");
    expect(getTranscriptOutline).not.toHaveBeenCalled();
  });

  it("retries while the index builds, then becomes ready", async () => {
    vi.useFakeTimers();
    const { api, getTranscriptOutline } = makeFakeApi();
    getTranscriptOutline
      .mockResolvedValueOnce(BUILDING)
      .mockResolvedValueOnce(BUILDING)
      .mockResolvedValueOnce(summary(2));

    const { result } = renderHook(() => useTranscriptOutline(api, "s1"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe("building");
    expect(getTranscriptOutline).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1499);
    });
    expect(getTranscriptOutline).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(getTranscriptOutline).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(getTranscriptOutline).toHaveBeenCalledTimes(3);
    expect(result.current).toMatchObject({ status: "ready", totalTurns: 2 });
  });

  it("gives up after 40 retries with error", async () => {
    vi.useFakeTimers();
    const { api, getTranscriptOutline } = makeFakeApi();
    getTranscriptOutline.mockResolvedValue(BUILDING);

    const { result } = renderHook(() => useTranscriptOutline(api, "s1"));
    for (let i = 0; i < 41; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
    }
    expect(getTranscriptOutline).toHaveBeenCalledTimes(41);
    expect(result.current.status).toBe("error");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(getTranscriptOutline).toHaveBeenCalledTimes(41);
  });

  it.each([
    ["OUTLINE_UNSUPPORTED", new ApiError("x", 404, "OUTLINE_UNSUPPORTED"), "unsupported"],
    ["OUTLINE_UNAVAILABLE (503)", new ApiError("x", 503, "OUTLINE_UNAVAILABLE"), "unsupported"],
    ["a bare 404", new ApiError("Not found", 404), "unsupported"],
    ["a bare 405", new ApiError("x", 405), "unsupported"],
    ["a bare 501", new ApiError("x", 501), "unsupported"],
    ["a 500", new ApiError("x", 500), "error"],
    ["a 404 NOT_FOUND", new ApiError("x", 404, "NOT_FOUND"), "error"],
    ["a 404 NOT_JSON", new ApiError("x", 404, "NOT_JSON"), "error"],
    ["a network failure", new TypeError("fetch failed"), "error"],
  ])("%s ends %s without retrying", async (_label, failure, expected) => {
    const { api, getTranscriptOutline } = makeFakeApi();
    getTranscriptOutline.mockRejectedValueOnce(failure);

    const { result } = renderHook(() => useTranscriptOutline(api, "s1"));
    await waitFor(() => expect(result.current.status).toBe(expected));
    expect(getTranscriptOutline).toHaveBeenCalledTimes(1);
  });

  it("a session switch never shows the previous session's summary and aborts its fetch", async () => {
    const { api, getTranscriptOutline } = makeFakeApi();
    getTranscriptOutline.mockImplementation(async (sid: string) => (sid === "s1" ? summary(5) : neverSettles<TranscriptOutlineSummary>()));
    const seen: OutlineSummaryState[] = [];
    const { result, rerender } = renderHook(
      ({ sid }: { sid: string }) => {
        const state = useTranscriptOutline(api, sid);
        seen.push(state);
        return state;
      },
      { initialProps: { sid: "s1" } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const before = seen.length;
    rerender({ sid: "s2" });
    const afterSwitch = seen.slice(before);
    expect(afterSwitch.length).toBeGreaterThan(0);
    for (const state of afterSwitch) {
      expect(state.status).toBe("loading");
      expect(state.totalTurns).toBe(0);
    }
    expect(getTranscriptOutline.mock.calls[0]![1]!.aborted).toBe(true);
  });

  it("a late result from the old session is dropped", async () => {
    const { api, getTranscriptOutline } = makeFakeApi();
    const late = deferred<TranscriptOutlineSummary>();
    getTranscriptOutline.mockReturnValueOnce(late.promise).mockImplementation(async () => neverSettles<TranscriptOutlineSummary>());

    const { result, rerender } = renderHook(({ sid }: { sid: string }) => useTranscriptOutline(api, sid), {
      initialProps: { sid: "s1" },
    });
    rerender({ sid: "s2" });
    await act(async () => {
      late.resolve(summary(9));
    });
    expect(result.current.status).toBe("loading");
    expect(result.current.totalTurns).toBe(0);
  });

  it("unmounting aborts the in-flight fetch", () => {
    const { api, getTranscriptOutline } = makeFakeApi();
    getTranscriptOutline.mockImplementation(async () => neverSettles<TranscriptOutlineSummary>());
    const { unmount } = renderHook(() => useTranscriptOutline(api, "s1"));
    const signal = getTranscriptOutline.mock.calls[0]![1]!;
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it("a refresh token change drops the summary at once, then refetches", async () => {
    const { api, getTranscriptOutline } = makeFakeApi();
    getTranscriptOutline.mockResolvedValueOnce(summary(2, { revision: "0" }));

    const { result, rerender } = renderHook(
      ({ token }: { token: number }) => useTranscriptOutline(api, "s1", true, token),
      { initialProps: { token: 0 } },
    );
    await waitFor(() => expect(result.current.revision).toBe("0"));

    getTranscriptOutline.mockReturnValueOnce(neverSettles<TranscriptOutlineSummary>());
    rerender({ token: 1 });
    expect(result.current.status).toBe("loading");
    expect(result.current.revision).toBe("");
    expect(getTranscriptOutline).toHaveBeenCalledTimes(2);

    getTranscriptOutline.mockResolvedValueOnce(summary(3, { revision: "1" }));
    rerender({ token: 1 });
    expect(getTranscriptOutline).toHaveBeenCalledTimes(2);
  });

  it("ws:open refetches and keeps the ready summary while it revalidates", async () => {
    const { api, emit, getTranscriptOutline } = makeFakeApi();
    getTranscriptOutline.mockResolvedValueOnce(summary(2));
    const { result } = renderHook(() => useTranscriptOutline(api, "s1"));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const held = deferred<TranscriptOutlineSummary>();
    getTranscriptOutline.mockReturnValueOnce(held.promise);
    act(() => {
      emit("ws:open");
    });
    expect(getTranscriptOutline).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({ status: "ready", totalTurns: 2 });

    await act(async () => {
      held.resolve(summary(4, { revision: "1" }));
    });
    expect(result.current).toMatchObject({ status: "ready", totalTurns: 4, revision: "1" });
  });

  it("session:fork drops the summary at once and refetches", async () => {
    const { api, emit, getTranscriptOutline } = makeFakeApi();
    getTranscriptOutline.mockResolvedValueOnce(summary(2));
    const { result } = renderHook(() => useTranscriptOutline(api, "s1"));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    getTranscriptOutline.mockReturnValueOnce(neverSettles<TranscriptOutlineSummary>());
    act(() => {
      emit("session:fork", { sessionId: "s2", supersededTurnIds: [] });
    });
    expect(result.current.status).toBe("ready");

    act(() => {
      emit("session:fork", { sessionId: "s1", supersededTurnIds: [] });
    });
    expect(result.current.status).toBe("loading");
    expect(getTranscriptOutline).toHaveBeenCalledTimes(2);
  });

  it("a live user turn refetches the summary instead of counting locally (a summary that already holds it is not counted twice)", async () => {
    const { api, emit, getTranscriptOutline } = makeFakeApi();
    getTranscriptOutline.mockResolvedValueOnce(summary(3));
    const { result } = renderHook(() => useTranscriptOutline(api, "s1"));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    // The summary was fetched after user row 2000: the event for that row arrives later and the count stays 3.
    getTranscriptOutline.mockResolvedValueOnce(summary(3));
    act(() => {
      emit("session:message", { sessionId: "s1", event: userEvent(2000) });
    });
    expect(result.current.totalTurns).toBe(3);
    await waitFor(() => expect(getTranscriptOutline).toHaveBeenCalledTimes(2));
    expect(result.current.totalTurns).toBe(3);

    getTranscriptOutline.mockResolvedValueOnce(summary(4));
    act(() => {
      emit("session:message", { sessionId: "s1", event: userEvent(2001) });
    });
    await waitFor(() => expect(result.current.totalTurns).toBe(4));
  });

  it("a burst of live user turns refetches once", async () => {
    const { api, emit, getTranscriptOutline } = makeFakeApi();
    getTranscriptOutline.mockResolvedValueOnce(summary(2));
    const { result } = renderHook(() => useTranscriptOutline(api, "s1"));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    getTranscriptOutline.mockResolvedValue(summary(5));
    act(() => {
      emit("session:message", { sessionId: "s1", event: userEvent(10) });
      emit("session:message", { sessionId: "s1", event: userEvent(11) });
      emit("session:message", { sessionId: "s1", event: userEvent(12) });
    });
    await waitFor(() => expect(result.current.totalTurns).toBe(5));
    expect(getTranscriptOutline).toHaveBeenCalledTimes(2);
  });

  it("a failed ws:open refetch keeps the held ready summary", async () => {
    const { api, emit, getTranscriptOutline } = makeFakeApi();
    getTranscriptOutline.mockResolvedValueOnce(summary(4));
    const { result } = renderHook(() => useTranscriptOutline(api, "s1"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    getTranscriptOutline.mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      emit("ws:open");
    });
    await waitFor(() => expect(getTranscriptOutline).toHaveBeenCalledTimes(2));
    expect(result.current.status).toBe("ready");
    expect(result.current.totalTurns).toBe(4);
    // A later live turn still refetches.
    getTranscriptOutline.mockResolvedValue(summary(5));
    act(() => {
      emit("session:message", { sessionId: "s1", event: userEvent(20) });
    });
    await waitFor(() => expect(result.current.totalTurns).toBe(5));
  });

  it("an errored summary recovers on the next live user turn, once per turn", async () => {
    const { api, emit, getTranscriptOutline } = makeFakeApi();
    getTranscriptOutline.mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useTranscriptOutline(api, "s1"));
    await waitFor(() => expect(result.current.status).toBe("error"));
    getTranscriptOutline.mockResolvedValue(summary(6));
    act(() => {
      emit("session:message", { sessionId: "s1", event: userEvent(30) });
      emit("session:message", { sessionId: "s1", event: userEvent(30) }); // a replay of the same row
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.totalTurns).toBe(6);
    expect(getTranscriptOutline).toHaveBeenCalledTimes(2);
  });

  it("ignores silent, superseded, non-user and other-session events", async () => {
    const { api, emit, getTranscriptOutline } = makeFakeApi();
    getTranscriptOutline.mockResolvedValueOnce(summary(2));
    const { result } = renderHook(() => useTranscriptOutline(api, "s1"));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      emit("session:message", { sessionId: "s1", event: userEvent(10, { silent: true }) });
      emit("session:message", { sessionId: "s1", event: userEvent(11, { superseded: true }) });
      emit("session:message", { sessionId: "s1", event: { ...userEvent(12), kind: "text" } });
      emit("session:message", { sessionId: "other", event: userEvent(13) });
    });
    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    vi.useRealTimers();
    expect(result.current.totalTurns).toBe(2);
    expect(getTranscriptOutline).toHaveBeenCalledTimes(1);
  });

  it("a refetch that returns identical data keeps the previous state object", async () => {
    const { api, emit, getTranscriptOutline } = makeFakeApi();
    getTranscriptOutline.mockResolvedValue(summary(3));
    const { result } = renderHook(() => useTranscriptOutline(api, "s1"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const first = result.current;

    await act(async () => {
      emit("ws:open");
    });
    await waitFor(() => expect(getTranscriptOutline).toHaveBeenCalledTimes(2));
    expect(result.current).toBe(first);

    getTranscriptOutline.mockResolvedValue(summary(3, { revision: "1" }));
    await act(async () => {
      emit("ws:open");
    });
    await waitFor(() => expect(result.current.revision).toBe("1"));
    expect(result.current).not.toBe(first);
  });

  it("restores a cached summary at once and revalidates", async () => {
    const { api, getTranscriptOutline } = makeFakeApi();
    getTranscriptOutline.mockResolvedValueOnce(summary(4));
    const first = renderHook(() => useTranscriptOutline(api, "s1"));
    await waitFor(() => expect(first.result.current.status).toBe("ready"));
    first.unmount();

    getTranscriptOutline.mockImplementationOnce(async () => neverSettles<TranscriptOutlineSummary>());
    const second = renderHook(() => useTranscriptOutline(api, "s1"));
    expect(second.result.current).toMatchObject({ status: "ready", totalTurns: 4 });
    expect(getTranscriptOutline).toHaveBeenCalledTimes(2);
  });

  it("auth:expired clears the cached summaries", async () => {
    const { api, emit, getTranscriptOutline } = makeFakeApi();
    getTranscriptOutline.mockResolvedValueOnce(summary(1));
    const { result } = renderHook(() => useTranscriptOutline(api, "s1"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(outlineCache.restore("s1")).not.toBeNull();

    act(() => {
      emit("auth:expired");
    });
    expect(outlineCache.restore("s1")).toBeNull();
  });
});
