/**
 * The ONE owner of the wallpaper gradient. Preset ids mirror hundredgb's
 * `GradientPreset` (surface-style-lib) plus `mobile`, the phone app's fade. The
 * default is `fade_to_theme` ("Soft fade"). The fade colour is always the theme
 * background (`--bg-primary`), so a preset is theme-independent and `gradientCss` needs no dark/light flag.
 */

export const GRADIENT_IDS = ["mobile", "fade_to_theme", "classic", "top_fade", "side_fade", "none"] as const;

export type GradientId = (typeof GRADIENT_IDS)[number];

export const DEFAULT_GRADIENT: GradientId = "fade_to_theme";

export interface FadeStop {
  offset: number;
  alpha: number;
}

export interface GradientPreset {
  id: GradientId;
  label: string;
  blurb: string;
  /** CSS angle: hundredgb's 0 = right, 90 = bottom, mapped onto CSS's own axes. */
  cssAngleDeg: number;
  stops: readonly FadeStop[];
}

/** vibe-station-mobile `WALLPAPER_FADE_STOPS` (WallpaperFilter.kt); keep in step. */
export const MOBILE_FADE_STOPS: readonly FadeStop[] = [
  { offset: 0, alpha: 0 },
  { offset: 0.47, alpha: 0 },
  { offset: 0.7, alpha: 0.6 },
  { offset: 0.86, alpha: 1 },
  { offset: 1, alpha: 1 },
];

/** hundredgb 0=right, 90=bottom, 180=left, 270=top → CSS gradient angle. */
function cssAngle(hundredgbDeg: number): number {
  return (hundredgbDeg + 90) % 360;
}

/** 6t⁵ − 15t⁴ + 10t³, clamped to 0..1 (hundredgb `GradientMath.smootherstep`). */
function smootherstep(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * c * (c * (c * 6 - 15) + 10);
}

const SAMPLES = 12;

/**
 * hundredgb `GradientMath.stops`: 12 equal steps across [start, end] plus anchors
 * outside it. Stepping by 1/12 keeps the range's midpoint a stop, so the curve's
 * halfway point (alpha 0.5) is exact.
 */
function linearStops(start: number, end: number, strength: number): FadeStop[] {
  const stops: FadeStop[] = [];
  if (start > 0) stops.push({ offset: 0, alpha: 0 });
  for (let i = 0; i <= SAMPLES; i += 1) {
    const t = start + (end - start) * (i / SAMPLES);
    stops.push({ offset: t, alpha: strength * smootherstep((t - start) / (end - start)) });
  }
  if (end < 1) stops.push({ offset: 1, alpha: strength });
  return stops;
}

const MOBILE_PRESET: GradientPreset = {
  id: "mobile",
  label: "Mobile",
  blurb: "The phone app's bottom fade.",
  cssAngleDeg: cssAngle(90),
  stops: MOBILE_FADE_STOPS,
};

/** Tile order: mobile first. */
export const GRADIENTS: readonly GradientPreset[] = [
  MOBILE_PRESET,
  {
    id: "fade_to_theme",
    label: "Soft fade",
    blurb: "A long, gentle fade into the theme.",
    cssAngleDeg: cssAngle(90),
    stops: linearStops(0.3, 0.78, 1),
  },
  {
    id: "classic",
    label: "Classic",
    blurb: "Fades from a quarter of the way down.",
    cssAngleDeg: cssAngle(90),
    stops: linearStops(0.25, 1, 1),
  },
  {
    id: "top_fade",
    label: "Top fade",
    blurb: "Darkens the top edge.",
    cssAngleDeg: cssAngle(270),
    stops: linearStops(0.7, 1, 1),
  },
  {
    id: "side_fade",
    label: "Side fade",
    blurb: "Fades toward the left side.",
    cssAngleDeg: cssAngle(180),
    stops: linearStops(0.55, 1, 1),
  },
  {
    id: "none",
    label: "None",
    blurb: "No fade.",
    cssAngleDeg: cssAngle(90),
    stops: linearStops(0, 1, 0),
  },
];

export function isGradientId(value: unknown): value is GradientId {
  return typeof value === "string" && (GRADIENT_IDS as readonly string[]).includes(value);
}

const DEFAULT_PRESET = GRADIENTS.find((preset) => preset.id === DEFAULT_GRADIENT) ?? MOBILE_PRESET;

/** Unknown ids (older/newer client) read as the default preset; never throws. */
export function gradientById(id: string): GradientPreset {
  return GRADIENTS.find((preset) => preset.id === id) ?? DEFAULT_PRESET;
}

/** Up to 2 decimals, no trailing zeros: 0.6 → "60%", 0.475 → "47.5%". */
function percent(value: number): string {
  return `${Math.round(value * 10000) / 100}%`;
}

function stopCss(stop: FadeStop): string {
  return `color-mix(in srgb, var(--bg-primary) ${percent(stop.alpha)}, transparent) ${percent(stop.offset)}`;
}

/** The CSS `background` value of a preset; strength 0 draws nothing. */
export function gradientCss(id: string): string {
  const preset = gradientById(id);
  if (preset.stops.every((stop) => stop.alpha === 0)) return "none";
  return `linear-gradient(${preset.cssAngleDeg}deg, ${preset.stops.map(stopCss).join(", ")})`;
}
