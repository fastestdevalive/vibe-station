import { useEffect, useState } from "react";
import { api } from "@/api";
import type { ConnectionState } from "@/api/client";

/**
 * Subtle connection indicator. Renders nothing while online; shows a small
 * "Reconnecting…" pill while the WS is reconnecting. Reconnect happens
 * automatically in the api client (exponential backoff up to 15s).
 */
export function ConnectionStatus() {
  const [state, setState] = useState<ConnectionState>(() => api.getConnectionState());
  /** Brief "Connected" flash after returning to online from offline. */
  const [showRecovered, setShowRecovered] = useState(false);

  useEffect(() => {
    let prev: ConnectionState = api.getConnectionState();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = api.subscribeConnection((s) => {
      setState(s);
      if (s === "online" && (prev === "offline" || prev === "connecting")) {
        setShowRecovered(true);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => setShowRecovered(false), 1500);
      }
      prev = s;
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (state === "online" && !showRecovered) return null;

  const label =
    state === "online"
      ? "Connected"
      : state === "connecting"
        ? "Connecting…"
        : "Reconnecting…";

  const variant = state === "online" ? "online" : state;

  return (
    <span
      className={`conn-pill conn-pill--${variant}`}
      role="status"
      aria-live="polite"
      title={label}
    >
      <span className="conn-pill__dot" aria-hidden />
      <span className="conn-pill__label">{label}</span>
    </span>
  );
}
