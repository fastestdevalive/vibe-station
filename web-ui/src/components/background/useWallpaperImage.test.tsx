import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { thumbUrl } from "./thumbs";
import {
  loadFullWallpaperBlob,
  useWallpaperImage,
  __resetWallpaperImageForTests,
} from "./useWallpaperImage";

const { fetchBlobMock } = vi.hoisted(() => ({
  fetchBlobMock: vi.fn<(id: string, size: string) => Promise<Blob>>(),
}));

vi.mock("./wallpaperApi", () => ({ fetchWallpaperBlob: fetchBlobMock }));

beforeEach(() => {
  __resetWallpaperImageForTests();
  fetchBlobMock.mockReset();
});

afterEach(() => {
  __resetWallpaperImageForTests();
  vi.restoreAllMocks();
});

describe("useWallpaperImage", () => {
  it("object url after fetch, marked as the full image", async () => {
    fetchBlobMock.mockResolvedValue(new Blob(["jpeg"]));

    const { result } = renderHook(() => useWallpaperImage("wp-001"));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.src).toMatch(/^blob:/);
    expect(result.current.isThumb).toBe(false);
  });

  it("thumb while loading and on failure", async () => {
    fetchBlobMock.mockImplementation(() => new Promise<Blob>(() => {}));

    const pending = renderHook(() => useWallpaperImage("wp-001"));
    expect(pending.result.current.status).toBe("loading");
    expect(pending.result.current.src).toBe(thumbUrl("wp-001"));
    expect(pending.result.current.isThumb).toBe(true);
    pending.unmount();

    __resetWallpaperImageForTests();
    fetchBlobMock.mockRejectedValue(new Error("502"));

    const failed = renderHook(() => useWallpaperImage("wp-001"));
    await waitFor(() => expect(failed.result.current.status).toBe("failed"));
    expect(failed.result.current.src).toBe(thumbUrl("wp-001"));
    expect(failed.result.current.isThumb).toBe(true);
  });

  it("switching back to a cached image is ready on the first render (no thumb step, R6F-03)", async () => {
    fetchBlobMock.mockImplementation(async () => new Blob([String(fetchBlobMock.mock.calls.length)]));

    const { result, rerender } = renderHook(({ id }) => useWallpaperImage(id), {
      initialProps: { id: "wp-001" },
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const first = result.current.src;

    rerender({ id: "wp-002" });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    rerender({ id: "wp-001" });

    // Synchronously after the switch back: the decoded full image, never the thumb.
    expect(result.current).toEqual({ src: first, status: "ready", isThumb: false });
    expect(fetchBlobMock).toHaveBeenCalledTimes(2);
  });

  it("never revokes a full image: the memory tier owns it", async () => {
    fetchBlobMock.mockResolvedValue(new Blob(["jpeg"]));
    const revoke = vi.spyOn(URL, "revokeObjectURL");

    const { result, rerender, unmount } = renderHook(({ id }) => useWallpaperImage(id), {
      initialProps: { id: "wp-001" },
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const first = result.current.src;

    rerender({ id: "wp-002" });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    unmount();

    expect(revoke).not.toHaveBeenCalledWith(first);
  });

  it("two callers share one request", async () => {
    fetchBlobMock.mockImplementation(() => new Promise<Blob>(() => {}));

    const a = renderHook(() => useWallpaperImage("wp-001"));
    const b = renderHook(() => useWallpaperImage("wp-001"));

    expect(fetchBlobMock).toHaveBeenCalledTimes(1);
    a.unmount();
    b.unmount();
  });

  it("the bake and the window share one full-image request", async () => {
    fetchBlobMock.mockImplementation(() => new Promise<Blob>(() => {}));

    const hook = renderHook(() => useWallpaperImage("wp-001"));
    void loadFullWallpaperBlob("wp-001");

    expect(fetchBlobMock).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it("null id stays idle and fetches nothing", () => {
    const { result } = renderHook(() => useWallpaperImage(null));
    expect(result.current).toEqual({ src: null, status: "idle", isThumb: false });
    expect(fetchBlobMock).not.toHaveBeenCalled();
  });
});
