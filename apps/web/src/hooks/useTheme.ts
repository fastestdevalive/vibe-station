import { useEffect, useState, useCallback } from "react";

type Theme = "dark" | "light";
type Font = "mono" | "sans";

const THEME_KEY = "viberun:theme";
const FONT_KEY = "viberun:font";

function parseTheme(raw: string | null): Theme {
  return raw === "dark" || raw === "light" ? raw : "dark";
}

function parseFont(raw: string | null): Font {
  return raw === "mono" || raw === "sans" ? raw : "mono";
}

function readInitialTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return parseTheme(localStorage.getItem(THEME_KEY));
}

function readInitialFont(): Font {
  if (typeof window === "undefined") return "mono";
  return parseFont(localStorage.getItem(FONT_KEY));
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readInitialTheme);
  const [font, setFont] = useState<Font>(readInitialFont);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    const fontVar = font === "mono" ? "var(--font-mono)" : "var(--font-sans)";
    document.documentElement.style.setProperty("--font-family", fontVar);
    localStorage.setItem(FONT_KEY, font);
  }, [font]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  const toggleFont = useCallback(() => {
    setFont((f) => (f === "mono" ? "sans" : "mono"));
  }, []);

  return { theme, font, toggleTheme, toggleFont };
}
