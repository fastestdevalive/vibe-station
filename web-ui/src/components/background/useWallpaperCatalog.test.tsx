import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WallpaperCatalogResponse } from "@/api/types";
import { __resetWallpaperCatalogForTests, useWallpaperCatalog } from "./useWallpaperCatalog";

const { fetchCatalogMock } = vi.hoisted(() => ({
  fetchCatalogMock: vi.fn<() => Promise<WallpaperCatalogResponse>>(),
}));

vi.mock("./wallpaperApi", () => ({ fetchWallpaperCatalog: fetchCatalogMock }));

function catalogOf(...ids: string[]): WallpaperCatalogResponse {
  return {
    version: 1,
    wallpapers: ids.map((id) => ({
      id,
      name: id,
      category: "places",
      mode: "any",
      url: `https://images.rawpixel.com/${id}.jpg`,
      thumbnailUrl: `https://images.rawpixel.com/${id}.jpg`,
      width: 683,
      height: 1024,
    })),
  };
}

/** Let the pending promise chain settle and the resulting state update flush. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  fetchCatalogMock.mockReset();
  __resetWallpaperCatalogForTests();
});

afterEach(() => {
  vi.useRealTimers();
  __resetWallpaperCatalogForTests();
});

describe("useWallpaperCatalog", () => {
  it("fetches once for two hooks", async () => {
    fetchCatalogMock.mockResolvedValue(catalogOf("wp-001", "wp-002"));
    const a = renderHook(() => useWallpaperCatalog());
    const b = renderHook(() => useWallpaperCatalog());
    await waitFor(() => expect(a.result.current.status).toBe("ready"));
    await waitFor(() => expect(b.result.current.status).toBe("ready"));
    expect(fetchCatalogMock).toHaveBeenCalledTimes(1);
    expect(a.result.current.wallpapers).toHaveLength(2);
  });

  it("unavailable after retries", async () => {
    vi.useFakeTimers();
    fetchCatalogMock.mockRejectedValue(new Error("daemon unreachable"));
    const hook = renderHook(() => useWallpaperCatalog());
    const { result } = hook;

    // Initial fetch fails -> retry scheduled at +2s.
    await settle();
    expect(result.current.status).toBe("loading");
    expect(fetchCatalogMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchCatalogMock).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("loading");

    await act(async () => {
      vi.advanceTimersByTime(8_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchCatalogMock).toHaveBeenCalledTimes(3);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchCatalogMock).toHaveBeenCalledTimes(4);
    expect(result.current.status).toBe("unavailable");
    expect(result.current.ids).toEqual([]);

    // Fast retries stopped: no call before the slow 60s timer.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(fetchCatalogMock).toHaveBeenCalledTimes(4);

    // Unmounting clears the slow retry timer: no polling when unsubscribed.
    hook.unmount();
    await act(async () => {
      vi.advanceTimersByTime(120_000);
      await Promise.resolve();
    });
    expect(fetchCatalogMock).toHaveBeenCalledTimes(4);
  });

  it("a malformed 200 body exhausts the budget instead of polling forever", async () => {
    vi.useFakeTimers();
    // The hook must survive a resolved-but-unusable body too: building `ready`
    // throws inside `.then`, and the attempt counter has to keep counting.
    fetchCatalogMock.mockResolvedValue({ nope: 1 } as unknown as WallpaperCatalogResponse);
    const hook = renderHook(() => useWallpaperCatalog());
    const { result } = hook;

    await settle();
    expect(result.current.status).toBe("loading");
    expect(fetchCatalogMock).toHaveBeenCalledTimes(1);

    for (const delay of [2_000, 8_000, 30_000]) {
      await act(async () => {
        vi.advanceTimersByTime(delay);
        for (let i = 0; i < 4; i += 1) await Promise.resolve();
      });
    }
    expect(fetchCatalogMock).toHaveBeenCalledTimes(4);
    expect(result.current.status).toBe("unavailable");
    expect(result.current.ids).toEqual([]);

    // Fast retries stopped: no call before the slow 60s timer.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(fetchCatalogMock).toHaveBeenCalledTimes(4);

    // Unmounting clears the slow retry timer: no polling when unsubscribed.
    hook.unmount();
    await act(async () => {
      vi.advanceTimersByTime(120_000);
      await Promise.resolve();
    });
    expect(fetchCatalogMock).toHaveBeenCalledTimes(4);
  });

  it("recovers after unavailable", async () => {
    vi.useFakeTimers();
    fetchCatalogMock.mockRejectedValue(new Error("daemon unreachable"));
    const { result } = renderHook(() => useWallpaperCatalog());

    await settle();
    expect(fetchCatalogMock).toHaveBeenCalledTimes(1);

    for (const delay of [2_000, 8_000, 30_000]) {
      await act(async () => {
        vi.advanceTimersByTime(delay);
        for (let i = 0; i < 4; i += 1) await Promise.resolve();
      });
    }
    expect(fetchCatalogMock).toHaveBeenCalledTimes(4);
    expect(result.current.status).toBe("unavailable");

    fetchCatalogMock.mockResolvedValue(catalogOf("wp-001", "wp-002"));

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });

    expect(fetchCatalogMock).toHaveBeenCalledTimes(5);
    expect(result.current.status).toBe("ready");
    expect(result.current.ids).toEqual(["wp-001", "wp-002"]);
  });

  it("ready exposes ids in order", async () => {
    fetchCatalogMock.mockResolvedValue(catalogOf("wp-001", "wp-002", "wp-003"));
    const { result } = renderHook(() => useWallpaperCatalog());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.ids).toEqual(["wp-001", "wp-002", "wp-003"]);
  });
});
