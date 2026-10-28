import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiInstance } from "@/api";
import type { ScheduleSnapshot, WSEvent } from "@/api/types";
import { useScheduleDevOverride } from "./scheduleDevOverride";
import { SENT_VISIBLE_MS, useScheduledSends } from "./useScheduledSends";

type Handler = (e: WSEvent) => void;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeApi(get: (id: string) => Promise<ScheduleSnapshot>) {
  const handlers = new Map<string, Set<Handler>>();
  const unsubscribe = vi.fn();
  const subscribe = vi.fn(() => unsubscribe);
  const getScheduledMessages = vi.fn(get);
  const api = {
    subscribe,
    getScheduledMessages,
    on(type: string, h: Handler) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(h);
      return () => handlers.get(type)!.delete(h);
    },
  } as unknown as ApiInstance;
  const emit = (e: WSEvent | { type: "ws:open" | "ws:resync" }) => {
    for (const h of handlers.get(e.type) ?? []) h(e as WSEvent);
  };
  return { api, emit, subscribe, unsubscribe, getScheduledMessages };
}

const snap = (over: Partial<ScheduleSnapshot> = {}): ScheduleSnapshot => ({
  scheduledSends: [],
  scheduledFailed: [],
  scheduledSent: [],
  ...over,
});
const pending = (id: string, fireAt: string, extra: object = {}) => ({ id, message: `m-${id}`, fireAt, ...extra });
const scheduledEvent = (sessionId: string, over: Partial<Extract<WSEvent, { type: "session:scheduled" }>> = {}): WSEvent => ({
  type: "session:scheduled",
  sessionId,
  scheduledSends: [],
  scheduledFailed: [],
  scheduledTurnIds: [],
  ...over,
});

afterEach(() => {
  useScheduleDevOverride.setState({ bySession: {} });
  vi.useRealTimers();
});

describe("useScheduledSends", () => {
  it("fetches once and subscribes once on mount, and unsubscribes on unmount", async () => {
    const t = makeApi(async () => snap({ scheduledSends: [pending("a", "2030-01-01T10:00:00Z")] }));
    const { result, unmount } = renderHook(() => useScheduledSends(t.api, "s1"));
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(t.getScheduledMessages).toHaveBeenCalledTimes(1);
    expect(t.subscribe).toHaveBeenCalledTimes(1);
    expect(t.subscribe).toHaveBeenCalledWith(["s1"]);
    unmount();
    expect(t.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a session id", () => {
    const t = makeApi(async () => snap());
    const { result } = renderHook(() => useScheduledSends(t.api, null));
    expect(result.current.rows).toEqual([]);
    expect(t.subscribe).not.toHaveBeenCalled();
    expect(t.getScheduledMessages).not.toHaveBeenCalled();
  });

  it("applies pushes for its session and ignores other sessions", async () => {
    const t = makeApi(async () => snap());
    const { result } = renderHook(() => useScheduledSends(t.api, "s1"));
    await waitFor(() => expect(t.getScheduledMessages).toHaveBeenCalled());
    act(() => t.emit(scheduledEvent("other", { scheduledSends: [pending("x", "2030-01-01T10:00:00Z")] })));
    expect(result.current.rows).toEqual([]);
    act(() => t.emit(scheduledEvent("s1", { scheduledSends: [pending("a", "2030-01-01T10:00:00Z")] })));
    expect(result.current.rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("refetches on reconnect", async () => {
    const t = makeApi(async () => snap());
    renderHook(() => useScheduledSends(t.api, "s1"));
    await waitFor(() => expect(t.getScheduledMessages).toHaveBeenCalledTimes(1));
    act(() => t.emit({ type: "ws:open" }));
    expect(t.getScheduledMessages).toHaveBeenCalledTimes(2);
  });

  it("refetches on ws:resync and unsubscribes it on unmount (review 16)", async () => {
    const t = makeApi(async () => snap());
    const { unmount } = renderHook(() => useScheduledSends(t.api, "s1"));
    await waitFor(() => expect(t.getScheduledMessages).toHaveBeenCalledTimes(1));
    act(() => t.emit({ type: "ws:resync" }));
    expect(t.getScheduledMessages).toHaveBeenCalledTimes(2);
    unmount();
    act(() => t.emit({ type: "ws:resync" }));
    expect(t.getScheduledMessages).toHaveBeenCalledTimes(2);
  });

  it("drops a fetch that resolves after a session switch", async () => {
    const first = deferred<ScheduleSnapshot>();
    const t = makeApi((id) => (id === "s1" ? first.promise : Promise.resolve(snap())));
    const { result, rerender } = renderHook(({ id }) => useScheduledSends(t.api, id), { initialProps: { id: "s1" } });
    rerender({ id: "s2" });
    await waitFor(() => expect(t.getScheduledMessages).toHaveBeenCalledWith("s2"));
    await act(async () => first.resolve(snap({ scheduledSends: [pending("stale", "2030-01-01T10:00:00Z")] })));
    expect(result.current.rows).toEqual([]);
  });

  it("drops a GET that resolves after a newer push", async () => {
    const get = deferred<ScheduleSnapshot>();
    const t = makeApi(() => get.promise);
    const { result } = renderHook(() => useScheduledSends(t.api, "s1"));
    act(() => t.emit(scheduledEvent("s1", { scheduledSends: [pending("fresh", "2030-01-01T10:00:00Z")] })));
    await act(async () => get.resolve(snap({ scheduledSends: [pending("old", "2030-01-01T09:00:00Z")] })));
    expect(result.current.rows.map((r) => r.id)).toEqual(["fresh"]);
  });

  it("keeps the last value when the fetch rejects (offline) without throwing", async () => {
    let fail = false;
    const t = makeApi(async () => {
      if (fail) throw new Error("offline");
      return snap({ scheduledSends: [pending("a", "2030-01-01T10:00:00Z")] });
    });
    const { result } = renderHook(() => useScheduledSends(t.api, "s1"));
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    fail = true;
    act(() => t.emit({ type: "ws:open" }));
    await waitFor(() => expect(t.getScheduledMessages).toHaveBeenCalledTimes(2));
    expect(result.current.rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("keeps the sent list when scheduledSent is absent, clears it when present and empty", async () => {
    const sentAt = new Date().toISOString();
    const t = makeApi(async () => snap({ scheduledSent: [{ id: "p", message: "m", fireAt: sentAt, sentAt }] }));
    const { result } = renderHook(() => useScheduledSends(t.api, "s1"));
    await waitFor(() => expect(result.current.rows.map((r) => r.kind)).toEqual(["sent"]));
    act(() => t.emit(scheduledEvent("s1", { scheduledSends: [pending("a", "2030-01-01T10:00:00Z")] })));
    expect(result.current.rows.map((r) => r.kind)).toEqual(["pending", "sent"]);
    act(() => t.emit(scheduledEvent("s1", { scheduledSent: [] })));
    expect(result.current.rows.map((r) => r.kind)).toEqual([]);
  });

  it("orders failed first, then pending by fire time, then sent", async () => {
    const sentAt = new Date().toISOString();
    const t = makeApi(async () =>
      snap({
        scheduledSends: [pending("late", "2030-01-02T10:00:00Z"), pending("early", "2030-01-01T10:00:00Z")],
        scheduledFailed: [{ id: "f", message: "m", fireAt: "2030-01-01T00:00:00Z", failureReason: "x" }],
        scheduledSent: [{ id: "p", message: "m", fireAt: sentAt, sentAt }],
      }),
    );
    const { result } = renderHook(() => useScheduledSends(t.api, "s1"));
    await waitFor(() => expect(result.current.rows).toHaveLength(4));
    expect(result.current.rows.map((r) => r.id)).toEqual(["f", "early", "late", "p"]);
  });

  it("excludes origin=immediate rows from rows and exposes them as immediateRows", async () => {
    const sentAt = new Date().toISOString();
    const t = makeApi(async () =>
      snap({
        scheduledSends: [pending("a", "2030-01-01T10:00:00Z"), pending("i1", "2030-01-01T10:00:00Z", { origin: "immediate" })],
        scheduledFailed: [
          { id: "f", message: "m", fireAt: sentAt, failureReason: "x" },
          { id: "i2", message: "m", fireAt: sentAt, failureReason: "x", origin: "immediate" },
        ],
        scheduledSent: [
          { id: "p", message: "m", fireAt: sentAt, sentAt },
          { id: "i3", message: "m", fireAt: sentAt, sentAt, origin: "immediate" },
        ],
      }),
    );
    const { result } = renderHook(() => useScheduledSends(t.api, "s1"));
    await waitFor(() => expect(result.current.rows.length).toBeGreaterThan(0));
    expect(result.current.rows.map((r) => r.id)).toEqual(["f", "a", "p"]);
    expect(result.current.immediateRows.map((r) => r.id)).toEqual(["i2", "i1", "i3"]);
  });

  it("hides a sent row on hideSent", async () => {
    const sentAt = new Date().toISOString();
    const t = makeApi(async () =>
      snap({
        scheduledSent: [
          { id: "p1", message: "m", fireAt: sentAt, sentAt },
          { id: "p2", message: "m", fireAt: sentAt, sentAt },
        ],
      }),
    );
    const { result } = renderHook(() => useScheduledSends(t.api, "s1"));
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    act(() => result.current.hideSent("p1"));
    expect(result.current.rows.map((r) => r.id)).toEqual(["p2"]);
  });

  it("auto-hides a sent row 10 minutes after sentAt", async () => {
    vi.useFakeTimers();
    const sentAt = new Date().toISOString();
    const t = makeApi(async () => snap({ scheduledSent: [{ id: "p", message: "m", fireAt: sentAt, sentAt }] }));
    const { result } = renderHook(() => useScheduledSends(t.api, "s1"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.rows).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(SENT_VISIBLE_MS + 1000);
    });
    expect(result.current.rows).toEqual([]);
  });

  it("shows the dev override instead of the fetched state", async () => {
    const t = makeApi(async () => snap({ scheduledSends: [pending("real", "2030-01-01T10:00:00Z")] }));
    const { result } = renderHook(() => useScheduledSends(t.api, "s1"));
    await waitFor(() => expect(result.current.rows.map((r) => r.id)).toEqual(["real"]));
    act(() =>
      useScheduleDevOverride.getState().set("s1", snap({ scheduledSends: [pending("sim", "2030-01-01T10:00:00Z", { phase: "waiting" })] })),
    );
    expect(result.current.rows.map((r) => r.id)).toEqual(["sim"]);
    act(() => useScheduleDevOverride.getState().clear("s1"));
    expect(result.current.rows.map((r) => r.id)).toEqual(["real"]);
  });
});
