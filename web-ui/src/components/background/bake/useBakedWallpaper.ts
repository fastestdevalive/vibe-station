import { useEffect, useState } from "react";
import type { BakedTextureId } from "./protocol";
import { getBakedUrl, peekBakedUrl, pinBaked, rememberBaked } from "./bakeCache";
import { bake, bakeSize } from "./bakeClient";
import { bakeKey } from "./bakeKey";
import type { TextureSpec } from "../textureCatalog";

export type BakedStatus = "idle" | "baking" | "ready" | "failed";

export interface UseBakedWallpaperArgs {
  id: string;
  sha?: string | null;
  texture: TextureSpec;
  appearance: "dark" | "light";
  /** Device pixels of the box the effect fills. */
  size: { width: number; height: number };
}

export interface BakedWallpaper {
  /** Object URL of the baked image, or null while baking / on failure. */
  url: string | null;
  status: BakedStatus;
}

interface BakedState extends BakedWallpaper {
  /** The bake key this state belongs to; a different key resets it. */
  key: string | null;
}

/**
 * State for one bake key. A key already in the memory tier is `ready` straight
 * away — that is what makes switching back to a baked pair flash-free.
 */
function initialState(key: string | null, delivery: TextureSpec["delivery"]): BakedState {
  if (delivery !== "baked") return { key: null, url: null, status: "idle" };
  if (key === null) return { key: null, url: null, status: "baking" };
  const url = peekBakedUrl(key);
  return { key, url, status: url === null ? "baking" : "ready" };
}

/**
 * The baked image for one wallpaper + texture + box size. The key is derived in
 * render, and a memory-tier hit is shown on the very first render of that key;
 * a miss goes through the Cache API and then the worker. `failed` means the
 * plain wallpaper keeps showing.
 *
 * Intensity is deliberately not an input: the bake is drawn at full strength and
 * the layer's opacity applies the slider value (`WallpaperEffect`), so the slider
 * never re-bakes.
 *
 * The hook never revokes its URL: `bakeCache` owns the memory tier and revokes
 * an entry when it is evicted, so a URL survives the switch it was shown for.
 */
export function useBakedWallpaper(args: UseBakedWallpaperArgs): BakedWallpaper {
  const { id, sha, texture, appearance } = args;
  const width = args.size.width;
  const height = args.size.height;
  const delivery = texture.delivery;
  const textureId = texture.id;

  const key =
    delivery === "baked" && width > 0 && height > 0
      ? bakeKey({
          id,
          sha: sha ?? null,
          texture: textureId as BakedTextureId,
          appearance,
          ...bakeSize(width, height),
        })
      : null;

  const [state, setState] = useState<BakedState>(() => initialState(key, delivery));
  // React's "adjust state when an input changes" pattern: reading the memory
  // tier here (not in an effect) is what removes the frame without the bake.
  if (state.key !== key) setState(initialState(key, delivery));

  useEffect(() => {
    if (key === null) return;
    const unpin = pinBaked(key);
    if (state.key === key && state.url !== null) return unpin;

    let cancelled = false;
    const input = {
      id,
      sha: sha ?? null,
      texture: textureId as BakedTextureId,
      appearance,
      ...bakeSize(width, height),
    };

    getBakedUrl(key)
      .then((url) => {
        if (url !== null) {
          if (!cancelled) setState({ key, url, status: "ready" });
          return;
        }
        return bake(input).then((blob) => {
          const remembered = rememberBaked(key, blob);
          if (!cancelled) setState({ key, url: remembered, status: "ready" });
        });
      })
      .catch(() => {
        if (!cancelled) setState({ key, url: null, status: "failed" });
      });

    return () => {
      cancelled = true;
      unpin();
    };
    // `key` is a pure function of every input above, so it is the only dependency.
  }, [key]);

  return { url: state.url, status: state.status };
}
