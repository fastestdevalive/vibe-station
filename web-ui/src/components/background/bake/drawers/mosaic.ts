import type { Drawer } from "./types";
import { blendInto, buildCellGrid, cellSize, clamp01 } from "./pixels";

/**
 * Mosaic: square tiles with a hairline dark gap on the top/left edge of each tile.
 * 20 px tiles and 1 px gaps at the 1600 px reference width (half the design
 * script's 40 px so cells read at tile size), scaled with the output width so the cell stays the same
 * fraction of the window at every DPR.
 */

const REFERENCE_TILE = 20;
const REFERENCE_GAP = 1;

export const drawMosaic: Drawer = (img, opts) => {
  const { data, width, height } = img;
  const alpha = clamp01(opts.intensity);
  const tile = cellSize(REFERENCE_TILE, width);
  const gap = Math.max(1, (REFERENCE_GAP * tile) / REFERENCE_TILE);
  const grid = buildCellGrid(data, width, height, tile, tile);

  const effect = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const j = Math.min(grid.rows - 1, Math.floor(y / tile));
    const cellY = j * tile;
    for (let x = 0; x < width; x++) {
      const i = Math.min(grid.cols - 1, Math.floor(x / tile));
      const cellX = i * tile;
      const k = j * grid.cols + i;
      const inGap = x - cellX < gap || y - cellY < gap;
      const scale = inGap ? 0.35 : 1;
      const o = (y * width + x) * 3;
      effect[o] = (grid.rgb[k * 3] ?? 0) * scale * 255;
      effect[o + 1] = (grid.rgb[k * 3 + 1] ?? 0) * scale * 255;
      effect[o + 2] = (grid.rgb[k * 3 + 2] ?? 0) * scale * 255;
    }
  }

  blendInto(data, effect, alpha);
  return img;
};
