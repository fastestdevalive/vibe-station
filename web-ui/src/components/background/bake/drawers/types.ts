/**
 * A drawer is a pure function over `{data,width,height}` (no canvas, no DOM), so
 * the exact same code runs in the bake worker and in jsdom tests. The effect is
 * computed at full strength and blended over the source at `intensity`, which is
 * how `surface-style-lib` composites its textures (a layer whose alpha is the
 * slider value).
 */
export interface DrawerOptions {
  intensity: number;
  appearance: "dark" | "light";
  seed: number;
}

export type Drawer = (img: ImageData, opts: DrawerOptions) => ImageData;
