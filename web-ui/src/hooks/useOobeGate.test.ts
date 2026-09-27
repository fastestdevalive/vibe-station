import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useOobeGate } from "./useOobeGate";
import type { OobeState } from "@/api/types";

interface TestApi {
  getOobeState: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeApi() {
  const handlers: Array<(ev: unknown) => void> = [];
  const api: TestApi = {
    getOobeState: vi.fn(),
    on: vi.fn((_type: string, handler: (ev: unknown) => void) => {
      handlers.push(handler);
      return () => {};
    }),
  };
  const emit = (ev: unknown) => handlers.forEach((h) => h(ev));
  return { api, emit };
}

describe("useOobeGate", () => {
  it("4.T1 — enabled:false is a no-op; enabling mid-flight surfaces loading without a one-render flash; WS event flips completed without refetch", async () => {
    const { api, emit } = makeApi();
    const d = deferred<OobeState>();
    api.getOobeState.mockReturnValue(d.promise);

    const { result, rerender } = renderHook(
      ({ enabled }) => useOobeGate(api as never, { enabled }),
      { initialProps: { enabled: false } },
    );

    // enabled:false — inert: no fetch, no subscription, completed-state default.
    expect(api.getOobeState).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.completed).toBe(true);

    // Enable mid-test with the fetch still pending. The return value from THIS
    // rerender must already read loading:true — this is the exact render where
    // a stale `useState(opts.enabled)` initializer would have flashed loading:false.
    rerender({ enabled: true });
    expect(result.current.loading).toBe(true);
    expect(api.getOobeState).toHaveBeenCalledTimes(1);

    // Resolve the fetch.
    await act(async () => {
      d.resolve({ completed: false, currentStep: 1, defaultProjectsDir: "/x", vstHome: "/x/.vibe-station" });
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.completed).toBe(false);
    expect(result.current.currentStep).toBe(1);
    expect(result.current.defaultProjectsDir).toBe("/x");

    // A DIFFERENT tab completing OOBE broadcasts oobe:state-updated — this hook
    // flips completed WITHOUT re-fetching.
    act(() => {
      emit({ type: "oobe:state-updated", completed: true });
    });
    expect(result.current.completed).toBe(true);
    expect(api.getOobeState).toHaveBeenCalledTimes(1);
  });

  it("markStep1Confirmed sets currentStep 2 + defaultProjectsDir from the caller-supplied value, no refetch", async () => {
    const { api } = makeApi();
    api.getOobeState.mockResolvedValue({
      completed: false,
      currentStep: 1,
      defaultProjectsDir: "/initial",
      vstHome: "/initial/.vibe-station",
    } as OobeState);

    const { result } = renderHook(() => useOobeGate(api as never, { enabled: true }));
    await act(async () => {});

    act(() => {
      result.current.markStep1Confirmed("/confirmed");
    });
    expect(result.current.currentStep).toBe(2);
    expect(result.current.defaultProjectsDir).toBe("/confirmed");
    expect(api.getOobeState).toHaveBeenCalledTimes(1);
  });

  it("a rejected getOobeState() fails open (completed:true) instead of leaving loading stuck forever", async () => {
    const { api } = makeApi();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    api.getOobeState.mockRejectedValue(new Error("network error"));

    const { result } = renderHook(() => useOobeGate(api as never, { enabled: true }));
    expect(result.current.loading).toBe(true);

    await act(async () => {});

    expect(result.current.loading).toBe(false);
    expect(result.current.completed).toBe(true);
    consoleErrorSpy.mockRestore();
  });

  it("markCompleted sets completed true directly", async () => {
    const { api } = makeApi();
    api.getOobeState.mockResolvedValue({
      completed: false,
      currentStep: 2,
      defaultProjectsDir: "/initial",
      vstHome: "/initial/.vibe-station",
    } as OobeState);

    const { result } = renderHook(() => useOobeGate(api as never, { enabled: true }));
    await act(async () => {});
    expect(result.current.completed).toBe(false);

    act(() => {
      result.current.markCompleted();
    });
    expect(result.current.completed).toBe(true);
  });
});
