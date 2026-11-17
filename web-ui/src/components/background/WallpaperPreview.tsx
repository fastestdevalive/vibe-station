import { useCallback, useState, type CSSProperties } from "react";
import type { BakedStatus } from "./bake/useBakedWallpaper";
import { layerVars, type BackgroundLook, type LookView } from "./backgroundLook";
import { MiniWindowChrome } from "./MiniWindowChrome";
import { WallpaperOverlay } from "./WallpaperOverlay";
import { WallpaperSlide } from "./WallpaperSlide";
import "./miniWindow.css";
import "./picker.css";

export interface WallpaperPreviewProps {
  /** null = plain theme colours (Solid, or the system high-contrast override). */
  id: string | null;
  sha?: string | null;
  /** From `lookFromPrefs`: the same values the window draws, so they cannot drift. */
  look: BackgroundLook;
  /** Accessible description of what the preview shows. */
  label: string;
}

const VIEWS: readonly { view: LookView; label: string }[] = [
  { view: "empty", label: "Empty chat" },
  { view: "session", label: "Session" },
];

/** Picks which of the two visibility values the preview renders. */
function PreviewViewSwitch({
  value,
  onChange,
}: {
  value: LookView;
  onChange: (view: LookView) => void;
}): React.JSX.Element {
  return (
    <div className="wp-seg wp-seg--overlay" role="radiogroup" aria-label="Preview shows">
      {VIEWS.map((option) => (
        <button
          key={option.view}
          type="button"
          role="radio"
          aria-checked={value === option.view}
          className={value === option.view ? "wp-seg__btn is-on" : "wp-seg__btn"}
          onClick={() => onChange(option.view)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The Picker preview: a miniature of the real window driven by the SAME
 * look the window draws — one `WallpaperSlide`, one `WallpaperOverlay`,
 * and the layer variables written on this root instead of `<html>`. Its
 * "Empty chat | Session" switch selects which visibility value it shows; the
 * choice is local, never persisted.
 */
export function WallpaperPreview({ id, sha, look, label }: WallpaperPreviewProps): React.JSX.Element {
  const [view, setView] = useState<LookView>("empty");
  const [status, setStatus] = useState<BakedStatus | null>(null);
  const onEffectStatus = useCallback((s: BakedStatus) => setStatus(s), []);
  const pending = id !== null && status === "baking";

  const vars: Record<string, string> = layerVars(look, view, id !== null);

  return (
    <div className="wp-preview-frame">
      <div className="wp-preview" role="img" aria-label={label} style={vars as CSSProperties}>
        {id !== null ? (
          <>
            {/* Keyed by id: the Picker is direct manipulation, so the picture swaps instantly. */}
            <WallpaperSlide
              key={id}
              id={id}
              phase="current"
              sha={sha ?? null}
              texture={look.texture}
              intensity={look.intensity}
              fillsWindow={false}
              onEffectStatus={onEffectStatus}
            />
            <WallpaperOverlay gradient={look.gradient} />
          </>
        ) : null}
        <MiniWindowChrome view={view} />
        {pending ? <span className="wp-preview__pending">Applying {look.texture.label}…</span> : null}
      </div>
      <PreviewViewSwitch value={view} onChange={setView} />
    </div>
  );
}
