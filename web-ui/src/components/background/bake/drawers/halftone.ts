import type { Drawer } from "./types";
import { PAPER, blendInto, buildCellGrid, cellSize, clamp01, drawCircle, fillRect } from "./pixels";

/**
 * Halftone: ink dots on paper. Deliberately theme-independent — the light
 * "ink on paper" look in both themes, so `appearance` is ignored.
 */

export const drawHalftone: Drawer = (img, opts) => {
  const { data, width, height } = img;
  const alpha = clamp01(opts.intensity);
  const cell = cellSize(14, width);
  const grid = buildCellGrid(data, width, height, cell, cell);

  const effect = new Float32Array(width * height * 3);
  fillRect(effect, width, height, 0, 0, width, height, PAPER);

  for (let j = 0; j < grid.rows; j++) {
    for (let i = 0; i < grid.cols; i++) {
      const k = j * grid.cols + i;
      const v = 1 - (grid.lum[k] ?? 0);
      const r = cell * 0.75 * Math.sqrt(clamp01(v));
      if (r < 0.4) continue;
      const colour: readonly [number, number, number] = [
        (grid.rgb[k * 3] ?? 0) * 0.7 * 255,
        (grid.rgb[k * 3 + 1] ?? 0) * 0.7 * 255,
        (grid.rgb[k * 3 + 2] ?? 0) * 0.7 * 255,
      ];
      drawCircle(effect, width, height, (i + 0.5) * grid.cellW, (j + 0.5) * grid.cellH, r, colour);
    }
  }

  blendInto(data, effect, alpha);
  return img;
};
