import type { Drawer } from "./types";
import { clamp01, mix } from "./pixels";
import { makeRng } from "../seededRandom";

/**
 * Glitch: RGB split (+-14 px at 1600 wide), seeded displaced bands, and every
 * fourth row dimmed. A shifted channel leaves an empty strip at one edge, which is
 * filled with the unshifted channel so no colour bar appears.
 */

const REFERENCE_WIDTH = 1600;
const SPLIT = 14;

function sample(
  src: Float32Array,
  width: number,
  y: number,
  x: number,
  c: number,
  dx: number,
): number {
  let sx = x - dx;
  if (dx > 0 && x < dx) sx = x;
  else if (dx < 0 && x >= width + dx) sx = x;
  sx = sx < 0 ? 0 : sx >= width ? width - 1 : sx;
  return src[(y * width + sx) * 3 + c] ?? 0;
}

export const drawGlitch: Drawer = (img, opts) => {
  const { data, width, height } = img;
  const alpha = clamp01(opts.intensity);
  const scale = Math.max(0.25, width / REFERENCE_WIDTH);
  const off = Math.round(SPLIT * scale);
  const rng = makeRng(opts.seed);

  // Keep an untouched copy: bands read from it while writing the effect.
  const src = new Float32Array(width * height * 3);
  for (let p = 0; p < width * height; p++) {
    src[p * 3] = data[p * 4] ?? 0;
    src[p * 3 + 1] = data[p * 4 + 1] ?? 0;
    src[p * 3 + 2] = data[p * 4 + 2] ?? 0;
  }

  const effect = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      effect[o] = sample(src, width, y, x, 0, off);
      effect[o + 1] = sample(src, width, y, x, 1, 0);
      effect[o + 2] = sample(src, width, y, x, 2, -off);
    }
  }

  let y = 0;
  while (y < height) {
    const h = Math.max(1, Math.round((6 + rng() * 54) * scale));
    if (rng() < 0.22) {
      const shift = Math.round((rng() * 180 - 90) * scale);
      const greenShift = rng() < 0.4 ? Math.round(20 * scale) : 0;
      const end = Math.min(height, y + h);
      for (let row = y; row < end; row++) {
        for (let x = 0; x < width; x++) {
          const o = (row * width + x) * 3;
          effect[o] = sample(src, width, row, x, 0, off + shift);
          effect[o + 1] = sample(src, width, row, x, 1, shift + greenShift);
          effect[o + 2] = sample(src, width, row, x, 2, -off + shift);
        }
      }
    }
    y += h;
  }

  for (let row = 0; row < height; row += 4) {
    for (let x = 0; x < width; x++) {
      const o = (row * width + x) * 3;
      effect[o] = (effect[o] ?? 0) * 0.82;
      effect[o + 1] = (effect[o + 1] ?? 0) * 0.82;
      effect[o + 2] = (effect[o + 2] ?? 0) * 0.82;
    }
  }

  for (let p = 0; p < width * height; p++) {
    const d = p * 4;
    const e = p * 3;
    data[d] = mix(data[d] ?? 0, effect[e] ?? 0, alpha);
    data[d + 1] = mix(data[d + 1] ?? 0, effect[e + 1] ?? 0, alpha);
    data[d + 2] = mix(data[d + 2] ?? 0, effect[e + 2] ?? 0, alpha);
  }
  return img;
};
