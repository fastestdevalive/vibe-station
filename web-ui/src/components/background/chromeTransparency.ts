import { CHROME_OPACITY_RANGE } from "./backgroundStore";

/**
 * The ONLY conversion between the stored chrome OPACITY (backgroundStore.chromeOpacity,
 * 0.4-1, what --wp-chrome-alpha uses) and the TRANSPARENCY the "Sidebar and bars
 * transparency" slider shows (0-60 %). Storage and CSS keep opacity; only the UI says transparency.
 */
export const CHROME_TRANSPARENCY = {
  min: 0,
  max: Math.round((1 - CHROME_OPACITY_RANGE.min) * 100), // 60
  // 2 keeps the 28% default (today's 72% opacity) and the 60% maximum both on the slider's grid.
  step: 2,
} as const;

/** Whole percent 0-60; out-of-range or non-finite stored opacity clamps (storage is not touched). */
export function transparencyFromOpacity(opacity: number): number {
  const o = Number.isFinite(opacity) ? opacity : CHROME_OPACITY_RANGE.fallback;
  return Math.min(CHROME_TRANSPARENCY.max, Math.max(CHROME_TRANSPARENCY.min, Math.round((1 - o) * 100)));
}

/** Fraction 0.4-1, rounded to 2 decimals (no 0.35000000000000003 in storage). */
export function opacityFromTransparency(percent: number): number {
  const p = Math.min(CHROME_TRANSPARENCY.max, Math.max(CHROME_TRANSPARENCY.min, percent));
  return Math.round(100 - p) / 100;
}
