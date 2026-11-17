import type { Drawer } from "./types";
import { clamp01, mix } from "./pixels";

/**
 * Ordered dither: 8x8 Bayer matrix, 3 levels per channel, computed at half the
 * output size and upscaled nearest-neighbour (the design's 2 px cells).
 */

const LEVELS = 3;

function bayer8(): Float32Array {
  let m: number[] = [0];
  let n = 1;
  while (n < 8) {
    const next = new Array<number>(n * 2 * n * 2);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const v = 4 * (m[y * n + x] ?? 0);
        next[y * 2 * n + x] = v;
        next[y * 2 * n + x + n] = v + 2;
        next[(y + n) * 2 * n + x] = v + 3;
        next[(y + n) * 2 * n + x + n] = v + 1;
      }
    }
    m = next;
    n *= 2;
  }
  return Float32Array.from(m, (v) => v / 64);
}

const BAYER = bayer8();

export const drawDither: Drawer = (img, opts) => {
  const { data, width, height } = img;
  const alpha = clamp01(opts.intensity);
  const lowW = Math.max(1, Math.floor(width / 2));
  const lowH = Math.max(1, Math.floor(height / 2));

  // Box-average the source into the half-res grid.
  const low = new Float32Array(lowW * lowH * 3);
  for (let y = 0; y < lowH; y++) {
    const y0 = Math.floor((y * height) / lowH);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / lowH));
    for (let x = 0; x < lowW; x++) {
      const x0 = Math.floor((x * width) / lowW);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / lowW));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * width + sx) * 4;
          r += data[i] ?? 0;
          g += data[i + 1] ?? 0;
          b += data[i + 2] ?? 0;
          n += 1;
        }
      }
      const k = (y * lowW + x) * 3;
      low[k] = r / n / 255;
      low[k + 1] = g / n / 255;
      low[k + 2] = b / n / 255;
    }
  }

  const levels = LEVELS - 1;
  const dithered = new Float32Array(lowW * lowH * 3);
  for (let y = 0; y < lowH; y++) {
    for (let x = 0; x < lowW; x++) {
      const t = BAYER[(y & 7) * 8 + (x & 7)] ?? 0;
      const k = (y * lowW + x) * 3;
      for (let c = 0; c < 3; c++) {
        dithered[k + c] = clamp01(Math.floor((low[k + c] ?? 0) * levels + t) / levels);
      }
    }
  }

  for (let y = 0; y < height; y++) {
    const ly = Math.min(lowH - 1, Math.floor((y * lowH) / height));
    for (let x = 0; x < width; x++) {
      const lx = Math.min(lowW - 1, Math.floor((x * lowW) / width));
      const k = (ly * lowW + lx) * 3;
      const i = (y * width + x) * 4;
      data[i] = mix(data[i] ?? 0, (dithered[k] ?? 0) * 255, alpha);
      data[i + 1] = mix(data[i + 1] ?? 0, (dithered[k + 1] ?? 0) * 255, alpha);
      data[i + 2] = mix(data[i + 2] ?? 0, (dithered[k + 2] ?? 0) * 255, alpha);
    }
  }
  return img;
};
