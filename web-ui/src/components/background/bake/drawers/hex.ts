import type { Drawer } from "./types";
import {
  BLACK,
  PAPER,
  blendInto,
  boxBlurRgb,
  cellSize,
  clamp01,
  drawHexagon,
  fillRect,
  luminance,
} from "./pixels";

/**
 * Hex: halftone on a honeycomb. Hexagon size comes from a softly blurred
 * luminance read (the reference script's Gaussian blur), dark = lit hexagons on
 * black, light = ink hexagons on paper.
 */

const R_MAX_REFERENCE = 12;
const BLUR_RADIUS = 5;

export const drawHex: Drawer = (img, opts) => {
  const { data, width, height } = img;
  const light = opts.appearance === "light";
  const alpha = clamp01(opts.intensity);

  const rMax = cellSize(R_MAX_REFERENCE, width);
  const dx = Math.sqrt(3) * rMax;
  const dy = 1.5 * rMax;
  const rows = Math.floor(height / dy) + 2;
  const cols = Math.floor(width / dx) + 2;

  const src = new Float32Array(width * height * 3);
  for (let p = 0; p < width * height; p++) {
    src[p * 3] = data[p * 4] ?? 0;
    src[p * 3 + 1] = data[p * 4 + 1] ?? 0;
    src[p * 3 + 2] = data[p * 4 + 2] ?? 0;
  }
  const soft = boxBlurRgb(src, width, height, BLUR_RADIUS);

  const effect = new Float32Array(width * height * 3);
  fillRect(effect, width, height, 0, 0, width, height, light ? PAPER : BLACK);

  const minR = (0.8 * rMax) / R_MAX_REFERENCE;
  for (let j = 0; j < rows; j++) {
    const cy = j * dy;
    for (let i = 0; i < cols; i++) {
      const cx = i * dx + (j % 2 === 1 ? dx / 2 : 0);
      const sx = Math.min(width - 1, Math.max(0, Math.round(cx)));
      const sy = Math.min(height - 1, Math.max(0, Math.round(cy)));
      const k = (sy * width + sx) * 3;
      const r = soft[k] ?? 0;
      const g = soft[k + 1] ?? 0;
      const b = soft[k + 2] ?? 0;
      const l = luminance(r / 255, g / 255, b / 255);
      const v = light ? 1 - l : l;
      const radius = rMax * 1.02 * Math.sqrt(clamp01(v));
      if (radius < minR) continue;
      const scale = light ? 0.7 : 1;
      drawHexagon(effect, width, height, cx, cy, radius, [r * scale, g * scale, b * scale]);
    }
  }

  blendInto(data, effect, alpha);
  return img;
};
