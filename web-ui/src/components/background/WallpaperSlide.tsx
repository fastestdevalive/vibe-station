import { useCallback, useEffect, useRef, useState } from "react";
import type { BakedStatus } from "./bake/useBakedWallpaper";
import type { TextureSpec } from "./textureCatalog";
import { PictureLayer } from "./WallpaperPicture";
import { useWallpaperImage } from "./useWallpaperImage";
import { WallpaperEffect } from "./effects/WallpaperEffect";

/** A slide's role in the window dissolve (see `useWallpaperTransition`). */
export type SlidePhase = "current" | "incoming" | "fading";

export interface WallpaperSlideProps {
  id: string;
  phase: SlidePhase;
  sha: string | null;
  texture: TextureSpec;
  intensity: number;
  fillsWindow?: boolean;
  /** Called once, when this slide's complete picture (image + effect) is ready. */
  onReady?: (id: string) => void;
  /** Called when this slide's fade-in animation finished. */
  onFadeEnd?: (id: string) => void;
  /** Reports the effect's bake status; the Picker preview shows "Applying…" from it. */
  onEffectStatus?: (s: BakedStatus) => void;
}

/**
 * One complete picture: the plain image with its texture over it. `WindowBackground`
 * keys it by id, so the picture that stays on screen never remounts (its decoded
 * image and baked URL stay put), while a texture or intensity change updates it live.
 */
export function WallpaperSlide({
  id,
  phase,
  sha,
  texture,
  intensity,
  fillsWindow = true,
  onReady,
  onFadeEnd,
  onEffectStatus,
}: WallpaperSlideProps): React.JSX.Element {
  const image = useWallpaperImage(id);
  // null until the effect has reported: a baked texture must not count as ready
  // before its first bake status arrives.
  const [effectStatus, setEffectStatus] = useState<BakedStatus | null>(null);
  const reported = useRef(false);

  // Stable identity: `WallpaperEffect` reports through an effect keyed on it.
  const reportEffect = useCallback(
    (s: BakedStatus) => {
      setEffectStatus(s);
      onEffectStatus?.(s);
    },
    [onEffectStatus],
  );

  const plainSettled = image.status === "ready" || image.status === "failed";
  const effectSettled = effectStatus !== null && effectStatus !== "baking";

  useEffect(() => {
    if (reported.current || !plainSettled || !effectSettled) return;
    reported.current = true;
    onReady?.(id);
  }, [id, plainSettled, effectSettled, onReady]);

  return (
    <div
      className="window-bg__slide"
      data-phase={phase}
      onAnimationEnd={(event) => {
        // A baked layer arriving later animates inside the slide too; only the
        // slide's own fade-in ends the dissolve.
        if (event.target === event.currentTarget) onFadeEnd?.(id);
      }}
    >
      {image.src === null ? null : (
        <PictureLayer id={id} src={image.src} isThumb={image.isThumb} />
      )}
      <WallpaperEffect
        id={id}
        src={image.src}
        sha={sha}
        texture={texture}
        intensity={intensity}
        fillsWindow={fillsWindow}
        onStatus={reportEffect}
      />
    </div>
  );
}
