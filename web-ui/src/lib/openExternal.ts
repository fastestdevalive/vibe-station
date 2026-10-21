/**
 * Open a URL outside the app: the system browser inside the Tauri shell, a new
 * tab in a regular browser. Only http:, https: and mailto: URLs are opened;
 * anything else (javascript:, file:, data:, unparsable) is silently rejected.
 */
type TauriInternals = {
  invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
};

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function openExternal(url: string): void {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return;
  }
  if (!ALLOWED_PROTOCOLS.has(protocol)) return;
  const tauri = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  if (/^https?:/.test(url) && typeof tauri !== "undefined") {
    tauri.invoke("plugin:shell|open", { path: url, openWith: null }).catch(() => {
      window.open(url, "_blank", "noopener,noreferrer");
    });
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
