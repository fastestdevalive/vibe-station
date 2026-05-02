import type { ITheme } from "@xterm/xterm";

/** xterm palette aligned with tokens.css dark/light surfaces */
export function ideThemeToXterm(ide: "dark" | "light"): ITheme {
  if (ide === "light") {
    return {
      background: "#fafafa",
      foreground: "#171717",
      cursor: "#171717",
      cursorAccent: "#fafafa",
      selectionBackground: "rgba(23, 23, 23, 0.12)",
      selectionInactiveBackground: "rgba(23, 23, 23, 0.08)",
      black: "#171717",
      red: "#cd3131",
      green: "#008000",
      yellow: "#795e26",
      blue: "#0451a5",
      magenta: "#bc05bc",
      cyan: "#0598bc",
      white: "#3b3b3b",
      brightBlack: "#616161",
      brightRed: "#e51400",
      brightGreen: "#00a418",
      brightYellow: "#bf8803",
      brightBlue: "#0451a5",
      brightMagenta: "#bc05bc",
      brightCyan: "#0598bc",
      brightWhite: "#171717",
    };
  }
  return {
    background: "#0f0f0f",
    foreground: "#e5e5e5",
    cursor: "#e5e5e5",
    cursorAccent: "#0f0f0f",
    selectionBackground: "rgba(229, 229, 229, 0.18)",
    selectionInactiveBackground: "rgba(229, 229, 229, 0.10)",
    black: "#000000",
    red: "#cd3131",
    green: "#0dbc79",
    yellow: "#e5e510",
    blue: "#2472c8",
    magenta: "#bc3fbc",
    cyan: "#11a8cd",
    white: "#e5e5e5",
    brightBlack: "#666666",
    brightRed: "#f14c4c",
    brightGreen: "#23d18b",
    brightYellow: "#f5f543",
    brightBlue: "#3b8eea",
    brightMagenta: "#d670d6",
    brightCyan: "#29b8db",
    brightWhite: "#ffffff",
  };
}
