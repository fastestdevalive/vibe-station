import type { CSSProperties } from "react";

/**
 * Haze: two masked blurred copies of the wallpaper over a sharp base, plus a
 * theme wash — the design's live (unbaked) effect. `intensity` scales the blur
 * radius and the wash opacity through CSS custom properties.
 */
export interface HazeLayerProps {
  src: string;
  intensity: number;
}

function strength(intensity: number): number {
  if (!Number.isFinite(intensity)) return 0;
  return Math.min(1, Math.max(0, intensity));
}

export function HazeLayer({ src, intensity }: HazeLayerProps) {
  const s = strength(intensity);
  const style = {
    "--wp-haze-strength": String(s),
    "--wp-haze-blur-near": `${(6 + 10 * s).toFixed(1)}px`,
    "--wp-haze-blur-far": `${(14 + 22 * s).toFixed(1)}px`,
    backgroundImage: `url("${src}")`,
  } as CSSProperties;

  return (
    <div className="wp-haze" style={style}>
      <div className="wp-haze__sharp" />
      <div className="wp-haze__blur wp-haze__blur--near" />
      <div className="wp-haze__blur wp-haze__blur--far" />
      <div className="wp-haze__wash" />
    </div>
  );
}
