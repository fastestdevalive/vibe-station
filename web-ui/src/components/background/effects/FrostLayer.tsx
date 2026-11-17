import { useId, type CSSProperties } from "react";

/**
 * Frost: a live backdrop blur over the wallpaper, a theme tint and an inline
 * `feTurbulence` grain. `intensity` scales the blur radius, the tint and the
 * grain opacity through CSS custom properties.
 */
export interface FrostLayerProps {
  src: string;
  intensity: number;
}

function strength(intensity: number): number {
  if (!Number.isFinite(intensity)) return 0;
  return Math.min(1, Math.max(0, intensity));
}

export function FrostLayer({ intensity }: FrostLayerProps) {
  const s = strength(intensity);
  // useId() can contain characters that are not valid in a `url(#…)` fragment.
  const grainId = `wp-frost-grain-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const style = {
    "--wp-frost-strength": String(s),
    "--wp-frost-blur": `${Math.round(10 + 30 * s)}px`,
  } as CSSProperties;

  return (
    <div className="wp-frost" style={style}>
      <div className="wp-frost__tint" />
      <svg className="wp-frost__grain" aria-hidden="true" width="100%" height="100%">
        <filter id={grainId}>
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#${grainId})`} />
      </svg>
    </div>
  );
}
