import { fnv1a32 } from "../hash";

/**
 * xorshift32, seeded per texture + output size: the same wallpaper size always
 * bakes the same pixels, so the Cache API entry stays valid across reloads.
 */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  // xorshift32 can never leave the all-zero state.
  if (s === 0) s = 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

/** Bake seed for a texture at one output size (`fnv1a32(texture + ":" + WxH)`). */
export function bakeSeed(texture: string, width: number, height: number): number {
  return fnv1a32(`${texture}:${width}x${height}`);
}
