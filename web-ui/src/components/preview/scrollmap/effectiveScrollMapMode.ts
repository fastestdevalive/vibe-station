import type { FileScrollMap } from "@/api/types";
import { overMinimapCap } from "./minimapSummary";

/** The minimap costs 56px. Below this scroller width the code keeps fewer than ~48 columns at the default 13px
 *  mono font (gutter ~48px + 48 x 7.8px + 56px), so marks are shown instead. 480, not 600: the default desktop
 *  layout at a 1440px window gives the preview ~500px, and a 600 threshold would hide the new default there. */
export const MINIMAP_MIN_PANE_WIDTH = 480;
export type ScrollMapFallback = "fits" | "phone" | "diff" | "overCap" | "narrow" | "unavailable";

export interface EffectiveScrollMap {
  display: "none" | "marks" | "minimap";
  forced: ScrollMapFallback | null;
}

export interface ScrollMapContext {
  view: "code" | "diff";
  scrollable: boolean;
  isPhone: boolean;
  /** The scroller's border-box width (independent of the scrollbar the chosen mode shows). */
  paneWidth: number;
  lineCount: number;
  byteLength: number;
  minimapAvailable: boolean;
}

export function effectiveScrollMapMode(setting: FileScrollMap, ctx: ScrollMapContext): EffectiveScrollMap {
  if (!ctx.scrollable) {
    return { display: "none", forced: "fits" };
  }
  if (ctx.isPhone) {
    return { display: "marks", forced: "phone" };
  }
  if (ctx.view === "diff") {
    return { display: "marks", forced: "diff" };
  }
  if (overMinimapCap(ctx.lineCount, ctx.byteLength)) {
    return { display: "marks", forced: "overCap" };
  }
  if (ctx.paneWidth < MINIMAP_MIN_PANE_WIDTH) {
    return { display: "marks", forced: "narrow" };
  }
  if (!ctx.minimapAvailable) {
    return { display: "marks", forced: "unavailable" };
  }
  return { display: setting, forced: null };
}
