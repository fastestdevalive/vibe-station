import { gradientCss, type GradientId } from "./gradient";

/**
 * Scrim then gradient, over the picture and texture (mobile order: image, texture,
 * scrim, fade). `--wp-vis` comes from the nearest ancestor: `<html>` for the
 * window, the preview root for the Picker.
 */
export function WallpaperOverlay({ gradient }: { gradient: GradientId }): React.JSX.Element {
  return (
    <>
      <div className="window-bg__scrim" />
      <div className="window-bg__fade" style={{ background: gradientCss(gradient) }} />
    </>
  );
}
