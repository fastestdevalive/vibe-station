import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLimits, useLimitsStore, __resetLimitsBootForTests } from "./useLimits";
import type { LimitSlotRef, LimitsSnapshot } from "@/api/types";
import type { WSEvent } from "@/api/types";

type AnyHandler = (ev: WSEvent) => void;
const handlers = new Map<string, Set<AnyHandler>>();

const getLimits = vi.fn<() => Promise<LimitsSnapshot>>();
const refreshLimits = vi.fn<() => Promise<{ started: boolean; retryAfterSecs: number | null; snapshot: LimitsSnapshot }>>();
const setLimitSlots = vi.fn<(slots: [LimitSlotRef, LimitSlotRef]) => Promise<LimitsSnapshot>>();

vi.mock("@/api", () => ({
  api: {
    get getLimits() {
      return getLimits;
    },
    get refreshLimits() {
      return refreshLimits;
    },
    get setLimitSlots() {
      return setLimitSlots;
    },
    on: (ev: string, h: AnyHandler) => {
      if (!handlers.has(ev)) handlers.set(ev, new Set());
      handlers.get(ev)!.add(h);
      return () => handlers.get(ev)!.delete(h);
    },
  },
}));

const SLOTS: [LimitSlotRef, LimitSlotRef] = [
  { harness: "claude", windowId: "five_hour" },
  { harness: "claude", windowId: "seven_day" },
];

function snapshot(over: Partial<LimitsSnapshot> = {}): LimitsSnapshot {
  return {
    host: "test-host",
    slots: SLOTS,
    harnesses: [
      {
        harness: "claude",
        status: "ok",
        message: null,
        asOf: new Date().toISOString(),
        windows: [
          { harness: "claude", windowId: "five_hour", cadenceMinutes: 300, usedPct: 42, resetsAt: null, asOf: new Date().toISOString(), status: "ok" },
        ],
      },
    ],
    ...over,
  };
}

const SNAPSHOT = snapshot();

const flush = () =>
  act(async () => {
    await Promise.resolve();
  });
const emit = (ev: WSEvent) => handlers.get(ev.type)?.forEach((h) => h(ev));
const emitWsOpen = () => handlers.get("ws:open")?.forEach((h) => h({ type: "ws:open" } as WSEvent));

beforeEach(() => {
  handlers.clear();
  getLimits.mockReset();
  refreshLimits.mockReset();
  setLimitSlots.mockReset();
  __resetLimitsBootForTests();
});

afterEach(() => {
  __resetLimitsBootForTests();
});

describe("useLimits", () => {
  it("boot fetches once and applies snapshot", async () => {
    getLimits.mockResolvedValue(SNAPSHOT);
    const { result } = renderHook(() => useLimits());
    await flush();
    expect(getLimits).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot).toEqual(SNAPSHOT);
    expect(result.current.slots).toEqual(SLOTS);
  });

  it("limits:updated replaces snapshot", async () => {
    getLimits.mockResolvedValue(SNAPSHOT);
    renderHook(() => useLimits());
    await flush();
    const next = snapshot({ host: "other-host" });
    act(() => emit({ type: "limits:updated", limits: next }));
    expect(useLimitsStore.getState().snapshot).toEqual(next);
  });

  it("ws:open refetches", async () => {
    getLimits.mockResolvedValue(SNAPSHOT);
    renderHook(() => useLimits());
    await flush();
    expect(getLimits).toHaveBeenCalledTimes(1);
    act(() => emitWsOpen());
    await flush();
    expect(getLimits).toHaveBeenCalledTimes(2);
  });

  it("assignSlot is optimistic then PUTs, applying the server snapshot", async () => {
    getLimits.mockResolvedValue(SNAPSHOT);
    const picked: LimitSlotRef = { harness: "codex", windowId: "primary" };
    const serverSnap = snapshot({ slots: [SLOTS[0], picked] });
    setLimitSlots.mockResolvedValue(serverSnap);
    const { result } = renderHook(() => useLimits());
    await flush();

    const promise = result.current.assignSlot(1, picked);
    // Optimistic: slots updated before the PUT resolves
    expect(useLimitsStore.getState().snapshot?.slots[1]).toEqual(picked);
    await act(async () => await promise);
    expect(setLimitSlots).toHaveBeenCalledWith([SLOTS[0], picked]);
    expect(useLimitsStore.getState().snapshot).toEqual(serverSnap);
  });

  it("assignSlot reverts and sets error on PUT rejection", async () => {
    getLimits.mockResolvedValue(SNAPSHOT);
    setLimitSlots.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useLimits());
    await flush();

    const picked: LimitSlotRef = { harness: "codex", windowId: "primary" };
    await act(async () => await result.current.assignSlot(1, picked));
    expect(useLimitsStore.getState().snapshot).toEqual(SNAPSHOT);
    expect(useLimitsStore.getState().error).toBeTruthy();
  });

  it("refresh sets cooldownUntil when started:false", async () => {
    getLimits.mockResolvedValue(SNAPSHOT);
    refreshLimits.mockResolvedValue({ started: false, retryAfterSecs: 30, snapshot: SNAPSHOT });
    const { result } = renderHook(() => useLimits());
    await flush();

    await act(async () => await result.current.refresh());
    expect(refreshLimits).toHaveBeenCalledTimes(1);
    const cooldown = useLimitsStore.getState().cooldownUntil;
    expect(cooldown).toBeGreaterThan(Date.now());
    expect(cooldown).toBeLessThanOrEqual(Date.now() + 30_000);
  });

  it("registers no timers", async () => {
    vi.useFakeTimers();
    getLimits.mockResolvedValue(SNAPSHOT);
    renderHook(() => useLimits());
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
