import { useId } from "react";
import type { TextureId } from "./backgroundStore";
import { TEXTURES, textureById } from "./textureCatalog";
import { textureTileUrl } from "./thumbs";
import "./picker.css";

export interface TextureTilesProps {
  /** Theme appearance for the tile bakes (halftone is always the light bake). */
  appearance: "dark" | "light";
  selected: TextureId;
  onPick: (id: TextureId) => void;
  /** Effective intensity, 0..1. */
  intensity: number;
  onIntensity: (value: number) => void;
}

/**
 * The 11 texture tiles (the design's wp-023 bakes) plus the Intensity slider
 * and the selected texture's one-line description. Haze and Frost have no bake:
 * their tile is the original image under the same live CSS look the window uses.
 */
export function TextureTiles({
  appearance,
  selected,
  onPick,
  intensity,
  onIntensity,
}: TextureTilesProps): React.JSX.Element {
  const rangeId = useId();
  const spec = textureById(selected);
  const percent = Math.round(intensity * 100);

  return (
    <div className="wp-textures">
      <div className="wp-tiles">
        {TEXTURES.map((texture) => {
          const on = texture.id === selected;
          const tile = textureTileUrl(texture.id, appearance);
          const live = texture.id === "haze" || texture.id === "frost";
          return (
            <button
              key={texture.id}
              type="button"
              className={on ? "wp-tile is-on" : "wp-tile"}
              aria-pressed={on}
              onClick={() => onPick(texture.id)}
            >
              <span className={live ? `wp-tile__img wp-tile--${texture.id}` : "wp-tile__img"}>
                {tile !== "" ? <img src={tile} alt="" loading="lazy" /> : null}
                {texture.id === "haze" ? <span className="wp-tile__wash" aria-hidden="true" /> : null}
                {texture.id === "frost" ? <span className="wp-tile__tint" aria-hidden="true" /> : null}
              </span>
              <span className="wp-tile__label">{texture.label}</span>
            </button>
          );
        })}
      </div>

      {spec.delivery !== "none" ? (
        <div className="wp-intensity">
          <label className="wp-intensity__label" htmlFor={rangeId}>
            Intensity
          </label>
          <input
            id={rangeId}
            className="wp-intensity__range"
            type="range"
            min={0}
            max={100}
            step={5}
            value={percent}
            aria-label="Texture intensity"
            onChange={(e) => onIntensity(Number(e.target.value) / 100)}
          />
          <span className="wp-intensity__value">{percent}%</span>
        </div>
      ) : null}

      <p className="wp-tiles__desc">{spec.blurb}</p>
    </div>
  );
}
