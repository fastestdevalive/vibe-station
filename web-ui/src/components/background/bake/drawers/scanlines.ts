import type { Drawer } from "./types";
import { clamp01, mix } from "./pixels";

/**
 * Scanlines: one dark row in three, plus a fine brightness lift; the dark variant
 * adds the design's corner vignette. Light brightens the line instead of darkening it.
 */

export const drawScanlines: Drawer = (img, opts) => {
  const { data, width, height } = img;
  const light = opts.appearance === "light";
  const alpha = clamp01(opts.intensity);

  for (let y = 0; y < height; y++) {
    const onLine = y % 3 === 0;
    for (let x = 0; x < width; x++) {
      const dx = x / width - 0.5;
      const dy = y / height - 0.5;
      const vignette = light ? 1 : 1 - 0.28 * (dx * dx + dy * dy) * 2;
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        let v = data[i + c] ?? 0;
        if (onLine) v = light ? v * 0.35 + 0.65 * 255 : v * 0.28;
        v *= 1.06;
        data[i + c] = mix(data[i + c] ?? 0, v * vignette, alpha);
      }
    }
  }
  return img;
};
