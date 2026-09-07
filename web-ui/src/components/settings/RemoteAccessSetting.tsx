import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import QRCode from "qrcode";
import type { ApiInstance } from "@/api";
import type { AuthSession, TunnelState, MobileQrResponse, LocalQrResponse } from "@/api/types";
import { ApiError } from "@/api/errors";

interface RemoteAccessSettingProps {
  api: ApiInstance;
}

/**
 * ApiError.message is the raw response body, which for these routes is
 * `{"error":"…"}`. Surface the human-readable string instead of the JSON blob
 * (e.g. the "cloudflared not found — run vst doctor" hint).
 */
function errMessage(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  try {
    const body = JSON.parse(err.message) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // not JSON — fall through to the raw message
  }
  return err.message || fallback;
}

type ActiveQrType = {
  type: "local" | "tunnel";
  qr: MobileQrResponse | LocalQrResponse;
  svg: string;
};

function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  // navigator.clipboard is undefined outside a secure context — the desktop UI
  // is reachable over plain http:// on a LAN IP, so this must not throw.
  function fallbackCopy(text: string): boolean {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  function markCopied() {
    setFailed(false);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleCopy() {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(markCopied, () => {
        if (fallbackCopy(url)) markCopied();
        else setFailed(true);
      });
      return;
    }
    if (fallbackCopy(url)) markCopied();
    else setFailed(true);
  }
  return (
    <button
      type="button"
      className="btn btn--secondary"
      onClick={handleCopy}
      style={{ width: "100%", justifyContent: "center" }}
    >
      {copied ? "Copied!" : failed ? "Copy failed" : "Copy link"}
    </button>
  );
}

const CARD_STYLE: React.CSSProperties = {
  border: "var(--border-width) solid var(--border-default)",
  borderRadius: "var(--radius-md)",
  background: "var(--bg-card)",
  padding: "var(--space-4)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  minWidth: 220,
  flex: 1,
};

export function RemoteAccessSetting({ api }: RemoteAccessSettingProps) {
  // ── Tunnel state ────────────────────────────────────────────────────────────
  const [tunnel, setTunnel] = useState<TunnelState>({ enabled: false, tunnelUrl: null });
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Remote sessions ─────────────────────────────────────────────────────────
  const [sessions, setSessions] = useState<AuthSession[]>([]);
  const [isRemoteSession, setIsRemoteSession] = useState(false);

  // ── QR overlay state ────────────────────────────────────────────────────────
  const [activeQr, setActiveQr] = useState<ActiveQrType | null>(null);
  const [qrLoading, setQrLoading] = useState<"local" | "tunnel" | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(0);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Revoke-all state ────────────────────────────────────────────────────────
  const [revokingAll, setRevokingAll] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokeSuccess, setRevokeSuccess] = useState(false);

  // ── Fetch tunnel status ─────────────────────────────────────────────────────
  const fetchStatus = useCallback(async () => {
    try {
      const state = await api.getTunnelStatus();
      setTunnel(state);
      setError(null);
    } catch {
      setError("Could not reach daemon.");
    } finally {
      setLoading(false);
    }
  }, [api]);

  // ── Fetch remote sessions ───────────────────────────────────────────────────
  const fetchSessions = useCallback(async () => {
    try {
      const list = await api.listAuthSessions();
      setSessions(list);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setIsRemoteSession(true);
      }
      // non-403 errors: silently ignore (session list is non-critical)
    }
  }, [api]);

  useEffect(() => {
    void fetchStatus();
    void fetchSessions();
  }, [fetchStatus, fetchSessions]);

  // ── Live session presence via WS ────────────────────────────────────────────
  useEffect(() => {
    const offConnected = api.on("remote:connected", (e) => {
      if (e.type !== "remote:connected") return;
      setSessions((prev) => {
        if (prev.some((s) => s.id === e.session.id)) return prev;
        return [...prev, e.session];
      });
    });
    const offDisconnected = api.on("remote:disconnected", (e) => {
      if (e.type !== "remote:disconnected") return;
      setSessions((prev) => prev.filter((s) => s.id !== e.sessionId));
    });
    return () => { offConnected(); offDisconnected(); };
  }, [api]);

  // ── QR countdown timer ──────────────────────────────────────────────────────
  useEffect(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
    if (!activeQr) {
      setCountdown(0);
      return;
    }
    const expiresAt = activeQr.qr.expiresAt;

    function tick() {
      const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      setCountdown(remaining);
      if (remaining <= 0) {
        if (countdownRef.current) {
          clearInterval(countdownRef.current);
          countdownRef.current = null;
        }
        setActiveQr(null);
      }
    }

    tick();
    countdownRef.current = setInterval(tick, 500);
    return () => {
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
    };
  }, [activeQr]);

  // ── Open QR overlay ─────────────────────────────────────────────────────────
  async function openQr(type: "local" | "tunnel") {
    setQrLoading(type);
    setQrError(null);
    try {
      const result = type === "local" ? await api.getLocalQr() : await api.getMobileQr();
      const svg = await QRCode.toString(result.qrUrl, { type: "svg", margin: 1 });
      setActiveQr({ type, qr: result, svg });
    } catch (err) {
      setQrError(errMessage(err, "Failed to generate QR code."));
    } finally {
      setQrLoading(null);
    }
  }

  // ── Tunnel toggle ───────────────────────────────────────────────────────────
  async function handleToggleTunnel() {
    setToggling(true);
    setError(null);
    try {
      if (tunnel.enabled) {
        await api.disableTunnel();
        setTunnel({ enabled: false, tunnelUrl: null });
        // Close QR overlay if it was a tunnel QR
        setActiveQr((prev) => (prev?.type === "tunnel" ? null : prev));
      } else {
        const result = await api.enableTunnel();
        setTunnel({ enabled: result.enabled, tunnelUrl: result.tunnelUrl });
      }
    } catch (err) {
      setError(errMessage(err, "Failed to toggle tunnel."));
    } finally {
      setToggling(false);
    }
  }

  // ── Revoke all browser sessions ─────────────────────────────────────────────
  async function handleRevokeAll() {
    setRevokingAll(true);
    setRevokeError(null);
    setRevokeSuccess(false);
    try {
      await api.revokeAllBrowserSessions();
      setRevokeSuccess(true);
      setTimeout(() => setRevokeSuccess(false), 3000);
    } catch (err) {
      setRevokeError(errMessage(err, "Failed to revoke browser sessions."));
    } finally {
      setRevokingAll(false);
    }
  }

  // ── QR overlay render ───────────────────────────────────────────────────────
  function renderQrOverlay() {
    if (!activeQr) return null;

    const totalSeconds = 30;
    const progress = Math.min(100, (countdown / totalSeconds) * 100);
    const isWarning = countdown <= 5;

    let label = "";
    try {
      const u = new URL(activeQr.qr.qrUrl);
      label =
        activeQr.type === "local"
          ? `Same network · ${u.hostname}`
          : `Remote · ${u.hostname}`;
    } catch {
      label = activeQr.type === "local" ? "Same network" : "Remote";
    }

    return createPortal(
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 1000,
          background: "rgba(0,0,0,0.65)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
        onClick={() => setActiveQr(null)}
      >
        <div
          style={{
            background: "var(--bg-card)",
            border: "var(--border-width) solid var(--border-default)",
            borderRadius: "var(--radius-md)",
            padding: "var(--space-5)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-3)",
            position: "relative",
            maxWidth: 300,
            width: "100%",
            alignItems: "center",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Close button */}
          <button
            type="button"
            aria-label="Close"
            style={{
              position: "absolute",
              top: "var(--space-3)",
              right: "var(--space-3)",
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--fg-muted)",
              fontSize: 20,
              lineHeight: 1,
              padding: 0,
            }}
            onClick={() => setActiveQr(null)}
          >
            ×
          </button>

          {/* QR code */}
          <div
            dangerouslySetInnerHTML={{ __html: activeQr.svg }}
            style={{
              width: 200,
              height: 200,
              background: "#fff",
              borderRadius: "var(--radius-sm)",
              padding: 4,
              flexShrink: 0,
            }}
          />

          {/* Label */}
          <div
            style={{
              fontSize: "var(--font-size-xs)",
              color: "var(--fg-muted)",
              textAlign: "center",
            }}
          >
            {label}
          </div>

          {/* Progress bar */}
          <div
            style={{
              width: "100%",
              height: 4,
              background: "var(--bg-input)",
              borderRadius: 2,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${progress}%`,
                background: isWarning
                  ? "var(--fg-danger, #ef4444)"
                  : "var(--accent-color, var(--fg-primary))",
                transition: "width 0.5s linear, background 0.3s ease",
              }}
            />
          </div>

          {/* Countdown */}
          <div
            style={{
              fontSize: "var(--font-size-xs)",
              color: isWarning ? "var(--fg-danger, #ef4444)" : "var(--fg-muted)",
              textAlign: "center",
            }}
          >
            Expires {countdown}s
          </div>

          {/* Copyable link */}
          <CopyLinkButton url={activeQr.qr.qrUrl} />

          {/* Regenerate */}
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => void openQr(activeQr.type)}
            disabled={qrLoading !== null}
          >
            {qrLoading !== null ? "Generating…" : "Regenerate"}
          </button>
        </div>
      </div>,
      document.body,
    );
  }

  if (loading) {
    return (
      <div style={{ padding: "var(--space-5)", color: "var(--fg-muted)" }}>Loading…</div>
    );
  }

  if (isRemoteSession) {
    return (
      <div style={{ padding: "var(--space-5)", color: "var(--fg-muted)", fontSize: "var(--font-size-sm)" }}>
        Remote session management can only be done from the primary desktop session.
      </div>
    );
  }

  // Truncate tunnel URL for display
  const truncatedUrl = tunnel.tunnelUrl
    ? tunnel.tunnelUrl.replace(/^https?:\/\//, "").slice(0, 40) +
      (tunnel.tunnelUrl.length > 46 ? "…" : "")
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
      {renderQrOverlay()}

      {/* Two cards side by side */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)" }}>
        {/* Same network card */}
        <div style={CARD_STYLE}>
          <div
            style={{
              fontWeight: "var(--font-weight-medium)",
              fontSize: "var(--font-size-sm)",
            }}
          >
            Same network
          </div>
          <div style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-muted)" }}>
            Works on same WiFi or Tailscale. No setup.
          </div>
          <button
            type="button"
            className="btn btn--primary"
            style={{ alignSelf: "flex-start" }}
            disabled={qrLoading === "local"}
            onClick={() => void openQr("local")}
          >
            {qrLoading === "local" ? "Generating…" : "Show QR"}
          </button>
        </div>

        {/* Remote (tunnel) card */}
        <div style={CARD_STYLE}>
          <div
            style={{
              fontWeight: "var(--font-weight-medium)",
              fontSize: "var(--font-size-sm)",
            }}
          >
            Remote
          </div>
          <div style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-muted)" }}>
            Cloudflare tunnel creates a public URL.
          </div>

          {tunnel.enabled && tunnel.tunnelUrl ? (
            <>
              <div
                style={{
                  fontSize: "var(--font-size-xs)",
                  color: "var(--fg-muted)",
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-2)",
                }}
              >
                <span
                  style={{ color: "var(--accent-color, var(--fg-primary))", fontWeight: 600 }}
                >
                  ●
                </span>
                tunnel active · {truncatedUrl}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={qrLoading === "tunnel"}
                  onClick={() => void openQr("tunnel")}
                >
                  {qrLoading === "tunnel" ? "Generating…" : "Show QR"}
                </button>
                <button
                  type="button"
                  className="btn btn--secondary"
                  disabled={toggling}
                  onClick={() => void handleToggleTunnel()}
                  style={{ fontWeight: "normal" }}
                >
                  {toggling ? "…" : "Disable"}
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              style={{ alignSelf: "flex-start" }}
              disabled={toggling}
              onClick={() => void handleToggleTunnel()}
            >
              {toggling ? "…" : "Enable tunnel"}
            </button>
          )}
        </div>
      </div>

      {(error || qrError) && (
        <div style={{ fontSize: "var(--font-size-sm)", color: "var(--fg-danger)" }}>
          {error ?? qrError}
        </div>
      )}

      {/* Active remote sessions */}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        <div style={{ fontWeight: "var(--font-weight-medium)", fontSize: "var(--font-size-sm)" }}>
          Active sessions
        </div>
        {sessions.length === 0 ? (
          <div style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-muted)" }}>
            No remote sessions connected.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            {sessions.map((s) => (
              <div
                key={s.id}
                style={{
                  fontSize: "var(--font-size-xs)",
                  color: "var(--fg-muted)",
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-2)",
                }}
              >
                <span style={{ color: "var(--accent-color, var(--fg-primary))", fontWeight: 600 }}>●</span>
                {s.scope} · connected {new Date(s.connectedAt).toLocaleTimeString()}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Revoke all browser sessions */}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        <div
          style={{ fontWeight: "var(--font-weight-medium)", fontSize: "var(--font-size-sm)" }}
        >
          Browser sessions
        </div>
        <div style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-muted)" }}>
          Invalidates all active browser and mobile sessions immediately, including any live connections.
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <button
            type="button"
            className="btn btn--danger"
            disabled={revokingAll}
            onClick={() => void handleRevokeAll()}
            style={{ alignSelf: "flex-start" }}
          >
            {revokingAll ? "Revoking…" : "Revoke all browser sessions"}
          </button>
          {revokeSuccess && (
            <span style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-success, #16a34a)" }}>
              All browser sessions revoked.
            </span>
          )}
        </div>
        {revokeError && (
          <div style={{ fontSize: "var(--font-size-sm)", color: "var(--fg-danger)" }}>
            {revokeError}
          </div>
        )}
      </div>
    </div>
  );
}
