import { renderHook, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ApiInstance } from "@/api";
import type { UpdateCheckResponse, UpdateStatus } from "@/api/types";
import { useUpdateStore } from "./useUpdateStore";
import { useUpdateSync } from "./useUpdateSync";

vi.mock("@/api/update", () => ({ fetchUpdateStatus: vi.fn() }));
import { fetchUpdateStatus } from "@/api/update";

function status(over: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    current: "1.0.0",
    behindCount: 0,
    updateAvailable: false,
    skipped: [],
    installMethod: "curl",
    targets: [],
    autoCheck: true,
    platform: "linux-x86_64",
    noAsset: false,
    ...over,
  };
}

function makeApi(initialHealth = { ok: true, port: 1234, version: "1.0.0", bootId: "boot-1" }) {
  const handlers = new Map<string, Array<(ev: unknown) => void>>();
  const api = {
    health: vi.fn().mockResolvedValue(initialHealth),
    on: vi.fn((type: string, h: (ev: unknown) => void) => {
      handlers.set(type, [...(handlers.get(type) ?? []), h]);
      return () => {};
    }),
  };
  const emit = (type: string, ev: unknown) => handlers.get(type)?.forEach((h) => h(ev));
  return { api: api as unknown as ApiInstance, emit };
}

beforeEach(() => {
  vi.clearAllMocks();
  useUpdateStore.setState({ status: null, canInstall: false });
});

describe("useUpdateSync", () => {
  it("fetches on mount and on ws:open", async () => {
    vi.mocked(fetchUpdateStatus).mockResolvedValue({ ...status(), canInstall: true } as UpdateCheckResponse);
    const { api, emit } = makeApi();
    renderHook(() => useUpdateSync(api));
    await waitFor(() => expect(useUpdateStore.getState().status?.current).toBe("1.0.0"));
    expect(useUpdateStore.getState().canInstall).toBe(true);
    expect(fetchUpdateStatus).toHaveBeenCalledTimes(1);
    emit("ws:open", { type: "ws:open" });
    expect(fetchUpdateStatus).toHaveBeenCalledTimes(2);
  });

  it("update:changed replaces (does not merge) the snapshot", async () => {
    vi.mocked(fetchUpdateStatus).mockResolvedValue({
      ...status({ latest: "2.0.0", changelog: "old notes", updateAvailable: true }),
      canInstall: true,
    } as UpdateCheckResponse);
    const { api, emit } = makeApi();
    renderHook(() => useUpdateSync(api));
    await waitFor(() => expect(useUpdateStore.getState().status?.latest).toBe("2.0.0"));
    emit("update:changed", { type: "update:changed", status: status({ current: "2.0.0" }) });
    const s = useUpdateStore.getState().status!;
    expect(s.current).toBe("2.0.0");
    expect(s.latest).toBeUndefined();
    expect(s.changelog).toBeUndefined();
  });

  it("leaves the store unchanged when the fetch fails", async () => {
    useUpdateStore.setState({ status: status({ current: "9.9.9" }) });
    vi.mocked(fetchUpdateStatus).mockRejectedValue(new Error("boom"));
    const { api } = makeApi();
    renderHook(() => useUpdateSync(api));
    await waitFor(() => expect(fetchUpdateStatus).toHaveBeenCalled());
    expect(useUpdateStore.getState().status?.current).toBe("9.9.9");
  });

  it("ws:open with a changed /health.version calls location.reload and sets vst:restartedAt", async () => {
    const originalLocation = window.location;
    sessionStorage.clear();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload: vi.fn() },
    });

    try {
      vi.mocked(fetchUpdateStatus).mockResolvedValue({ ...status(), canInstall: true } as UpdateCheckResponse);
      const { api, emit } = makeApi();
      renderHook(() => useUpdateSync(api));

      // Wait for initial health to resolve and record initialVersion ("1.0.0")
      await waitFor(() => expect(api.health).toHaveBeenCalled());

      // Subsequent health call returns new version "1.0.1"
      vi.mocked(api.health).mockResolvedValue({
        ok: true,
        port: 1234,
        version: "1.0.1",
        bootId: "boot-2",
      });

      // Fire ws:open which calls refresh() and re-checks health
      emit("ws:open", { type: "ws:open" });

      await waitFor(() => expect(window.location.reload).toHaveBeenCalledTimes(1));
      expect(sessionStorage.getItem("vst:restartedAt")).not.toBeNull();
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it("a failed first /health does not disable the version reload; baselines refresh on later successes", async () => {
    const originalLocation = window.location;
    sessionStorage.clear();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload: vi.fn() },
    });
    try {
      vi.mocked(fetchUpdateStatus).mockResolvedValue({ ...status(), canInstall: true } as UpdateCheckResponse);
      const { api, emit } = makeApi();
      vi.mocked(api.health)
        .mockRejectedValueOnce(new Error("down"))
        .mockResolvedValue({ ok: true, port: 1234, version: "1.0.0", bootId: "b1" });
      useUpdateStore.setState({ loadBootId: null, restarting: false });
      renderHook(() => useUpdateSync(api));
      await waitFor(() => expect(api.health).toHaveBeenCalledTimes(1));
      expect(useUpdateStore.getState().loadBootId).toBeNull();

      emit("ws:open", { type: "ws:open" });
      await waitFor(() => expect(useUpdateStore.getState().loadBootId).toBe("b1"));
      expect(window.location.reload).not.toHaveBeenCalled();

      vi.mocked(api.health).mockResolvedValue({ ok: true, port: 1234, version: "1.1.0", bootId: "b2" });
      emit("ws:open", { type: "ws:open" });
      await waitFor(() => expect(window.location.reload).toHaveBeenCalledTimes(1));
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    }
  });

  it("a same-version restart missed by this tab refreshes loadBootId (not while restarting)", async () => {
    vi.mocked(fetchUpdateStatus).mockResolvedValue({ ...status(), canInstall: true } as UpdateCheckResponse);
    const { api, emit } = makeApi();
    useUpdateStore.setState({ loadBootId: null, restarting: false });
    renderHook(() => useUpdateSync(api));
    await waitFor(() => expect(useUpdateStore.getState().loadBootId).toBe("boot-1"));

    vi.mocked(api.health).mockResolvedValue({ ok: true, port: 1234, version: "1.0.0", bootId: "boot-2" });
    emit("ws:open", { type: "ws:open" });
    await waitFor(() => expect(useUpdateStore.getState().loadBootId).toBe("boot-2"));

    useUpdateStore.setState({ restarting: true });
    vi.mocked(api.health).mockResolvedValue({ ok: true, port: 1234, version: "1.0.0", bootId: "boot-3" });
    emit("ws:open", { type: "ws:open" });
    await waitFor(() => expect(api.health).toHaveBeenCalledTimes(3));
    expect(useUpdateStore.getState().loadBootId).toBe("boot-2");
  });
});
