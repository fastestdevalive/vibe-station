import type { ITheme } from "@xterm/xterm";

/** Matches tokens.css `[data-theme]` accent — xterm cannot use CSS variables here */
const ACCENT = {
  cursor: "#6e78c7",
  selDark: "rgba(110, 120, 199, 0.30)",
  selLight: "rgba(92, 100, 181, 0.25)",
};

/**
 * ao-142-style terminal palettes (`terminal-themes.ts`) adapted for viberun:
 * accent-driven cursor/selection, tuned ANSI colors, IDE-matched dark surface.
 */
export function buildTerminalThemes(): { dark: ITheme; light: ITheme } {
  const dark: ITheme = {
    background: "#0f0f0f",
    foreground: "#d4d4d8",
    cursor: ACCENT.cursor,
    cursorAccent: "#0f0f0f",
    selectionBackground: ACCENT.selDark,
    selectionInactiveBackground: "rgba(128, 128, 128, 0.2)",
    black: "#1a1a24",
    red: "#ef4444",
    green: "#22c55e",
    yellow: "#f59e0b",
    blue: "#6e78c7",
    magenta: "#a371f7",
    cyan: "#22d3ee",
    white: "#d4d4d8",
    brightBlack: "#50506a",
    brightRed: "#f87171",
    brightGreen: "#4ade80",
    brightYellow: "#fbbf24",
    brightBlue: "#939ce9",
    brightMagenta: "#c084fc",
    brightCyan: "#67e8f9",
    brightWhite: "#eeeef5",
  };

  const light: ITheme = {
    background: "#fafafa",
    foreground: "#24292f",
    cursor: ACCENT.cursor,
    cursorAccent: "#fafafa",
    selectionBackground: ACCENT.selLight,
    selectionInactiveBackground: "rgba(128, 128, 128, 0.15)",
    black: "#24292f",
    red: "#b42318",
    green: "#1f7a3d",
    yellow: "#8a5a00",
    blue: "#175cd3",
    magenta: "#8e24aa",
    cyan: "#0b7285",
    white: "#4b5563",
    brightBlack: "#374151",
    brightRed: "#912018",
    brightGreen: "#176639",
    brightYellow: "#6f4a00",
    brightBlue: "#1d4ed8",
    brightMagenta: "#7b1fa2",
    brightCyan: "#155e75",
    brightWhite: "#374151",
  };

  return { dark, light };
}

export function ideThemeToXterm(ide: "dark" | "light"): ITheme {
  const { dark, light } = buildTerminalThemes();
  return ide === "light" ? light : dark;
}

/** ao-142: dim ANSI on white needs a contrast floor or text disappears */
export function terminalMinimumContrastRatio(ide: "dark" | "light"): number {
  return ide === "light" ? 7 : 1;
}
