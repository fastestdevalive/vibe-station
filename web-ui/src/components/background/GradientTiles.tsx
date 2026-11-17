import { GRADIENTS, gradientById, gradientCss, type GradientId } from "./gradient";
import { thumbUrl } from "./thumbs";
import "./picker.css";

export interface GradientTilesProps {
  /** The wallpaper whose bundled thumb sits under each preset; null when there is none. */
  wallpaperId: string | null;
  selected: GradientId;
  onPick: (id: GradientId) => void;
}

/**
 * The six gradient presets as tiles: the current wallpaper's own thumb with
 * that preset drawn over it, so the choice is compared on the picture it will
 * fade. Same grid/classes as the texture tiles; the selected preset's blurb
 * follows, like a texture's.
 */
export function GradientTiles({ wallpaperId, selected, onPick }: GradientTilesProps): React.JSX.Element {
  const thumb = wallpaperId === null ? undefined : thumbUrl(wallpaperId);
  const preset = gradientById(selected);

  return (
    <div className="wp-textures">
      <div className="wp-tiles">
        {GRADIENTS.map((p) => {
          const on = p.id === selected;
          return (
            <button
              key={p.id}
              type="button"
              className={on ? "wp-tile is-on" : "wp-tile"}
              aria-pressed={on}
              onClick={() => onPick(p.id)}
            >
              <span className="wp-tile__img">
                {thumb !== undefined ? <img src={thumb} alt="" loading="lazy" /> : null}
                <span className="wp-tile__fade" aria-hidden="true" style={{ background: gradientCss(p.id) }} />
              </span>
              <span className="wp-tile__label">{p.label}</span>
            </button>
          );
        })}
      </div>
      <p className="wp-tiles__desc">{preset.blurb}</p>
    </div>
  );
}
