import { useEffect, useState } from "react";
import type { ApiInstance, ConnectionState } from "@/api";

export interface OfflineOverlayProps {
  api: ApiInstance;
  className?: string;
}

/**
 * Shared offline overlay (Phase 4.4 / 4.5): shown over TerminalPane and ChatPane
 * whenever the connection isn't "online", preventing panes from silently showing
 * frozen/stale content while the daemon is down, reconnecting, or disconnected.
 */
export function OfflineOverlay({ api, className }: OfflineOverlayProps) {
  const [connState, setConnState] = useState<ConnectionState>(() => api.getConnectionState());

  useEffect(() => {
    return api.subscribeConnection((s) => setConnState(s));
  }, [api]);

  if (connState === "online") return null;

  const offlineLabel =
    connState === "disconnected"
      ? "Disconnected — Retry"
      : connState === "connecting"
        ? "Connecting…"
        : "Reconnecting…";

  const layerClass = className
    ? `terminal-spawning-layer terminal-offline-layer ${className}`
    : "terminal-spawning-layer terminal-offline-layer";

  return (
    <div className={layerClass} data-testid="offline-overlay">
      <div className="terminal-offline">
        <span className="terminal-offline__label">{offlineLabel}</span>
        {connState === "disconnected" ? (
          <button
            type="button"
            className="terminal-offline__retry"
            onClick={() => api.retryConnection()}
          >
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}
