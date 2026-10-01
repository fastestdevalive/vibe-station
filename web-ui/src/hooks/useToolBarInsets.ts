import type { CSSProperties } from "react";
import { useTopRightInset } from "@/context/TopRightInsetContext";

/** Pixels reserved at a tools-pane top bar's right edge for the floating
 *  layout-orientation + fullscreen buttons (`ToolPanel`'s `.tool-panel__top-actions`). */
const TOP_ACTIONS_WIDTH = 68;

/**
 * Horizontal padding for every tools-pane side-panel top bar (Files tree,
 * Search, Outline, References), so they all clear the same floating controls:
 *
 * - right: only while stacked (`vertical`) does the bar reach the top-right
 *   corner where the floating buttons sit; side-by-side it's a narrow left
 *   column that never does.
 * - left: on mobile the show/hide-rail toggle occupies the top-left slot
 *   (`--tools-toggle-w`). While the rail is shown the panel already starts to
 *   its right (`--tools-rail-w`); once the rail is hidden the panel moves left
 *   under the toggle (both orientations), so the BAR (not the body — the
 *   content is meant to use the freed width) keeps clear of it.
 */
export function useToolBarInsets(vertical: boolean): CSSProperties {
  const outerInset = useTopRightInset();
  return {
    paddingLeft:
      "calc(var(--space-2) + max(0px, var(--tools-toggle-w, 0px) - var(--tools-rail-w, 36px)))",
    paddingRight: vertical ? `${TOP_ACTIONS_WIDTH + outerInset.width}px` : "var(--space-2)",
  };
}
