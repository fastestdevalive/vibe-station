import { useSyncExternalStore } from "react";

/**
 * One shared minute tick for every relative-time label. A module-level
 * interval starts on the first subscriber and is cleared when the last one
 * unsubscribes, so N timestamps cost one timer — not N. A hidden tab skips
 * its ticks; becoming visible again refreshes every label at once.
 */
const TICK_MS = 60_000;

let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function isHidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

function emit(): void {
  now = Date.now();
  for (const l of listeners) l();
}

function onTick(): void {
  if (!isHidden()) emit();
}

function onVisibilityChange(): void {
  if (!isHidden()) emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (timer == null) {
    now = Date.now();
    timer = setInterval(onTick, TICK_MS);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibilityChange);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer != null) {
      clearInterval(timer);
      timer = null;
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}

const getSnapshot = () => {
  // With no subscribers nothing refreshes `now`, so a first render would read
  // a stale value. Re-read it when it is >1s old (still stable within a render).
  if (timer == null && Date.now() - now > 1000) now = Date.now();
  return now;
};

/** Current time (ms), refreshed once a minute while the tab is visible. */
export function useNowTick(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
