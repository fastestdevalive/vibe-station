import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BakeRequest, BakeResponse } from "./protocol";
import { __resetBakeClientForTests, bake, bakeSize, type BakeInput } from "./bakeClient";

const { fetchBlobMock } = vi.hoisted(() => ({
  fetchBlobMock: vi.fn<(id: string, size: string) => Promise<Blob>>(),
}));

vi.mock("../wallpaperApi", () => ({ fetchWallpaperBlob: fetchBlobMock }));

class FakeWorker {
  static instances: FakeWorker[] = [];

  onmessage: ((event: MessageEvent<BakeResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: BakeRequest[] = [];
  postMessage = vi.fn((message: BakeRequest): void => {
    this.posted.push(message);
  });
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(response: BakeResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<BakeResponse>);
  }
}

const bitmap = { width: 800, height: 1200, close: vi.fn() };
const drawImage = vi.fn();

const INPUT: BakeInput = {
  id: "wp-007",
  sha: null,
  texture: "dither",
  appearance: "dark",
  width: 1280,
  height: 800,
};

function lastWorker(): FakeWorker {
  const worker = FakeWorker.instances[FakeWorker.instances.length - 1];
  if (worker === undefined) throw new Error("no worker was created");
  return worker;
}

beforeEach(() => {
  __resetBakeClientForTests();
  FakeWorker.instances = [];
  drawImage.mockReset();
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => bitmap as unknown as ImageBitmap),
  );
  // The global setup stubs a null 2d context (jsdom has none); the crop needs one.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
  } as unknown as CanvasRenderingContext2D);
  fetchBlobMock.mockReset();
  fetchBlobMock.mockImplementation(async () => new Blob(["source"]));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  __resetBakeClientForTests();
});

describe("bakeSize", () => {
  it("keeps the box's aspect ratio", () => {
    // No rounding: an aspect-changing bake is what made the picture jump when
    // the baked layer replaced the plain one.
    expect(bakeSize(1280, 800)).toEqual({ width: 1280, height: 800 });
    expect(bakeSize(1280, 832)).toEqual({ width: 1280, height: 832 });
    expect(bakeSize(2880, 1800)).toEqual({ width: 1920, height: 1200 });
  });

  it("caps the long side at 1920 px, ratio preserved", () => {
    const size = bakeSize(2560, 1440);

    expect(size).toEqual({ width: 1920, height: 1080 });
  });

  it("a box under the cap is left exactly as measured", () => {
    expect(bakeSize(780, 1688)).toEqual({ width: 780, height: 1688 });
  });

  it("a capped portrait box keeps its ratio within a pixel", () => {
    const size = bakeSize(1000, 3000);

    expect(Math.max(size.width, size.height)).toBe(1920);
    expect(Math.abs(size.width / size.height - 1000 / 3000)).toBeLessThan(1 / 1920);
  });
});

describe("bake", () => {
  it("dedupes identical in-flight", async () => {
    const first = bake(INPUT);
    const second = bake(INPUT);

    expect(first).toBe(second);
    await vi.waitFor(() => expect(lastWorker().posted.length).toBe(1));

    const request = lastWorker().posted[0]!;
    lastWorker().respond({ reqId: request.reqId, ok: true, blob: new Blob(["baked"]) });

    await expect(first).resolves.toBeInstanceOf(Blob);
    expect(fetchBlobMock).toHaveBeenCalledTimes(1);
    // Intensity is the layer's opacity, never a worker input (R7F-02).
    expect(request).not.toHaveProperty("intensity");
  });

  it("rejects on timeout", async () => {
    vi.useFakeTimers();

    const pending = bake(INPUT);
    const check = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(30_000);

    await check;
  });

  it("rejects on error response", async () => {
    const pending = bake(INPUT);
    await vi.waitFor(() => expect(lastWorker().posted.length).toBe(1));

    const request = lastWorker().posted[0]!;
    lastWorker().respond({ reqId: request.reqId, ok: false, error: "drawer exploded" });

    await expect(pending).rejects.toThrow("drawer exploded");
  });

  it("forgets the dedupe entry after a failure so a retry re-bakes", async () => {
    const failed = bake(INPUT);
    await vi.waitFor(() => expect(lastWorker().posted.length).toBe(1));
    lastWorker().respond({ reqId: lastWorker().posted[0]!.reqId, ok: false, error: "boom" });
    await expect(failed).rejects.toThrow("boom");

    const retried = bake(INPUT);
    expect(retried).not.toBe(failed);
    await vi.waitFor(() => expect(lastWorker().posted.length).toBe(2));
  });

  it("posts the bitmap as a transferable", async () => {
    bake(INPUT);
    await vi.waitFor(() => expect(lastWorker().posted.length).toBe(1));
    expect(lastWorker().postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ reqId: expect.any(Number) }),
      [bitmap],
    );
  });

  it("a worker that never answers is terminated and replaced", async () => {
    vi.useFakeTimers();

    const pending = bake(INPUT);
    const check = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(FakeWorker.instances.length).toBe(1));
    const first = lastWorker();

    await vi.advanceTimersByTimeAsync(30_000);
    await check;

    expect(first.terminated).toBe(true);

    const secondPending = bake(INPUT);
    await vi.waitFor(() => expect(FakeWorker.instances.length).toBe(2));
    expect(lastWorker()).not.toBe(first);

    const checkSecond = expect(secondPending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30_000);
    await checkSecond;
  });
});
