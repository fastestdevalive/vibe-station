import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useThemeStore } from "@/hooks/useThemeStore";
import { objectPosition } from "../focal";
import { PictureLayer } from "../WallpaperPicture";
import type { TextureSpec } from "../textureCatalog";
import { useBakedWallpaper, type BakedStatus } from "../bake/useBakedWallpaper";
import { FrostLayer } from "./FrostLayer";
import { HazeLayer } from "./HazeLayer";
import "./effects.css";

/**
 * The texture over the wallpaper: a baked picture for the drawn textures, live
 * CSS layers for Haze/Frost. The props are the contract both paths code against.
 */
export interface WallpaperEffectProps {
  id: string;
  /** Object URL (or bundled thumb) of the base wallpaper, for CSS effects. */
  src: string | null;
  /** Catalog sha of the full image; part of the bake cache key. */
  sha?: string | null;
  texture: TextureSpec;
  intensity: number;
  fillsWindow?: boolean;
  onStatus?: (s: "idle" | "baking" | "ready" | "failed") => void;
}

/** Matches the debounce the plan fixes for resize-driven re-bakes. */
const RESIZE_DEBOUNCE_MS = 500;

/**
 * The box the effect fills, in CSS pixels. The layer is absolute and fills
 * its slide. The slide fills the window only in WindowBackground; previews
 * pass fillsWindow=false so they do not bake at window size before measuring.
 * ResizeObserver is absent in jsdom (and a zero-sized box means nothing was
 * measured), so both fall back to the window size inside measure().
 */
function useEffectBox(fillsWindow = true) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState(() => ({
    width: !fillsWindow || typeof window === "undefined" ? 0 : window.innerWidth,
    height: !fillsWindow || typeof window === "undefined" ? 0 : window.innerHeight,
  }));

  useEffect(() => {
    const element = ref.current;
    const measure = () => {
      const rect = element?.getBoundingClientRect();
      const width = rect !== undefined && rect.width > 0 ? rect.width : window.innerWidth;
      const height = rect !== undefined && rect.height > 0 ? rect.height : window.innerHeight;
      setBox((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };

    measure();
    if (element === null || typeof ResizeObserver === "undefined") return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        measure();
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(element);
    return () => {
      if (timer !== null) clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  return { ref, box };
}

export function WallpaperEffect({
  id,
  src,
  sha,
  texture,
  intensity,
  fillsWindow = true,
  onStatus,
}: WallpaperEffectProps) {
  const appearance = useThemeStore((s) => s.appearance);
  const { ref, box } = useEffectBox(fillsWindow);

  // The bake covers the box at device resolution (capped at 2x, as the design does).
  const ratio = Math.min(typeof window === "undefined" ? 1 : window.devicePixelRatio || 1, 2);
  const baked = useBakedWallpaper({
    id,
    sha: sha ?? null,
    texture,
    appearance,
    size: { width: Math.round(box.width * ratio), height: Math.round(box.height * ratio) },
  });

  // A bake that was already in memory when this slide mounted is part of its
  // first paint; only one that lands later dissolves in (see `windowBackground.css`).
  const [readyOnMount] = useState(() => baked.status === "ready" && baked.url !== null);
  const arriving = !readyOnMount && baked.status === "ready" && baked.url !== null;

  // Report only real transitions: the Picker shows "Applying…" from "baking".
  const reported = useRef<BakedStatus | null>(null);
  useEffect(() => {
    if (reported.current === baked.status) return;
    reported.current = baked.status;
    onStatus?.(baked.status);
  }, [baked.status, onStatus]);

  if (texture.delivery === "none") return null;

  const focal = { "--wp-focal": objectPosition(id) } as CSSProperties;

  if (texture.delivery === "css") {
    if (src === null) return null;
    return (
      <div className="wp-effect" ref={ref} style={focal}>
        {texture.id === "haze" ? (
          <HazeLayer src={src} intensity={intensity} />
        ) : texture.id === "frost" ? (
          <FrostLayer src={src} intensity={intensity} />
        ) : null}
      </div>
    );
  }

  return (
    // Opacity on the wrapper, not the image: `.wp-picture--arriving`'s slide-in
    // animation (fill `both`) would override an inline opacity on the image.
    <div className="wp-effect" ref={ref} style={{ ...focal, opacity: intensity }}>
      {baked.url === null ? null : (
        <PictureLayer
          id={id}
          src={baked.url}
          className={arriving ? "wp-picture--arriving" : undefined}
        />
      )}
    </div>
  );
}
