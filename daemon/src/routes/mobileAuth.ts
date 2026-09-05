import os from "node:os";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import {
  COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  generateSessionCookieWithNonce,
  parseSessionCookie,
  checkMobileAuthRateLimit,
} from "../auth.js";
import * as cloudflared from "../services/cloudflared.js";
import * as sessionStore from "../state/auth-session-store.js";
import { closeConnectionsByNonce } from "../broadcaster.js";

interface OneTimeCode {
  createdAt: number;
  consumed: boolean;
  /** Where the code was minted for. Disabling the tunnel only invalidates tunnel codes. */
  origin: "tunnel" | "local";
}

const oneTimeCodes = new Map<string, OneTimeCode>();

// Periodic cleanup of stale codes (older than 60s)
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [code, entry] of oneTimeCodes) {
    if (entry.createdAt < cutoff) oneTimeCodes.delete(code);
  }
}, 60_000).unref();

function isTunnelRequest(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  return !!req.headers["cf-connecting-ip"];
}

export interface MobileAuthOpts {
  token?: string;
  port?: number;
  noAuth?: boolean;
}

export function registerMobileAuthRoutes(app: FastifyInstance, opts: MobileAuthOpts): void {
  const { token, port = 7421, noAuth = false } = opts;
  // VST_TUNNEL_PORT lets dev environments (docker, local Vite) point cloudflared
  // at the web UI server instead of the daemon. In production the daemon serves
  // the SPA directly so this env var is not set and `port` is used as-is.
  const tunnelPort = process.env.VST_TUNNEL_PORT ? Number(process.env.VST_TUNNEL_PORT) : port;

  // POST /auth/tunnel/enable
  app.post("/auth/tunnel/enable", async (req, reply) => {
    if (isTunnelRequest(req)) {
      return reply.status(403).send({ error: "TUNNEL_ONLY_BLOCKED" });
    }
    if (noAuth || !token) {
      return reply.status(409).send({ error: "Tunnel unavailable in no-auth mode" });
    }
    const current = cloudflared.getState();
    if (current.enabled && current.tunnelUrl) {
      return reply.status(409).send({ error: "Tunnel already enabled", tunnelUrl: current.tunnelUrl, enabled: true });
    }
    try {
      const { tunnelUrl } = await cloudflared.enable(tunnelPort);
      return reply.send({ tunnelUrl, enabled: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // POST /auth/tunnel/disable
  app.post("/auth/tunnel/disable", async (req, reply) => {
    if (isTunnelRequest(req)) {
      return reply.status(403).send({ error: "TUNNEL_ONLY_BLOCKED" });
    }
    cloudflared.disable();
    // Only tunnel-minted codes become unusable when the tunnel goes away.
    // A local-network QR shown at the same time must keep working.
    for (const [code, entry] of oneTimeCodes) {
      if (entry.origin === "tunnel") oneTimeCodes.delete(code);
    }
    return reply.send({ enabled: false });
  });

  // GET /auth/tunnel/status — authenticated (desktop loopback, or any device
  // holding a session cookie). NOT auth-exempt: the response carries the public
  // tunnel URL, which must not be readable by an unauthenticated LAN peer.
  app.get("/auth/tunnel/status", async (_req, reply) => {
    return reply.send(cloudflared.getState());
  });

  // POST /auth/local-qr — desktop only; mints a one-time QR code for local network / Tailscale
  app.post("/auth/local-qr", async (req, reply) => {
    if (isTunnelRequest(req)) {
      return reply.status(403).send({ error: "TUNNEL_ONLY_BLOCKED" });
    }

    // Pick best IP: prefer Tailscale range (100.64.0.0/10) first, then any non-loopback IPv4
    const interfaces = os.networkInterfaces();
    let selectedIp: string | null = null;
    let connectionType: "tailscale" | "lan" = "lan";

    // First pass: look for Tailscale (100.64.0.0/10 or any 100.x.x.x)
    outer: for (const ifaces of Object.values(interfaces)) {
      if (!ifaces) continue;
      for (const iface of ifaces) {
        if (iface.family !== "IPv4" || iface.internal) continue;
        const parts = iface.address.split(".");
        const first = parseInt(parts[0] ?? "0", 10);
        const second = parseInt(parts[1] ?? "0", 10);
        if (first === 100 && second >= 64 && second <= 127) {
          selectedIp = iface.address;
          connectionType = "tailscale";
          break outer;
        }
      }
    }

    // Second pass: first non-loopback IPv4
    if (!selectedIp) {
      outer2: for (const ifaces of Object.values(interfaces)) {
        if (!ifaces) continue;
        for (const iface of ifaces) {
          if (iface.family !== "IPv4" || iface.internal) continue;
          selectedIp = iface.address;
          connectionType = "lan";
          break outer2;
        }
      }
    }

    if (!selectedIp) {
      return reply.status(503).send({ error: "No network interface found" });
    }

    const code = randomBytes(32).toString("hex");
    const now = Date.now();
    oneTimeCodes.set(code, { createdAt: now, consumed: false, origin: "local" });
    const expiresAt = now + 30_000;

    return reply.send({
      qrUrl: `http://${selectedIp}:${port}/mobile-auth?code=${code}`,
      expiresAt,
      connectionType,
    });
  });

  // POST /auth/mobile-qr — desktop only; mints a one-time QR code
  app.post("/auth/mobile-qr", async (req, reply) => {
    if (isTunnelRequest(req)) {
      return reply.status(403).send({ error: "TUNNEL_ONLY_BLOCKED" });
    }
    const { tunnelUrl, enabled } = cloudflared.getState();
    if (!enabled || !tunnelUrl) {
      return reply.status(409).send({ error: "Tunnel not enabled" });
    }
    const code = randomBytes(32).toString("hex");
    const now = Date.now();
    oneTimeCodes.set(code, { createdAt: now, consumed: false, origin: "tunnel" });
    const expiresAt = now + 30_000;
    return reply.send({ qrUrl: `${tunnelUrl}/mobile-auth?code=${code}`, expiresAt });
  });

  // GET /mobile-auth?code= — AUTH_EXEMPT; validates code and issues session cookie
  // Accepts both tunnel requests (CF-Connecting-IP present) and local network requests.
  app.get<{ Querystring: { code?: string } }>("/mobile-auth", async (req, reply) => {
    const cfIp = req.headers["cf-connecting-ip"];
    const cfIpStr = (Array.isArray(cfIp) ? cfIp[0] : cfIp) ?? "";
    const viaTunnel = cfIpStr.length > 0;
    let ipStr: string;

    if (viaTunnel) {
      // Tunnel path: rate-limit by CF IP
      if (!checkMobileAuthRateLimit(cfIpStr)) {
        return reply.status(429).send({ error: "Rate limit exceeded" });
      }
      ipStr = cfIpStr;
    } else {
      // Local path: rate-limit by req.ip
      const localIp = req.ip ?? "unknown";
      if (!checkMobileAuthRateLimit(localIp)) {
        return reply.status(429).send({ error: "Rate limit exceeded" });
      }
      ipStr = localIp;
    }

    const code = req.query.code;
    if (!code) return reply.status(400).send({ error: "Missing code parameter" });

    const entry = oneTimeCodes.get(code);
    // A code must be redeemed on the transport it was minted for. Without this,
    // a local-network code (shown as a plain http:// LAN URL) could be replayed
    // from anywhere on the internet through the public tunnel, silently widening
    // the blast radius of a shoulder-surfed / screenshotted QR.
    const originMatches = entry ? entry.origin === (viaTunnel ? "tunnel" : "local") : false;
    if (!entry || !originMatches || entry.consumed || Date.now() - entry.createdAt >= 30_000) {
      void reply.type("text/html; charset=utf-8");
      return reply.status(410).send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vibe-station</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:"JetBrains Mono","Fira Code","SF Mono",monospace;background:#0f0f0f;color:#e5e5e5;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100svh;padding:24px;gap:32px}
  .wordmark{font-size:13px;font-weight:500;color:#6b6b6b;letter-spacing:0.04em}
  .card{background:#191919;border:1px solid #262626;border-radius:6px;padding:28px 24px;max-width:340px;width:100%;display:flex;flex-direction:column;gap:12px}
  .icon{width:32px;height:32px;border-radius:50%;background:#1c1010;border:1px solid #4a2020;display:flex;align-items:center;justify-content:center;font-size:14px}
  h1{font-size:14px;font-weight:600;color:#e5e5e5}
  p{font-size:12px;color:#6b6b6b;line-height:1.6}
</style>
</head>
<body>
<div class="wordmark">vibe-station</div>
<div class="card">
  <div class="icon">⏱</div>
  <h1>QR code expired</h1>
  <p>This code has already been used or expired. Ask the desktop to regenerate a new QR code and try again.</p>
</div>
</body>
</html>`);
    }

    // Check config before burning the code — a 503 here must not leave the user
    // with a dead QR they can never retry.
    if (!token) {
      return reply.status(503).send({ error: "Auth not configured" });
    }

    // Mark consumed before issuing cookie — prevents any race on double-scan
    entry.consumed = true;

    // Mint the nonce first so the session row can never diverge from the cookie.
    // (Deriving it by re-parsing the cookie could in principle yield null, which
    // would set a cookie with no backing row — every later request would then
    // fail isLive() and the device would be locked out with no way to recover.)
    const nonce = randomBytes(16).toString("hex");
    const cookieValue = generateSessionCookieWithNonce(token, nonce);
    sessionStore.issue(nonce, {
      createdVia: "qr",
      userAgent: req.headers["user-agent"] ?? undefined,
      createdIp: ipStr,
    });

    // `Secure` is only valid over HTTPS. The tunnel is HTTPS, but the local /
    // Tailscale QR is plain http://<ip>:<port> — browsers silently DROP a
    // Secure cookie on an insecure origin, which would make local QR login
    // appear to succeed and then bounce the phone back to the login screen.
    const cookieAttrs = viaTunnel
      ? `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`
      : `HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
    void reply.header("Set-Cookie", `${COOKIE_NAME}=${cookieValue}; ${cookieAttrs}`);
    // Serve a self-contained HTML page rather than redirecting to "/".
    // A redirect to "/" returns 404 when the daemon has no built web-ui/dist
    // (e.g. docker dev sandbox where Vite serves the UI on a different port).
    void reply.type("text/html; charset=utf-8");
    return reply.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vibe-station</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:"JetBrains Mono","Fira Code","SF Mono",monospace;background:#0f0f0f;color:#e5e5e5;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100svh;padding:24px;gap:32px}
  .wordmark{font-size:13px;font-weight:500;color:#6b6b6b;letter-spacing:0.04em}
  .card{background:#191919;border:1px solid #262626;border-radius:6px;padding:28px 24px;max-width:340px;width:100%;display:flex;flex-direction:column;gap:12px}
  .check{width:32px;height:32px;border-radius:50%;background:#14532d;border:1px solid #16a34a;display:flex;align-items:center;justify-content:center;font-size:16px;color:#16a34a}
  h1{font-size:14px;font-weight:600;color:#e5e5e5}
  p{font-size:12px;color:#6b6b6b;line-height:1.6}
  a.btn{display:inline-block;background:transparent;color:#e5e5e5;text-decoration:none;padding:6px 14px;border-radius:6px;border:1px solid #262626;font-size:12px;font-weight:500;font-family:inherit;align-self:flex-start;margin-top:4px}
  a.btn:active{background:#1e1e1e}
</style>
</head>
<body>
<div class="wordmark">vibe-station</div>
<div class="card">
  <div class="check">✓</div>
  <h1>Device connected</h1>
  <p>This device is now authenticated. You can open the dashboard or close this tab.</p>
  <a class="btn" href="/">Open dashboard</a>
</div>
</body>
</html>`);
  });

  // GET /auth/sessions — desktop only
  app.get("/auth/sessions", async (req, reply) => {
    if (isTunnelRequest(req)) {
      return reply.status(403).send({ error: "TUNNEL_ONLY_BLOCKED" });
    }
    const cookies = (req as typeof req & { cookies?: Record<string, string> }).cookies ?? {};
    const currentNonce = parseSessionCookie(cookies[COOKIE_NAME] ?? "")?.nonce ?? null;
    const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
    const isLoopback = loopbackAddresses.has(req.ip ?? "");
    const sessions = sessionStore.list().map((row) => ({
      ...row,
      isCurrent:
        currentNonce !== null
          ? row.nonce === currentNonce
          : isLoopback && loopbackAddresses.has(row.createdIp ?? ""),
    }));
    return reply.send({ sessions });
  });

  // DELETE /auth/sessions/:nonce — desktop only; revoke one session
  app.delete<{ Params: { nonce: string } }>("/auth/sessions/:nonce", async (req, reply) => {
    if (isTunnelRequest(req)) {
      return reply.status(403).send({ error: "TUNNEL_ONLY_BLOCKED" });
    }
    const { nonce } = req.params;

    // Prevent self-revoke
    const cookies = (req as typeof req & { cookies?: Record<string, string> }).cookies ?? {};
    const sessionCookie = cookies[COOKIE_NAME] ?? "";
    const currentParsed = parseSessionCookie(sessionCookie);
    if (currentParsed?.nonce === nonce) {
      return reply.status(403).send({ error: "CANNOT_REVOKE_SELF" });
    }

    const row = sessionStore.get(nonce);
    if (!row) return reply.status(404).send({ error: "Session not found" });

    sessionStore.revoke(nonce);
    closeConnectionsByNonce(nonce, 4403, "Session revoked");
    return reply.send({ ok: true });
  });

  // DELETE /auth/sessions — desktop only; revoke all except current
  app.delete("/auth/sessions", async (req, reply) => {
    if (isTunnelRequest(req)) {
      return reply.status(403).send({ error: "TUNNEL_ONLY_BLOCKED" });
    }
    const cookies = (req as typeof req & { cookies?: Record<string, string> }).cookies ?? {};
    const sessionCookie = cookies[COOKIE_NAME] ?? "";
    const currentParsed = parseSessionCookie(sessionCookie);
    const currentNonce = currentParsed?.nonce ?? "__none__";

    // Snapshot BEFORE revoking: list() filters out revoked rows, so reading it
    // afterwards yields only the surviving session and no socket is ever closed
    // — a revoked phone would keep its live WS (and full control) indefinitely.
    const doomed = sessionStore.list().filter((row) => row.nonce !== currentNonce);
    const revokedCount = sessionStore.revokeAllExcept(currentNonce);

    // Close WS connections for all revoked sessions
    for (const row of doomed) {
      closeConnectionsByNonce(row.nonce, 4403, "Session revoked");
    }

    return reply.send({ revokedCount });
  });
}
