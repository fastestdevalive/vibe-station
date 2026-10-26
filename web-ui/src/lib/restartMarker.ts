/**
 * "This page reloaded because the daemon restarted" marker. The update flow
 * writes it just before reloading; the login screen reads it to explain a
 * sign-out caused by the restart. sessionStorage can throw (private mode,
 * blocked site data), so every access is guarded and the reload still happens.
 */
const RESTARTED_AT_KEY = "vst:restartedAt";

/** Record the restart, then reload the page. */
export function markRestartReload(): void {
  try {
    sessionStorage.setItem(RESTARTED_AT_KEY, Date.now().toString());
  } catch {
    /* storage unavailable: reload anyway, only the login hint is lost */
  }
  window.location.reload();
}

/**
 * True when a restart reload was recorded less than `maxAgeMs` ago. Always
 * clears the marker so it explains at most one login screen.
 */
export function consumeRecentRestart(maxAgeMs: number): boolean {
  try {
    const raw = sessionStorage.getItem(RESTARTED_AT_KEY);
    if (!raw) return false;
    sessionStorage.removeItem(RESTARTED_AT_KEY);
    const at = parseInt(raw, 10);
    return Number.isFinite(at) && Date.now() - at < maxAgeMs;
  } catch {
    return false;
  }
}
