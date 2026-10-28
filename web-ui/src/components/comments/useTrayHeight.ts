import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { useDemoEnv } from "@/context/DemoEnv";
import { PANE_ROW_H } from "@/lib/layoutSizes";

/** One value per device (not per worktree); a bad or missing value means the default. */
export const TRAY_HEIGHT_KEY = "vst:comments:trayHeight";
/** The list never gets smaller than its section header plus one full row (the strip is separate). */
export const TRAY_LIST_MIN = 120;
/** The file preview always keeps its tab bar plus this much (the same 96px as `DockedListLayout`). */
export const PREVIEW_MIN = 96;
export const PREVIEW_RESERVE = PANE_ROW_H + PREVIEW_MIN;
/** Used while the column is not measured yet (first paint, jsdom). */
const UNMEASURED_MAX = 4000;
const STRIP_FALLBACK = 40;
/** Border lines of the tray (top) and the list (bottom). */
const BORDERS = 2;

/** `min(424px, 60vh)`, the CSS default the list had before it became resizable. */
export const trayDefault = () => Math.min(424, Math.round(window.innerHeight * 0.6));

export function readStoredTrayHeight(): number | null {
  try {
    const raw = globalThis.localStorage?.getItem(TRAY_HEIGHT_KEY);
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function writeStoredTrayHeight(n: number | null): void {
  try {
    if (n == null) globalThis.localStorage?.removeItem(TRAY_HEIGHT_KEY);
    else globalThis.localStorage?.setItem(TRAY_HEIGHT_KEY, String(Math.round(n)));
  } catch {
    // Storage blocked or full: the size just isn't kept.
  }
}

/** Clamp into `[min, max]`; when the column is too short for both, the list shrinks (never below 0), not the preview. */
export function clampTrayHeight(v: number, min: number, max: number): number {
  const hi = Math.max(max, 0);
  const lo = Math.min(min, hi);
  return Math.min(Math.max(v, lo), hi);
}

export interface TrayHeight {
  /** The list height to render now (the drag value while dragging, else the stored/default size, clamped). */
  shown: number;
  min: number;
  max: number;
  /** Live value while dragging (null ends the drag). Never stored. */
  setDraft: (n: number | null) => void;
  /** Store a size (clamped now; the stored value itself is never overwritten by a later re-clamp). */
  commit: (n: number) => void;
  /** Forget the stored size: back to the default. */
  reset: () => void;
}

/**
 * Height of the expanded comments list. The stored size is clamped against the tray's parent column on every
 * column resize (window, rail, fullscreen, rotation) but never written back, so a larger window restores it.
 */
export function useTrayHeight(trayRef: RefObject<HTMLElement | null>, active: boolean): TrayHeight {
  const env = useDemoEnv();
  const k = env.demo && env.scale > 0 ? env.scale : 1;
  const [stored, setStored] = useState<number | null>(readStoredTrayHeight);
  const [draft, setDraft] = useState<number | null>(null);
  const [limits, setLimits] = useState<{ min: number; max: number }>({ min: TRAY_LIST_MIN, max: UNMEASURED_MAX });

  useLayoutEffect(() => {
    const tray = trayRef.current;
    const column = tray?.parentElement;
    if (!active || !tray || !column) return undefined;
    const measure = () => {
      const colH = column.getBoundingClientRect().height / k;
      const strip = tray.querySelector<HTMLElement>(".comment-tray__strip");
      const stripH = (strip?.getBoundingClientRect().height ?? 0) / k || STRIP_FALLBACK;
      const max = colH > 0 ? Math.floor(colH - stripH - BORDERS - PREVIEW_RESERVE) : UNMEASURED_MAX;
      setLimits((cur) => (cur.max === max ? cur : { min: TRAY_LIST_MIN, max }));
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(column);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [trayRef, active, k]);

  // Another tab or window changed the stored size.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === TRAY_HEIGHT_KEY) setStored(readStoredTrayHeight());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const commit = useCallback(
    (n: number) => {
      const v = Math.round(clampTrayHeight(n, limits.min, limits.max));
      setStored(v);
      writeStoredTrayHeight(v);
    },
    [limits.min, limits.max],
  );
  const reset = useCallback(() => {
    setStored(null);
    writeStoredTrayHeight(null);
  }, []);

  const shown = Math.round(clampTrayHeight(draft ?? stored ?? trayDefault(), limits.min, limits.max));
  return { shown, min: Math.min(limits.min, Math.max(limits.max, 0)), max: Math.max(limits.max, 0), setDraft, commit, reset };
}
