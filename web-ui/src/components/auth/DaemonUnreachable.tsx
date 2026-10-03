import "./LoginScreen.css";

/**
 * Shown while `/auth/check` cannot be answered (daemon asleep, VPN down, proxy
 * 5xx). Deliberately NOT the LoginScreen: the session may be perfectly valid, and
 * `useAuth` keeps retrying until it can tell.
 */
export function DaemonUnreachable() {
  const muted = { textAlign: "center", color: "var(--fg-muted)", lineHeight: 1.5 } as const;
  return (
    <div className="login-screen" role="status" data-testid="daemon-unreachable">
      <div className="login-card">
        <div className="login-card__brand">Vibe Station</div>
        <div className="login-card__divider" />
        <p style={{ ...muted, fontSize: "var(--font-size-sm)" }}>Can't reach vibe-station — retrying…</p>
        <p style={{ ...muted, fontSize: "var(--font-size-xs)" }}>
          Check that the daemon is running and reachable (VPN/Tailscale, if you connect remotely)
        </p>
      </div>
    </div>
  );
}
