import type { Drawer } from "./types";
import { BLACK, PAPER, blendInto, buildCellGrid, cellSize, clamp01, fillRect } from "./pixels";

/**
 * ASCII: per-cell luminance drives a 10-step ramp drawn with an own 5x7 bitmap
 * font (no system font, identical on every platform). Dark = coloured glyphs on
 * black, light = ink glyphs on paper.
 */

const RAMP_SIZE = 10;
const GLYPH_W = 5;
const GLYPH_H = 7;

// Ramp ` .:-=+*#%@`, one 7-row bitmap each (bit 4 = leftmost column).
const GLYPHS: readonly (readonly number[])[] = [
  [0, 0, 0, 0, 0, 0, 0], // ' '
  [0, 0, 0, 0, 0, 0, 0b00100], // '.'
  [0, 0b00100, 0, 0, 0, 0b00100, 0], // ':'
  [0, 0, 0, 0b11111, 0, 0, 0], // '-'
  [0, 0, 0b11111, 0, 0b11111, 0, 0], // '='
  [0, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0], // '+'
  [0b00100, 0b10101, 0b01110, 0b11111, 0b01110, 0b10101, 0b00100], // '*'
  [0b01010, 0b11111, 0b01010, 0b01010, 0b11111, 0b01010, 0], // '#'
  [0b11001, 0b11010, 0b00100, 0b01000, 0b10110, 0b00110, 0], // '%'
  [0b01110, 0b10001, 0b10111, 0b10101, 0b10111, 0b10000, 0b01110], // '@'
];

export const drawAscii: Drawer = (img, opts) => {
  const { data, width, height } = img;
  const light = opts.appearance === "light";
  const alpha = clamp01(opts.intensity);
  const cellW = cellSize(10, width);
  const cellH = cellSize(18, width);
  const grid = buildCellGrid(data, width, height, cellW, cellH);

  let lo = Infinity;
  let hi = -Infinity;
  for (const l of grid.lum) {
    if (l < lo) lo = l;
    if (l > hi) hi = l;
  }
  const span = hi - lo + 1e-6;
  const power = light ? 0.9 : 0.7;

  const effect = new Float32Array(width * height * 3);
  fillRect(effect, width, height, 0, 0, width, height, light ? PAPER : BLACK);

  const px = cellW / GLYPH_W;
  const py = cellH / GLYPH_H;
  for (let j = 0; j < grid.rows; j++) {
    for (let i = 0; i < grid.cols; i++) {
      const k = j * grid.cols + i;
      const n = ((grid.lum[k] ?? 0) - lo) / span;
      const v = light ? 1 - n : n;
      const idx = Math.floor(Math.pow(clamp01(v), power) * (RAMP_SIZE - 1));
      if (idx === 0) continue;
      const scale = light ? 0.62 : 1;
      const colour: readonly [number, number, number] = [
        (grid.rgb[k * 3] ?? 0) * scale * 255,
        (grid.rgb[k * 3 + 1] ?? 0) * scale * 255,
        (grid.rgb[k * 3 + 2] ?? 0) * scale * 255,
      ];
      const glyph = GLYPHS[idx] ?? GLYPHS[0] ?? [];
      const ox = i * cellW;
      const oy = j * cellH;
      for (let gy = 0; gy < GLYPH_H; gy++) {
        const bits = glyph[gy] ?? 0;
        for (let gx = 0; gx < GLYPH_W; gx++) {
          if ((bits & (1 << (GLYPH_W - 1 - gx))) === 0) continue;
          fillRect(effect, width, height, ox + gx * px, oy + gy * py, ox + (gx + 1) * px, oy + (gy + 1) * py, colour);
        }
      }
    }
  }

  blendInto(data, effect, alpha);
  return img;
};
