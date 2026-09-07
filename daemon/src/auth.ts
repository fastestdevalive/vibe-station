/**
 * Token primitives for the vibe-station daemon.
 *
 * Token format:  <base64url(JSON(payload))>.<HMAC-SHA256-hex>
 *
 * All three client types (CLI, Tauri, browser) use the same mintToken /
 * verifyToken pair. Scope is server-determined at mint time — callers cannot
 * claim a scope.
 *
 * Browser tokens additionally carry exp (7-day TTL) and epoch (revocation
 * counter). CLI and Tauri tokens have no expiry and no epoch.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthState } from "./state/auth-state.js";
import type { TokenPayload, TokenScope, VerifyResult } from "./types.js";

export { BROWSER_TTL_MS, BROWSER_MAX_AGE_SECONDS, COOKIE_NAME };
export { checkMobileAuthRateLimit };
export { mintToken, verifyToken };

const COOKIE_NAME = "vst-session";
const BROWSER_TTL_MS = 7 * 24 * 60 * 60 * 1000;        // 7 days in ms
const BROWSER_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;       // 7 days in seconds (for Max-Age)

// ── Rate limiters ─────────────────────────────────────────────────────────────

const RATE_LIMIT_WINDOW_MS = 60 * 1000;

// In-memory rate limiter for /mobile-auth — max 20 attempts per minute per phone IP.
// Keyed by CF-Connecting-IP value (never undefined — callers must check header first).
const mobileAuthAttempts = new Map<string, { count: number; resetAt: number }>();
const MOBILE_RATE_LIMIT_MAX = 20;

/**
 * Returns true if the CF-Connecting-IP is within the mobile-auth rate limit.
 * Callers must verify the header is present before calling this — never pass undefined.
 */
function checkMobileAuthRateLimit(cfIp: string): boolean {
  const now = Date.now();
  const entry = mobileAuthAttempts.get(cfIp);
  if (!entry || now > entry.resetAt) {
    mobileAuthAttempts.set(cfIp, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= MOBILE_RATE_LIMIT_MAX;
}

// ── Token primitives ──────────────────────────────────────────────────────────

function base64urlEncode(s: string): string {
  return Buffer.from(s).toString("base64url");
}

function hmacPayload(payloadB64: string, key: string): string {
  return createHmac("sha256", key).update(payloadB64).digest("hex");
}

/**
 * Mint a new signed token for the given scope.
 *
 * - cli / tauri: payload = { iat, scope }  — no exp, no epoch
 * - browser:     payload = { iat, scope, exp, epoch }
 */
function mintToken(
  scope: TokenScope,
  authState: AuthState,
  opts?: { exp?: number },
): string {
  const payload: TokenPayload = {
    iat: Date.now(),
    scope,
    ...(scope === "browser"
      ? {
          // L4: clamp caller-supplied exp so it can never exceed the max TTL.
          exp: opts?.exp !== undefined
            ? Math.min(opts.exp, Date.now() + BROWSER_TTL_MS)
            : Date.now() + BROWSER_TTL_MS,
          epoch: authState.browserEpoch,
        }
      : {}),
  };
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const sig = hmacPayload(payloadB64, authState.daemonToken);
  return `${payloadB64}.${sig}`;
}

/**
 * Verify a token minted by mintToken.
 *
 * Checks (in order):
 *  1. Structure — must be <base64url>.<64-hex-chars>
 *  2. HMAC — constant-time compare
 *  3. Payload parseable as TokenPayload
 *  4. Scope-shape — browser must have exp+epoch; cli/tauri must not have exp
 *  5. Expiry — browser tokens only
 *  6. Epoch — browser tokens only
 */
function verifyToken(token: string, authState: AuthState): VerifyResult {
  const dot = token.lastIndexOf(".");
  if (dot === -1) return { ok: false, reason: "malformed" };

  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  // Constant-time HMAC compare
  const expected = hmacPayload(payloadB64, authState.daemonToken);
  try {
    const recvBuf = Buffer.from(sig, "hex");
    const expBuf = Buffer.from(expected, "hex");
    if (recvBuf.length !== expBuf.length || !timingSafeEqual(recvBuf, expBuf)) {
      return { ok: false, reason: "invalid_signature" };
    }
  } catch {
    return { ok: false, reason: "invalid_signature" };
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString()) as TokenPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  // Validate scope is a known value before any scope-based branching.
  if (!["cli", "tauri", "browser"].includes(payload.scope)) {
    return { ok: false, reason: "malformed" };
  }

  // Scope-shape validation
  if (payload.scope === "browser") {
    if (payload.epoch === undefined || payload.exp === undefined) {
      return { ok: false, reason: "malformed" };
    }
  } else {
    // cli / tauri must not carry exp (guards against token downgrade)
    if (payload.exp !== undefined) return { ok: false, reason: "malformed" };
  }

  // Expiry (browser only)
  if (payload.scope === "browser" && Date.now() > payload.exp!) {
    return { ok: false, reason: "expired" };
  }

  // Epoch mismatch (browser only) — set when epoch was bumped via revoke-all
  if (payload.scope === "browser" && payload.epoch !== authState.browserEpoch) {
    return { ok: false, reason: "epoch_mismatch" };
  }

  // Per-token revocation — set when a specific session is individually revoked
  if (authState.revokedTokenIds.has(payloadB64)) {
    return { ok: false, reason: "revoked" };
  }

  return { ok: true, payload };
}
