import type { WallpaperEntry } from "@/api/types";
import { objectPosition } from "./focal";
import { thumbUrl } from "./thumbs";
import "./picker.css";

/** Scope mode's Default tile: the wallpaper this scope resolves to with no override. */
export interface WallpaperGridDefaultTile {
  /** Catalog id Default resolves to, or null while the catalog is unknown. */
  wallpaperId: string | null;
  caption: string;
  selected: boolean;
  onPick: () => void;
}

/** Scope mode's None tile: solid on this screen only. */
export interface WallpaperGridNoneTile {
  caption: string;
  selected: boolean;
  onPick: () => void;
}

export interface WallpaperGridProps {
  wallpapers: WallpaperEntry[];
  /** Selected catalog id; null when Default / None is the active choice. */
  selectedId: string | null;
  onPick: (id: string) => void;
  /** Scope mode only: these two tiles come before the catalog grid. */
  defaultTile?: WallpaperGridDefaultTile;
  noneTile?: WallpaperGridNoneTile;
}

function Check(): React.JSX.Element {
  return (
    <span className="wp-thumb__check" aria-hidden="true">
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 12l5 5L20 7" />
      </svg>
    </span>
  );
}

/**
 * The wallpaper grid shared by the app Picker and the scope Picker: 16:9 thumbs
 * cropped at each image's focal point, accent ring + check on the selection.
 * Scope mode prepends the Default and None cards (design Picker.dc.html).
 */
export function WallpaperGrid({
  wallpapers,
  selectedId,
  onPick,
  defaultTile,
  noneTile,
}: WallpaperGridProps): React.JSX.Element {
  const defaultThumb =
    defaultTile?.wallpaperId != null ? thumbUrl(defaultTile.wallpaperId) : undefined;

  return (
    <div className="wp-grid-wrap">
      {defaultTile !== undefined || noneTile !== undefined ? (
        <div className="wp-cards">
          {defaultTile !== undefined ? (
            <button
              type="button"
              className={defaultTile.selected ? "wp-card is-on" : "wp-card"}
              aria-pressed={defaultTile.selected}
              onClick={defaultTile.onPick}
            >
              {defaultTile.wallpaperId !== null && defaultThumb !== undefined ? (
                <img
                  className="wp-card__thumb"
                  src={defaultThumb}
                  alt=""
                  style={{ objectPosition: objectPosition(defaultTile.wallpaperId) }}
                />
              ) : (
                <span className="wp-card__swatch" aria-hidden="true" />
              )}
              <span className="wp-card__txt">
                <span className="wp-card__title">Default</span>
                <span className="wp-card__cap">{defaultTile.caption}</span>
              </span>
            </button>
          ) : null}
          {noneTile !== undefined ? (
            <button
              type="button"
              className={noneTile.selected ? "wp-card is-on" : "wp-card"}
              aria-pressed={noneTile.selected}
              onClick={noneTile.onPick}
            >
              <span className="wp-card__swatch" aria-hidden="true" />
              <span className="wp-card__txt">
                <span className="wp-card__title">None</span>
                <span className="wp-card__cap">{noneTile.caption}</span>
              </span>
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="wp-grid">
        {wallpapers.map((wallpaper) => {
          const selected = wallpaper.id === selectedId;
          const thumb = thumbUrl(wallpaper.id);
          return (
            <button
              key={wallpaper.id}
              type="button"
              className={selected ? "wp-thumb is-on" : "wp-thumb"}
              aria-pressed={selected}
              aria-label={wallpaper.name}
              onClick={() => onPick(wallpaper.id)}
            >
              {thumb !== undefined ? (
                <img
                  className="wp-thumb__img"
                  src={thumb}
                  alt=""
                  loading="lazy"
                  style={{ objectPosition: objectPosition(wallpaper.id) }}
                />
              ) : null}
              <span className="wp-thumb__name" aria-hidden="true">
                {wallpaper.name}
              </span>
              {selected ? <Check /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
