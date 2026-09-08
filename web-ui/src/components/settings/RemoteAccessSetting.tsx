import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import QRCode from "qrcode";
import type { ApiInstance } from "@/api";
import type { AuthSession, TunnelState, MobileQrResponse, LocalQrResponse } from "@/api/types";
import { ApiError } from "@/api/errors";

interface RemoteAccessSettingProps {
  api: ApiInstance;
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
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
  // isDesktop: true when viewing from the desktop app (loopback), false for browser sessions.
  // Starts as false so browser viewers never see a spurious revoke button; corrected on first fetch.
  const [isDesktop, setIsDesktop] = useState(false);
  // currentTokenId: the viewer's own tokenId, when it has one. Browser/mobile
  // viewers appear as a real entry in `sessions`, so we badge that entry as
  // "this session" instead of rendering a separate hardcoded card. Desktop
  // (tauri/loopback) callers have no token and no list entry, so they keep the
  // hardcoded "Desktop · this session" card.
  const [currentTokenId, setCurrentTokenId] = useState<string | null>(null);

  // ── QR overlay state ────────────────────────────────────────────────────────
  const [activeQr, setActiveQr] = useState<ActiveQrType | null>(null);
  const [qrLoading, setQrLoading] = useState<"local" | "tunnel" | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(0);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Revoke state ────────────────────────────────────────────────────────────
  const [revokingAll, setRevokingAll] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
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
      const { sessions: list, isDesktop: desktop, currentTokenId: tokenId } = await api.listAuthSessions();
      setSessions(list);
      setIsDesktop(desktop);
      setCurrentTokenId(tokenId ?? null);
    } catch {
      // silently ignore (session list is non-critical)
    }
  }, [api]);

  useEffect(() => {
    void fetchStatus();
    void fetchSessions();
  }, [fetchStatus, fetchSessions]);

  // ── Refresh lastSeenAt periodically ────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => void fetchSessions(), 30_000);
    return () => clearInterval(id);
  }, [fetchSessions]);

  // ── Live session presence via WS ────────────────────────────────────────────
  useEffect(() => {
    const offConnected = api.on("remote:connected", (e) => {
      if (e.type !== "remote:connected") return;
      setSessions((prev) => {
        const idx = prev.findIndex((s) => s.tokenId === e.session.tokenId);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = e.session;
          return next;
        }
        return [...prev, e.session];
      });
    });
    const offDisconnected = api.on("remote:disconnected", (e) => {
      if (e.type !== "remote:disconnected") return;
      setSessions((prev) => prev.map((s) =>
        s.tokenId === e.tokenId ? { ...s, connections: e.connections } : s
      ));
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
      setSessions([]);
      setRevokeSuccess(true);
      setTimeout(() => setRevokeSuccess(false), 3000);
    } catch (err) {
      setRevokeError(errMessage(err, "Failed to revoke browser sessions."));
    } finally {
      setRevokingAll(false);
    }
  }

  // ── Revoke a single session ─────────────────────────────────────────────────
  async function handleRevokeOne(tokenId: string) {
    setRevokingId(tokenId);
    setRevokeError(null);
    try {
      await api.revokeAuthSession(tokenId);
      setSessions((prev) => prev.filter((s) => s.tokenId !== tokenId));
    } catch (err) {
      setRevokeError(errMessage(err, "Failed to revoke session."));
    } finally {
      setRevokingId(null);
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

      {/* Active sessions */}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontWeight: "var(--font-weight-medium)", fontSize: "var(--font-size-sm)" }}>
            Active sessions
          </div>
          {isDesktop && sessions.length > 0 && (
            <button
              type="button"
              className="btn btn--danger"
              disabled={revokingAll}
              onClick={() => void handleRevokeAll()}
              style={{ fontSize: "var(--font-size-xs)" }}
            >
              {revokingAll ? "Revoking…" : "Revoke all"}
            </button>
          )}
        </div>

        {revokeError && (
          <div style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-danger)" }}>
            {revokeError}
          </div>
        )}
        {revokeSuccess && (
          <div style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-success, #16a34a)" }}>
            All sessions revoked.
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          {/* Desktop has no entry in the sessions list (no tokenId), so it gets a
              hardcoded card. Browser/mobile viewers are IN the list — their own
              entry is badged below instead. */}
          {isDesktop && (
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "var(--space-3)",
              padding: "var(--space-3)",
              border: "var(--border-width) solid var(--border-default)",
              borderRadius: "var(--radius-md)",
              background: "var(--bg-card)",
            }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: 2 }}>
                  <span style={{ fontWeight: "var(--font-weight-medium)", fontSize: "var(--font-size-sm)" }}>
                    Desktop
                  </span>
                  <span style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-muted)", background: "var(--bg-input)", borderRadius: "var(--radius-sm)", padding: "1px 6px" }}>
                    this session
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Remote sessions sorted by lastSeenAt desc */}
          {[...sessions].sort((a, b) => b.lastSeenAt - a.lastSeenAt).map((s) => (
            <div
              key={s.tokenId}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "var(--space-3)",
                padding: "var(--space-3)",
                border: "var(--border-width) solid var(--border-default)",
                borderRadius: "var(--radius-md)",
                background: "var(--bg-card)",
              }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: 2 }}>
                  <span style={{ fontWeight: "var(--font-weight-medium)", fontSize: "var(--font-size-sm)" }}>
                    {s.deviceName ?? "Browser"}
                  </span>
                  {s.tokenId === currentTokenId && (
                    <span style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-muted)", background: "var(--bg-input)", borderRadius: "var(--radius-sm)", padding: "1px 6px" }}>
                      this session
                    </span>
                  )}
                  <span style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-muted)", background: "var(--bg-input)", borderRadius: "var(--radius-sm)", padding: "1px 6px" }}>
                    {s.scope}
                  </span>
                  {s.connections === 0 ? (
                    <span style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-muted)" }}>0 tabs open</span>
                  ) : (
                    <span style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-success, #16a34a)", background: "var(--bg-input)", borderRadius: "var(--radius-sm)", padding: "1px 6px" }}>
                      {s.connections} {s.connections === 1 ? "tab" : "tabs"}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-muted)" }}>
                  Last seen {formatRelative(s.lastSeenAt)} · issued {s.issuedAt ? formatRelative(s.issuedAt) : "unknown"}
                </div>
              </div>
              {isDesktop && (
                <button
                  type="button"
                  className="btn btn--secondary"
                  disabled={revokingId === s.tokenId || revokingAll}
                  onClick={() => void handleRevokeOne(s.tokenId)}
                >
                  {revokingId === s.tokenId ? "…" : "Revoke"}
                </button>
              )}
            </div>
          ))}

          {sessions.length === 0 && (
            <div style={{ fontSize: "var(--font-size-xs)", color: "var(--fg-muted)", padding: "var(--space-2) 0" }}>
              No remote sessions connected.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
