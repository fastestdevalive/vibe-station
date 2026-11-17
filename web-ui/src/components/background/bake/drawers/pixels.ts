/**
 * Shared primitives for the pixel drawers. Everything here is pure over plain
 * arrays: the same code runs in the bake worker and in jsdom tests.
 *
 * The algorithms follow `surface-style-lib`'s `texture/*.kt` (mobile parity) and
 * the design's `_generators/bake_effects.py` (the reference look).
 */

/** Paper colour behind the light variants (`bake_effects.py`). */
export const PAPER: readonly [number, number, number] = [246, 244, 240];
export const BLACK: readonly [number, number, number] = [0, 0, 0];

/** Cell sizes in the reference script are for a 1600 px wide output. */
export const REFERENCE_WIDTH = 1600;

/** Scale a reference cell size with the real width, never below 2 px. */
export function cellSize(reference: number, width: number): number {
  return Math.max(2, (reference * width) / REFERENCE_WIDTH);
}

/** Rec. 601 luminance of 0..1 channels. */
export function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Full-strength effect blended over the source at `alpha`. */
export function mix(orig: number, effect: number, alpha: number): number {
  return orig + (effect - orig) * alpha;
}

export interface CellGrid {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  /** Per-cell mean colour, 0..1. */
  rgb: Float32Array;
  /** Per-cell luminance, 0..1. */
  lum: Float32Array;
}

/** Per-cell mean colour + luminance, read once from the source image. */
export function buildCellGrid(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  cellW: number,
  cellH: number,
): CellGrid {
  const cols = Math.max(1, Math.ceil(width / cellW));
  const rows = Math.max(1, Math.ceil(height / cellH));
  const rgb = new Float32Array(cols * rows * 3);
  const lum = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const y0 = Math.min(height, Math.floor(j * cellH));
    const y1 = Math.min(height, Math.max(y0 + 1, Math.floor((j + 1) * cellH)));
    for (let i = 0; i < cols; i++) {
      const x0 = Math.min(width, Math.floor(i * cellW));
      const x1 = Math.min(width, Math.max(x0 + 1, Math.floor((i + 1) * cellW)));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = (y * width + x) * 4;
          r += data[p] ?? 0;
          g += data[p + 1] ?? 0;
          b += data[p + 2] ?? 0;
          n += 1;
        }
      }
      const k = j * cols + i;
      const inv = n > 0 ? 1 / (n * 255) : 0;
      rgb[k * 3] = r * inv;
      rgb[k * 3 + 1] = g * inv;
      rgb[k * 3 + 2] = b * inv;
      lum[k] = luminance(r * inv, g * inv, b * inv);
    }
  }
  return { cols, rows, cellW, cellH, rgb, lum };
}

/** Fill an interleaved 3-channel float buffer rectangle. */
export function fillRect(
  buf: Float32Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  colour: readonly [number, number, number],
): void {
  const ax = Math.max(0, Math.floor(x0));
  const bx = Math.min(width, Math.ceil(x1));
  const ay = Math.max(0, Math.floor(y0));
  const by = Math.min(height, Math.ceil(y1));
  for (let y = ay; y < by; y++) {
    for (let x = ax; x < bx; x++) {
      const i = (y * width + x) * 3;
      buf[i] = colour[0];
      buf[i + 1] = colour[1];
      buf[i + 2] = colour[2];
    }
  }
}

/** Fill a circle in an interleaved 3-channel float buffer. */
export function drawCircle(
  buf: Float32Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  r: number,
  colour: readonly [number, number, number],
): void {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(width, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(height, Math.ceil(cy + r));
  const rr = r * r;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy > rr) continue;
      const i = (y * width + x) * 3;
      buf[i] = colour[0];
      buf[i + 1] = colour[1];
      buf[i + 2] = colour[2];
    }
  }
}

/** Pointy-top hexagon (vertices at 30°+60°k) in an interleaved 3-channel buffer. */
export function drawHexagon(
  buf: Float32Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  r: number,
  colour: readonly [number, number, number],
): void {
  const halfW = (Math.sqrt(3) / 2) * r;
  const slope = Math.sqrt(3);
  const x0 = Math.max(0, Math.floor(cx - halfW));
  const x1 = Math.min(width, Math.ceil(cx + halfW));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(height, Math.ceil(cy + r));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const qx = Math.abs(x + 0.5 - cx);
      const qy = Math.abs(y + 0.5 - cy);
      if (qx > halfW || qy > r - qx / slope) continue;
      const i = (y * width + x) * 3;
      buf[i] = colour[0];
      buf[i + 1] = colour[1];
      buf[i + 2] = colour[2];
    }
  }
}

/** Blend a full-strength 3-channel effect buffer over the source at `alpha`. */
export function blendInto(data: Uint8ClampedArray, effect: Float32Array, alpha: number): void {
  const pixels = data.length / 4;
  for (let p = 0; p < pixels; p++) {
    const e = p * 3;
    const d = p * 4;
    data[d] = mix(data[d] ?? 0, effect[e] ?? 0, alpha);
    data[d + 1] = mix(data[d + 1] ?? 0, effect[e + 1] ?? 0, alpha);
    data[d + 2] = mix(data[d + 2] ?? 0, effect[e + 2] ?? 0, alpha);
  }
}

/** Separable box blur over an interleaved 3-channel buffer (the hex lattice's soft luminance). */
export function boxBlurRgb(
  src: Float32Array,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  const n = 2 * radius + 1;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const cx = (x: number): number => (x < 0 ? 0 : x >= width ? width - 1 : x);
  const cy = (y: number): number => (y < 0 ? 0 : y >= height ? height - 1 : y);
  for (let y = 0; y < height; y++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += src[(y * width + cx(k)) * 3 + c] ?? 0;
      for (let x = 0; x < width; x++) {
        tmp[(y * width + x) * 3 + c] = sum / n;
        sum +=
          (src[(y * width + cx(x + radius + 1)) * 3 + c] ?? 0) -
          (src[(y * width + cx(x - radius)) * 3 + c] ?? 0);
      }
    }
  }
  for (let x = 0; x < width; x++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += tmp[(cy(k) * width + x) * 3 + c] ?? 0;
      for (let y = 0; y < height; y++) {
        out[(y * width + x) * 3 + c] = sum / n;
        sum +=
          (tmp[(cy(y + radius + 1) * width + x) * 3 + c] ?? 0) -
          (tmp[(cy(y - radius) * width + x) * 3 + c] ?? 0);
      }
    }
  }
  return out;
}
