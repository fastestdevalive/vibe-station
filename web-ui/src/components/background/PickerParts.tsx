import "./picker.css";

/** Solid │ Wallpaper segmented control; Wallpaper is disabled with no catalog. */
export interface ModeSegmentedProps {
  value: "solid" | "wallpaper";
  wallpaperDisabled: boolean;
  caption: string;
  onChange: (mode: "solid" | "wallpaper") => void;
}

export function ModeSegmented({
  value,
  wallpaperDisabled,
  caption,
  onChange,
}: ModeSegmentedProps): React.JSX.Element {
  return (
    <div className="wp-picker__mode">
      <div className="wp-seg" role="radiogroup" aria-label="App background">
        <button
          type="button"
          role="radio"
          aria-checked={value === "solid"}
          className={value === "solid" ? "wp-seg__btn is-on" : "wp-seg__btn"}
          onClick={() => onChange("solid")}
        >
          Solid
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={value === "wallpaper"}
          className={value === "wallpaper" ? "wp-seg__btn is-on" : "wp-seg__btn"}
          disabled={wallpaperDisabled}
          onClick={() => onChange("wallpaper")}
        >
          Wallpaper
        </button>
      </div>
      <span className="wp-picker__caption">{caption}</span>
    </div>
  );
}

export interface SelectionRowProps {
  /** A system pick (first-run roll or Shuffle), not a user choice: shows the chip. */
  picked: boolean;
  /** Chip copy; Settings says "Picked at first run" (design `pick-label`). */
  pickLabel: string;
  name: string;
  /** Trailing detail (the texture name, or "only here" in scope mode). */
  rest?: string;
  onShuffle?: () => void;
}

/** System-pick chip + the current selection + Shuffle, under the preview. */
export function SelectionRow({
  picked,
  pickLabel,
  name,
  rest,
  onShuffle,
}: SelectionRowProps): React.JSX.Element {
  return (
    <div className="wp-sel">
      <div className="wp-sel__text">
        {picked ? <span className="wp-picked">{pickLabel}</span> : null}
        <span className="wp-sel__name">{name}</span>
        {rest !== undefined && rest !== "" ? <span className="wp-sel__rest">{rest}</span> : null}
      </div>
      {onShuffle !== undefined ? (
        <button type="button" className="wp-btn" aria-label="Shuffle wallpaper" onClick={onShuffle}>
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M16 3h5v5" />
            <path d="M4 20L21 3" />
            <path d="M21 16v5h-5" />
            <path d="M15 15l6 6" />
            <path d="M4 4l5 5" />
          </svg>
          Shuffle
        </button>
      ) : null}
    </div>
  );
}

/** Scope mode's "Wallpaper · <label>" header. */
export function ScopeHeader({
  label,
  sub,
}: {
  label: string;
  sub: string;
}): React.JSX.Element {
  return (
    <header className="wp-scope__head">
      <span className="wp-scope__title">Wallpaper · {label}</span>
      <span className="wp-scope__sub">{sub}</span>
    </header>
  );
}
