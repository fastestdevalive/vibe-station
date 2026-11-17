/**
 * Message contract between the wallpaper bake client (main thread) and
 * `bake.worker.ts`. Both tracks code against these types; keep them stable.
 */

/** The effects the worker can bake. Haze/Frost are live CSS, so they are not here. */
export type BakedTextureId =
  | "dither"
  | "ascii"
  | "halftone"
  | "scanlines"
  | "grain"
  | "mosaic"
  | "glitch"
  | "hex";

export interface BakeRequest {
  reqId: number;
  texture: BakedTextureId;
  appearance: "dark" | "light";
  width: number;
  height: number;
  /** Already cover-cropped to `width x height` by the caller. */
  bitmap: ImageBitmap;
}

export type BakeResponse =
  | { reqId: number; ok: true; blob: Blob }
  | { reqId: number; ok: false; error: string };
