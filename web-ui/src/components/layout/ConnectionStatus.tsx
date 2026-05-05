import { useEffect, useRef, useState } from "react";
import { api } from "@/api";
import type { ConnectionState } from "@/api/client";

export function ConnectionStatus() {
  const [state, setState] = useState<ConnectionState>(() => api.getConnectionState());
  const [showRecovered, setShowRecovered] = useState(false);
  const hasEverBeenOnline = useRef(false);

  useEffect(() => {
    let prev: ConnectionState = api.getConnectionState();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = api.subscribeConnection((s) => {
      if (s === "online") hasEverBeenOnline.current = true;
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
      : state === "connecting" || !hasEverBeenOnline.current
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
