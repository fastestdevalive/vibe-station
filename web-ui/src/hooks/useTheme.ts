import { useCallback, useEffect } from "react";
import { api } from "@/api";
import { defaultThemeId, themeById } from "@/theme/registry";
import { useThemeStore, type Font } from "./useThemeStore";

const THEME_KEY = "vibestation:theme";
const FONT_KEY = "vibestation:font";

/**
 * Module-level boot singleton: `useTheme` is consumed by many components, and
 * all of them must share ONE `GET /settings` seed + ONE `settings:updated`
 * WS subscription at app boot — not N copies (that was the original stale-color
 * bug's shape). The store itself is the shared subscription all consumers
 * render off, so a single seed fans out to every mounted instance.
 */
let booted = false;
let bootOff: (() => void) | null = null;

/** Read the localStorage first-paint cache, mapping legacy `"dark"|"light"` to
 *  the renamed `vibestation-dark`/`vibestation-light` ids. Returns null when
 *  there's nothing usable. */
function readCachedThemeId(): string | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(THEME_KEY);
  if (raw === "dark") return "vibestation-dark";
  if (raw === "light") return "vibestation-light";
  if (raw && themeById[raw]) return raw;
  return null;
}

function applyThemeId(id: string): void {
  useThemeStore.getState().setThemeId(id);
}

function applyFont(font: Font): void {
  useThemeStore.getState().setFont(font);
  if (typeof window !== "undefined") localStorage.setItem(FONT_KEY, font);
}

/**
 * One-time localStorage→server migration (Research: guarded against a race).
 * Only fires when `GET /settings` returns no `themeId` — once any client has
 * migrated successfully, every other client's GET already returns a value and
 * skips this branch entirely, so a second tab can't overwrite a value another
 * device already set.
 */
async function migrateLegacyTheme(): Promise<void> {
  if (typeof window === "undefined") return;
  const raw = localStorage.getItem(THEME_KEY);
  if (raw !== "dark" && raw !== "light") return;
  const mapped = raw === "light" ? "vibestation-light" : "vibestation-dark";
  await api.updateSettings({ themeId: mapped });
  applyThemeId(mapped);
  localStorage.setItem(THEME_KEY, mapped);
}

export function useTheme() {
  const theme = useThemeStore((s) => s.appearance);
  const themeId = useThemeStore((s) => s.themeId);
  const font = useThemeStore((s) => s.font);

  useEffect(() => {
    if (booted) return;
    booted = true;

    // First-paint hint, applied synchronously before any server round-trip so
    // the page never flashes the wrong theme.
    const hint = readCachedThemeId();
    if (hint) applyThemeId(hint);
    const cachedFont = typeof window !== "undefined" ? localStorage.getItem(FONT_KEY) : null;
    if (cachedFont === "mono" || cachedFont === "sans") applyFont(cachedFont);

    void (async () => {
      try {
        const settings = await api.getSettings();
        if (settings.themeId) {
          // Server value wins once it resolves.
          applyThemeId(settings.themeId);
          if (typeof window !== "undefined") localStorage.setItem(THEME_KEY, settings.themeId);
        } else {
          await migrateLegacyTheme();
        }
      } catch {
        // Server unreachable — keep the localStorage hint; a later
        // `settings:updated` or reconnect will reconcile.
      }
    })();

    // Live sync: every `settings:updated` (including the echo of this client's
    // own PATCH, and another tab/device's change) fans out via the store to
    // every consumer — no remount needed.
    bootOff = api.on("settings:updated", (ev) => {
      if (ev.type === "settings:updated" && ev.themeId) applyThemeId(ev.themeId);
    });
  }, []);

  const setTheme = useCallback((id: string) => {
    applyThemeId(id); // optimistic, instant for every consumer
    void api
      .updateSettings({ themeId: id })
      .then(() => {
        if (typeof window !== "undefined") localStorage.setItem(THEME_KEY, id);
      })
      .catch(() => {
        // Keep the optimistic value; the next GET /settings or settings:updated
        // reconciles it with the server.
      });
  }, []);

  const setFont = useCallback((font: Font) => {
    applyFont(font);
  }, []);

  const toggleTheme = useCallback(() => {
    const current = useThemeStore.getState().themeId;
    const next = current === "vibestation-light" ? "vibestation-dark" : "vibestation-light";
    setTheme(next);
  }, [setTheme]);

  const toggleFont = useCallback(() => {
    const current = useThemeStore.getState().font;
    setFont(current === "mono" ? "sans" : "mono");
  }, [setFont]);

  return { theme, themeId, font, setTheme, toggleTheme, toggleFont };
}

/** Test-only: reset the module-level boot singleton + store for isolation. */
export function __resetThemeSyncForTests(): void {
  booted = false;
  bootOff?.();
  bootOff = null;
  const entry = themeById[defaultThemeId]!;
  useThemeStore.setState({ themeId: defaultThemeId, appearance: entry.appearance, font: "mono" });
}
