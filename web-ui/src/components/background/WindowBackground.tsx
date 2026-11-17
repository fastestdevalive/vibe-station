import type { ScreenKind } from "./resolveWallpaper";
import { useBackground } from "./useBackground";
import { useWallpaperCatalog } from "./useWallpaperCatalog";
import { useWallpaperTransition } from "./useWallpaperTransition";
import { WallpaperOverlay } from "./WallpaperOverlay";
import { WallpaperSlide } from "./WallpaperSlide";
import "./windowBackground.css";

/**
 * One wallpaper behind the whole window. Mounted as the last child of
 * `.app-shell` (see `BackgroundMount`), painted at `z-index: -1` so it sits
 * below every panel without moving any pane in the React tree.
 *
 * The current picture stays mounted (keyed by id) until the next complete
 * picture is ready, then dissolves in on top of it (see `useWallpaperTransition`).
 */
export function WindowBackground({ kind }: { kind?: ScreenKind }) {
  const background = useBackground(kind);
  const catalog = useWallpaperCatalog();
  const { state, onReady, onFadeEnd } = useWallpaperTransition(background.imageId);

  if (state.phase === "empty") return null;

  const shaFor = (id: string): string | null =>
    catalog.wallpapers.find((w) => w.id === id)?.fullSizeSha ?? null;
  const shared = {
    texture: background.texture,
    intensity: background.intensity,
    onReady,
    onFadeEnd,
  };

  return (
    <div className="window-bg" aria-hidden="true" data-has-image="true">
      <WallpaperSlide
        key={state.current.id}
        id={state.current.id}
        phase="current"
        sha={shaFor(state.current.id)}
        {...shared}
      />
      {state.phase === "settled" ? null : (
        <WallpaperSlide
          key={state.incoming.id}
          id={state.incoming.id}
          phase={state.phase === "fading" ? "fading" : "incoming"}
          sha={shaFor(state.incoming.id)}
          {...shared}
        />
      )}
      <WallpaperOverlay gradient={background.gradient} />
    </div>
  );
}
