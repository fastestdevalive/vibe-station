import type { BackgroundPrefs } from "./backgroundStore";
import type { GradientId } from "./gradient";
import { textureById, type TextureSpec } from "./textureCatalog";

/**
 * The ONE resolution from stored prefs to what a wallpaper surface draws.
 * The window and the Picker preview both call this, so they cannot drift; the
 * CSS variables come from `layerVars`, written on `<html>` by `useBackground`
 * and on its own root by the preview.
 */

export type LookView = "empty" | "session";

export interface BackgroundLook {
  texture: TextureSpec;
  intensity: number;
  gradient: GradientId;
  /** Scrim strength per view: how much of the wallpaper survives behind content. */
  visibility: Record<LookView, number>;
  chromeOpacity: number;
}

export function lookFromPrefs(prefs: BackgroundPrefs): BackgroundLook {
  const texture = textureById(prefs.texture);
  return {
    texture,
    intensity: prefs.intensity ?? texture.defaultIntensity,
    gradient: prefs.gradient,
    visibility: { empty: prefs.emptyVisibility, session: prefs.sessionVisibility },
    chromeOpacity: prefs.chromeOpacity,
  };
}

export type LayerVars = { "--wp-vis": string; "--wp-chrome-alpha": string };

/** The custom properties every wallpaper surface reads; with no wallpaper the chrome stays opaque and the scrim off. */
export function layerVars(look: BackgroundLook, view: LookView, wallpaperOn: boolean): LayerVars {
  return {
    "--wp-vis": String(wallpaperOn ? look.visibility[view] : 1),
    "--wp-chrome-alpha": wallpaperOn ? `${Math.round(look.chromeOpacity * 100)}%` : "100%",
  };
}
