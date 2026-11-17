import type { TextureId } from "./backgroundStore";

/**
 * Texture catalog, ported from `surface-style-lib` `TextureCatalog.kt` (ids frozen; always
 * persist the id, never an ordinal). Labels/blurbs are the design's Picker tile copy
 * (`design-wallpaper-effects/project/Picker.dc.html`), one short sentence each.
 */

/** BUMP on ANY drawer/baker output change — it feeds the bake cache key. */
export const RENDER_VERSION = 5;

export interface TextureSpec {
  id: TextureId;
  costTier: "cheap" | "medium" | "heavy";
  hasLightVariant: boolean;
  needsSource: boolean;
  delivery: "baked" | "css" | "none";
  defaultIntensity: number;
  label: string;
  blurb: string;
}

const NONE: TextureSpec = {
  id: "none",
  costTier: "cheap",
  hasLightVariant: false,
  needsSource: false,
  delivery: "none",
  defaultIntensity: 0,
  label: "None",
  blurb: "The wallpaper as it is.",
};

/** UI order, `none` first. */
export const TEXTURES: readonly TextureSpec[] = [
  NONE,
  {
    id: "dither",
    costTier: "heavy",
    hasLightVariant: false,
    needsSource: true,
    delivery: "baked",
    defaultIntensity: 0.7,
    label: "Dither",
    blurb: "A dithered colour palette.",
  },
  {
    id: "ascii",
    costTier: "heavy",
    hasLightVariant: true,
    needsSource: true,
    delivery: "baked",
    defaultIntensity: 0.8,
    label: "ASCII",
    blurb: "Coloured characters.",
  },
  {
    id: "halftone",
    costTier: "heavy",
    hasLightVariant: true,
    needsSource: true,
    delivery: "baked",
    defaultIntensity: 0.8,
    label: "Halftone",
    blurb: "Ink dots on paper, in both themes.",
  },
  {
    id: "scanlines",
    costTier: "cheap",
    hasLightVariant: true,
    needsSource: false,
    delivery: "baked",
    defaultIntensity: 0.6,
    label: "Scanlines",
    blurb: "Horizontal display lines.",
  },
  {
    id: "haze",
    costTier: "medium",
    hasLightVariant: false,
    needsSource: true,
    delivery: "css",
    defaultIntensity: 0.8,
    label: "Haze",
    blurb: "Blurs and fades into the background.",
  },
  {
    id: "grain",
    costTier: "cheap",
    hasLightVariant: false,
    needsSource: false,
    delivery: "baked",
    defaultIntensity: 0.5,
    label: "Grain",
    blurb: "Fine film grain.",
  },
  {
    id: "mosaic",
    costTier: "cheap",
    hasLightVariant: false,
    needsSource: true,
    delivery: "baked",
    defaultIntensity: 0.8,
    label: "Mosaic",
    blurb: "Tiles with hairline gaps.",
  },
  {
    id: "glitch",
    costTier: "cheap",
    hasLightVariant: false,
    needsSource: true,
    delivery: "baked",
    defaultIntensity: 0.7,
    label: "Glitch",
    blurb: "Split channels, shifted bands.",
  },
  {
    id: "hex",
    costTier: "heavy",
    hasLightVariant: true,
    needsSource: true,
    delivery: "baked",
    defaultIntensity: 0.8,
    label: "Hex",
    blurb: "Halftone on a honeycomb.",
  },
  {
    id: "frost",
    costTier: "medium",
    hasLightVariant: false,
    needsSource: true,
    delivery: "css",
    defaultIntensity: 0.6,
    label: "Frost",
    blurb: "Heavy blur, only colour remains.",
  },
];

/** The spec for `id`; an unknown id (older/newer client) resolves to `none`, never throws. */
export function textureById(id: string): TextureSpec {
  return TEXTURES.find((t) => t.id === id) ?? NONE;
}
