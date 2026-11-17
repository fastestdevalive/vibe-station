import { DRAWERS } from "./drawers";
import type { Drawer } from "./drawers/types";
import type { BakeRequest, BakeResponse } from "./protocol";
import { bakeSeed } from "./seededRandom";

/**
 * The only writer of baked pixels: draw the (pre-cropped) bitmap, run the pure
 * drawer over its ImageData, encode the result and post it back. Any failure is
 * reported as `{ ok: false }` so the layer can fall back to the plain wallpaper.
 *
 * The tsconfig lib is DOM (no `webworker`), so the worker global is typed locally
 * instead of adding a conflicting `/// <reference lib="webworker" />`.
 */
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<BakeRequest>) => void) | null;
  postMessage(m: BakeResponse): void;
};

/** Intensity is applied as the baked layer's opacity on the main thread; see WallpaperEffect. */
const FULL_STRENGTH = 1;

async function encode(canvas: OffscreenCanvas): Promise<Blob> {
  try {
    return await canvas.convertToBlob({ type: "image/webp", quality: 0.85 });
  } catch {
    return canvas.convertToBlob({ type: "image/png" });
  }
}

async function bake(req: BakeRequest): Promise<Blob> {
  const canvas = new OffscreenCanvas(req.width, req.height);
  const g = canvas.getContext("2d");
  if (!g) throw new Error("2d context unavailable");
  g.drawImage(req.bitmap, 0, 0, req.width, req.height);
  req.bitmap.close();

  const drawer: Drawer | undefined = DRAWERS[req.texture];
  if (!drawer) throw new Error(`unknown texture ${req.texture}`);

  const img = g.getImageData(0, 0, req.width, req.height);
  const out = drawer(img, {
    intensity: FULL_STRENGTH,
    appearance: req.appearance,
    seed: bakeSeed(req.texture, req.width, req.height),
  });
  g.putImageData(out, 0, 0);
  return encode(canvas);
}

ctx.onmessage = (e: MessageEvent<BakeRequest>) => {
  const req = e.data;
  bake(req)
    .then((blob) => ctx.postMessage({ reqId: req.reqId, ok: true, blob }))
    .catch((err: unknown) => {
      ctx.postMessage({
        reqId: req.reqId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    });
};
