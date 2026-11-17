import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock, baseUrlMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
  baseUrlMock: vi.fn(() => "/api"),
}));

vi.mock("@/api/client", () => ({
  baseUrl: baseUrlMock,
  apiFetch: apiFetchMock,
}));

import { fetchWallpaperBlob, fetchWallpaperCatalog, wallpaperImageUrl } from "./wallpaperApi";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  apiFetchMock.mockReset();
  baseUrlMock.mockClear();
});

describe("wallpaperApi", () => {
  it("builds image url with encoded id and size", () => {
    expect(wallpaperImageUrl("wp 1/../x", "thumb")).toBe(
      "/api/wallpapers/wp%201%2F..%2Fx/image?size=thumb",
    );
    expect(wallpaperImageUrl("wp-001", "full")).toBe("/api/wallpapers/wp-001/image?size=full");
  });

  it("throws on non-2xx", async () => {
    apiFetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(fetchWallpaperCatalog()).rejects.toThrow(/status 500/);
    await expect(fetchWallpaperBlob("wp-001", "full")).rejects.toThrow(/status 500/);
  });

  it("fetchWallpaperBlob goes through apiFetch", async () => {
    apiFetchMock.mockResolvedValue(
      new Response("bytes", { status: 200, headers: { "content-type": "image/jpeg" } }),
    );
    const controller = new AbortController();
    // Not `toBeInstanceOf(Blob)`: a Response's blob comes from the runtime's own Blob class, which
    // differs from jsdom's global on some Node versions, so check its size and type instead.
    const result = await fetchWallpaperBlob("wp-001", "full", controller.signal);
    expect(result.size).toBe(5);
    expect(result.type).toBe("image/jpeg");
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe("/api/wallpapers/wp-001/image?size=full");
    expect(apiFetchMock.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
  });

  it("fetchWallpaperCatalog returns the parsed catalog body", async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse(200, { version: 1, wallpapers: [{ id: "wp-001" }] }),
    );
    const catalog = await fetchWallpaperCatalog();
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe("/api/wallpapers");
    expect(catalog.version).toBe(1);
    expect(catalog.wallpapers.map((w) => w.id)).toEqual(["wp-001"]);
  });

  it("rejects a 200 whose body has no wallpapers array", async () => {
    apiFetchMock.mockResolvedValue(jsonResponse(200, { nope: 1 }));
    await expect(fetchWallpaperCatalog()).rejects.toThrow(/malformed/);
  });

  it("keeps the good entries and drops ones without a usable id", async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse(200, {
        version: 1,
        wallpapers: [{ id: "wp-001" }, { id: "" }, { name: "no id" }, null],
      }),
    );
    const catalog = await fetchWallpaperCatalog();
    expect(catalog.wallpapers.map((w) => w.id)).toEqual(["wp-001"]);
  });
});
