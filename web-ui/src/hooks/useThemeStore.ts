import { create } from "zustand";
import { defaultThemeId, themeById } from "@/theme/registry";

export type ThemeAppearance = "dark" | "light";
export type Font = "mono" | "sans";

export const DEFAULT_FONT: Font = "mono";

/**
 * Resolve a raw theme id to a registry entry, falling back to the default
 * (`vibestation-dark`) for an unknown id. Unknown ids are possible (a theme
 * deprecated server-side, or a stale localStorage cache) — the fallback keeps
 * the app rendering instead of dropping to bare `:root` tokens.
 */
function resolveAppearance(themeId: string): ThemeAppearance {
  return themeById[themeId]?.appearance ?? themeById[defaultThemeId]!.appearance;
}

interface ThemeStore {
  /** The full 14-way theme id (see `web-ui/src/theme/registry.ts`). */
  themeId: string;
  /** Derived from `themeId` via the registry — "dark" | "light". */
  appearance: ThemeAppearance;
  font: Font;
  /**
   * Set the theme id, updating the store AND both root DOM attributes
   * (`data-theme` + `data-appearance`) so every consumer — including Shiki
   * highlighting that bakes colors as inline styles — re-renders together.
   * Safe to call repeatedly; unknown ids fall back to the default.
   */
  setThemeId: (id: string) => void;
  setFont: (font: Font) => void;
}

export const useThemeStore = create<ThemeStore>()((set) => ({
  themeId: defaultThemeId,
  appearance: themeById[defaultThemeId]!.appearance,
  font: DEFAULT_FONT,

  setThemeId: (id) => {
    const entry = themeById[id] ?? themeById[defaultThemeId]!;
    set({ themeId: entry.id, appearance: entry.appearance });
    document.documentElement.dataset.theme = entry.id;
    document.documentElement.dataset.appearance = entry.appearance;
  },

  setFont: (font) => {
    set({ font });
    const fontVar = font === "mono" ? "var(--font-mono)" : "var(--font-sans)";
    document.documentElement.style.setProperty("--font-family", fontVar);
  },
}));
