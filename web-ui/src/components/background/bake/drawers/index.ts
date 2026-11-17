import type { BakedTextureId } from "../protocol";
import type { Drawer } from "./types";
import { drawAscii } from "./ascii";
import { drawDither } from "./dither";
import { drawGlitch } from "./glitch";
import { drawGrain } from "./grain";
import { drawHalftone } from "./halftone";
import { drawHex } from "./hex";
import { drawMosaic } from "./mosaic";
import { drawScanlines } from "./scanlines";

/** Every bakeable texture, keyed by its frozen id. */
export const DRAWERS: Record<BakedTextureId, Drawer> = {
  dither: drawDither,
  ascii: drawAscii,
  halftone: drawHalftone,
  scanlines: drawScanlines,
  grain: drawGrain,
  mosaic: drawMosaic,
  glitch: drawGlitch,
  hex: drawHex,
};
