const KEY = "vst:preloadReloaded";
/** A reload that did not cure the stale chunk within this window is a loop; after it, a new update may recover again. */
const WINDOW_MS = 60_000;

/**
 * Handler for `vite:preloadError` (a lazy chunk 404s after an update replaced
 * the bundle). Reloads at most once per 60 s: the guard is a timestamp, so a
 * long-lived tab can recover again after its next update. If `sessionStorage`
 * throws (sandboxed/private contexts) it falls back to one reload per handler.
 */
export function createPreloadErrorHandler(
  reload: () => void,
  now: () => number = Date.now,
): () => void {
  let reloadedInMemory = false;
  return () => {
    try {
      const raw = Number(sessionStorage.getItem(KEY) ?? 0);
      const last = Number.isFinite(raw) ? raw : 0; // legacy "true" value counts as expired
      if (now() - last > WINDOW_MS) {
        sessionStorage.setItem(KEY, String(now()));
        reload();
      }
    } catch {
      if (!reloadedInMemory) {
        reloadedInMemory = true;
        reload();
      }
    }
  };
}
