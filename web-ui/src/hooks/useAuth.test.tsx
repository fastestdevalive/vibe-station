import { StrictMode, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "./useAuth";

type R = "authed" | "unauthenticated" | "unreachable";
const handlers = new Map<string, Set<() => void>>();
const checkAuthStatus = vi.fn<() => Promise<R>>();
vi.mock("@/api", () => ({
  api: {
    get checkAuthStatus() {
      return checkAuthStatus;
    },
    on: (ev: string, h: () => void) => {
      if (!handlers.has(ev)) handlers.set(ev, new Set());
      handlers.get(ev)!.add(h);
      return () => handlers.get(ev)!.delete(h);
    },
  },
}));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const flush = () => advance(0);
const emit = (name: string) => handlers.get(name)?.forEach((h) => h());

beforeEach(() => {
  vi.useFakeTimers();
  handlers.clear();
  checkAuthStatus.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mountWith(first: R) {
  checkAuthStatus.mockResolvedValueOnce(first);
  const hook = renderHook(() => useAuth());
  await flush();
  return hook;
}

describe("useAuth", () => {
  it("2.T1 unreachable at mount", async () => {
    const { result } = await mountWith("unreachable");
    expect(result.current).toMatchObject({ status: "unreachable", authed: false, loading: false });
  });

  it("2.T2 unreachable backoff 2,4,8,15,15 then heals", async () => {
    const { result } = await mountWith("unreachable");
    checkAuthStatus.mockResolvedValue("unreachable");
    expect(checkAuthStatus).toHaveBeenCalledTimes(1);
    for (const [wait, calls] of [[1999, 1], [1, 2], [3999, 2], [1, 3], [7999, 3], [1, 4], [14999, 4], [1, 5], [14999, 5], [1, 6]] as const) {
      await advance(wait);
      expect(checkAuthStatus).toHaveBeenCalledTimes(calls);
    }
    checkAuthStatus.mockResolvedValue("authed");
    await advance(15000);
    expect(result.current.authed).toBe(true);
  });

  it("2.T3 unauthenticated re-checks at 5s", async () => {
    const { result } = await mountWith("unauthenticated");
    expect(result.current.status).toBe("unauthenticated");
    checkAuthStatus.mockResolvedValue("unauthenticated");
    await advance(4999);
    expect(checkAuthStatus).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(checkAuthStatus).toHaveBeenCalledTimes(2);
  });

  describe("2.T4 event triggers", () => {
    const fire: Record<string, () => void> = {
      visibilitychange: () => document.dispatchEvent(new Event("visibilitychange")),
      focus: () => window.dispatchEvent(new Event("focus")),
      online: () => window.dispatchEvent(new Event("online")),
      pageshow: () => window.dispatchEvent(new Event("pageshow")),
    };
    it.each(Object.keys(fire))("%s heals unauthenticated", async (name) => {
      const { result } = await mountWith("unauthenticated");
      checkAuthStatus.mockResolvedValue("authed");
      await act(async () => fire[name]!());
      await flush();
      expect(result.current.authed).toBe(true);
    });

    it("hidden visibilitychange does not trigger", async () => {
      await mountWith("unauthenticated");
      const spy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      await act(async () => fire.visibilitychange!());
      expect(checkAuthStatus).toHaveBeenCalledTimes(1);
      spy.mockReturnValue("visible");
      await act(async () => fire.visibilitychange!());
      expect(checkAuthStatus).toHaveBeenCalledTimes(2);
    });
  });

  it("2.T5 overlap: pending check + focus => one call", async () => {
    const d = deferred<R>();
    checkAuthStatus.mockReturnValueOnce(d.promise);
    renderHook(() => useAuth());
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(checkAuthStatus).toHaveBeenCalledTimes(1);
    d.resolve("authed");
  });

  it("2.T6 unmount cleans timers and listeners", async () => {
    const docRemove = vi.spyOn(document, "removeEventListener");
    const winRemove = vi.spyOn(window, "removeEventListener");
    const { unmount } = await mountWith("unreachable");
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(docRemove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    for (const ev of ["focus", "online", "pageshow"]) {
      expect(winRemove).toHaveBeenCalledWith(ev, expect.any(Function));
    }
    window.dispatchEvent(new Event("focus"));
    await advance(60_000);
    expect(checkAuthStatus).toHaveBeenCalledTimes(1);
  });

  it("2.T6b status -> authed stops timers and listeners", async () => {
    await mountWith("unreachable");
    checkAuthStatus.mockResolvedValue("authed");
    await advance(2000);
    expect(vi.getTimerCount()).toBe(0);
    const calls = checkAuthStatus.mock.calls.length;
    window.dispatchEvent(new Event("focus"));
    await advance(60_000);
    expect(checkAuthStatus).toHaveBeenCalledTimes(calls);
  });

  it("2.T7 StrictMode: exactly one mount-time check, result applied", async () => {
    checkAuthStatus.mockResolvedValue("authed");
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { result } = renderHook(() => useAuth(), { wrapper });
    await flush();
    expect(checkAuthStatus).toHaveBeenCalledTimes(1);
    expect(result.current.authed).toBe(true);
  });

  it("2.T8 authed: no further checks; auth:expired -> unauthenticated", async () => {
    const { result } = await mountWith("authed");
    window.dispatchEvent(new Event("focus"));
    emit("ws:open");
    await advance(60_000);
    expect(checkAuthStatus).toHaveBeenCalledTimes(1);
    act(() => emit("auth:expired"));
    expect(result.current.status).toBe("unauthenticated");
  });

  it("2.T9 a late unreachable result never leaves authed", async () => {
    const d = deferred<R>();
    checkAuthStatus.mockReturnValueOnce(d.promise);
    const { result } = renderHook(() => useAuth());
    act(() => result.current.onLoginSuccess());
    expect(result.current.status).toBe("authed");
    d.resolve("unreachable");
    await flush();
    expect(result.current.status).toBe("authed");
  });

  it("2.T10 throwing checkAuthStatus -> unreachable, not stuck loading", async () => {
    checkAuthStatus.mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useAuth());
    await flush();
    expect(result.current.status).toBe("unreachable");
  });
});
