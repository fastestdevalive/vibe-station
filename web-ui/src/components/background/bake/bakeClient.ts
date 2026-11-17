import type { BakeRequest, BakeResponse, BakedTextureId } from "./protocol";
import { bakeKey } from "./bakeKey";
import { putBaked } from "./bakeCache";
import { FOCAL_Y } from "../focal";
import { loadFullWallpaperBlob } from "../useWallpaperImage";

/**
 * The one client of the bake worker: it owns the worker singleton, the in-flight
 * dedupe, the request timeout and the cache write. The worker is the only place
 * pixels are drawn (the crop below is a browser primitive, not a drawer).
 */
export interface BakeInput {
  id: string;
  sha?: string | null;
  texture: BakedTextureId;
  appearance: "dark" | "light";
  /** Device pixels of the box the effect fills (before rounding/capping). */
  width: number;
  height: number;
}

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_LONG_SIDE = 1920;

/**
 * The bake must have the window's aspect ratio, or `object-fit: cover` re-crops
 * it and the picture jumps when it replaces the plain layer; resize re-bakes are
 * already debounced (500 ms), so exact sizes do not churn the cache.
 *
 * Capped at 1920 px on the long side (deterministic across windows).
 */
export function bakeSize(width: number, height: number): { width: number; height: number } {
  const w = Number.isFinite(width) ? Math.max(0, width) : 0;
  const h = Number.isFinite(height) ? Math.max(0, height) : 0;
  const scale = Math.min(1, MAX_LONG_SIDE / Math.max(w, h, 1));
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

interface PendingRequest {
  resolve: (blob: Blob) => void;
  reject: (err: Error) => void;
}

let worker: Worker | null = null;
let nextReqId = 1;
const pending = new Map<number, PendingRequest>();
const inFlight = new Map<string, Promise<Blob>>();

function failAll(err: Error): void {
  for (const entry of pending.values()) entry.reject(err);
  pending.clear();
  if (worker !== null) {
    worker.terminate();
    worker = null;
  }
}

function getWorker(): Worker {
  if (worker !== null) return worker;
  const created = new Worker(new URL("./bake.worker.ts", import.meta.url), { type: "module" });
  created.onmessage = (event: MessageEvent<BakeResponse>) => {
    const res = event.data;
    const entry = pending.get(res.reqId);
    if (entry === undefined) return;
    pending.delete(res.reqId);
    if (res.ok) entry.resolve(res.blob);
    else entry.reject(new Error(res.error));
  };
  created.onerror = (event: ErrorEvent) => {
    failAll(new Error(event.message || "wallpaper bake worker failed"));
  };
  worker = created;
  return created;
}

/**
 * Cover-crop the source to exactly `width x height`, using the catalog's focal
 * point for the vertical position (the design's 16:9 crops). A canvas does the
 * crop/resize because the crop-rect overload of `createImageBitmap` is not
 * available in every webview; the worker still owns every drawn pixel.
 */
async function cropBitmap(id: string, width: number, height: number): Promise<ImageBitmap> {
  const blob = await loadFullWallpaperBlob(id);
  const source = await createImageBitmap(blob);
  const iw = source.width;
  const ih = source.height;
  if (iw <= 0 || ih <= 0) {
    source.close();
    throw new Error(`wallpaper ${id} has no pixels`);
  }

  const scale = Math.max(width / iw, height / ih);
  const cropX = ((iw * scale - width) / 2) / scale;
  const cropY = (((ih * scale - height) * (FOCAL_Y[id] ?? 50)) / 100) / scale;
  const cropW = Math.min(iw, width / scale);
  const cropH = Math.min(ih, height / scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    source.close();
    throw new Error("2d context unavailable for the wallpaper crop");
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, cropX, cropY, cropW, cropH, 0, 0, width, height);
  source.close();

  return await createImageBitmap(canvas);
}

function drawInWorker(req: Omit<BakeRequest, "reqId">): Promise<Blob> {
  const target = getWorker();
  const reqId = nextReqId++;
  return new Promise<Blob>((resolve, reject) => {
    const timer = setTimeout(() => failAll(new Error("wallpaper bake worker timed out")), REQUEST_TIMEOUT_MS);
    pending.set(reqId, {
      resolve: (b) => {
        clearTimeout(timer);
        resolve(b);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    try {
      target.postMessage({ ...req, reqId }, [req.bitmap]);
    } catch (err) {
      clearTimeout(timer);
      pending.delete(reqId);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wallpaper bake timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function runBake(input: BakeInput, key: string): Promise<Blob> {
  const size = bakeSize(input.width, input.height);
  const bitmap = await cropBitmap(input.id, size.width, size.height);
  try {
    const blob = await drawInWorker({
      texture: input.texture,
      appearance: input.appearance,
      width: size.width,
      height: size.height,
      bitmap,
    });
    await putBaked(key, blob);
    return blob;
  } finally {
    bitmap.close();
  }
}

/** Bake (or join the bake already running for) one wallpaper/texture/size. */
export function bake(input: BakeInput): Promise<Blob> {
  const size = bakeSize(input.width, input.height);
  const key = bakeKey({ ...input, width: size.width, height: size.height });
  const running = inFlight.get(key);
  if (running !== undefined) return running;

  const entry: { promise: Promise<Blob> } = { promise: Promise.resolve(new Blob()) };
  entry.promise = withTimeout(runBake(input, key), REQUEST_TIMEOUT_MS).finally(() => {
    if (inFlight.get(key) === entry.promise) inFlight.delete(key);
  });
  inFlight.set(key, entry.promise);
  return entry.promise;
}

/**
 * Test-only: drop the worker, pending requests and in-flight dedupe. Pending
 * promises are abandoned rather than rejected so an un-awaited request from a
 * previous case cannot surface as an unhandled rejection.
 */
export function __resetBakeClientForTests(): void {
  pending.clear();
  inFlight.clear();
  if (worker !== null) {
    worker.terminate();
    worker = null;
  }
  nextReqId = 1;
}
