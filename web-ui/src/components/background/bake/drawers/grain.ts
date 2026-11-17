import type { Drawer } from "./types";
import { clamp01, mix } from "./pixels";
import { makeRng } from "../seededRandom";

/**
 * Grain: gently desaturated with monochrome film grain. The noise is generated at
 * half resolution and bilinearly sampled, which is the cheap equivalent of the
 * reference script's Gaussian blur.
 */

const DESATURATE = 0.28;
const NOISE_SCALE = 0.18;

function sampleBilinear(buf: Float32Array, w: number, h: number, fx: number, fy: number): number {
  const x0 = Math.min(w - 1, Math.max(0, Math.floor(fx)));
  const y0 = Math.min(h - 1, Math.max(0, Math.floor(fy)));
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = buf[y0 * w + x0] ?? 0;
  const b = buf[y0 * w + x1] ?? 0;
  const c = buf[y1 * w + x0] ?? 0;
  const d = buf[y1 * w + x1] ?? 0;
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

export const drawGrain: Drawer = (img, opts) => {
  const { data, width, height } = img;
  const alpha = clamp01(opts.intensity);
  const rng = makeRng(opts.seed);

  const lowW = Math.max(1, Math.floor(width / 2));
  const lowH = Math.max(1, Math.floor(height / 2));
  const noise = new Float32Array(lowW * lowH);
  for (let i = 0; i < noise.length; i++) {
    noise[i] = (rng() + rng() + rng() - 1.5) * NOISE_SCALE;
  }

  for (let y = 0; y < height; y++) {
    const fy = ((y + 0.5) * lowH) / height - 0.5;
    for (let x = 0; x < width; x++) {
      const fx = ((x + 0.5) * lowW) / width - 0.5;
      const grain = sampleBilinear(noise, lowW, lowH, fx, fy) * 255;
      const i = (y * width + x) * 4;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      data[i] = mix(r, r * (1 - DESATURATE) + lum * DESATURATE + grain, alpha);
      data[i + 1] = mix(g, g * (1 - DESATURATE) + lum * DESATURATE + grain, alpha);
      data[i + 2] = mix(b, b * (1 - DESATURATE) + lum * DESATURATE + grain, alpha);
    }
  }
  return img;
};
