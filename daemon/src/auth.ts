/**
 * HMAC-based session cookie utilities.
 *
 * Cookie format:  vst-session=<issuedAt>.<nonce>.<hmac>
 *   issuedAt  — Date.now() in ms (base-10 string)
 *   nonce     — 16 random bytes as hex (32 chars) — ensures each cookie is unique
 *   hmac      — HMAC-SHA256(issuedAt + "." + nonce, daemonToken) as hex (64 chars)
 *
 * Self-validating: the daemon re-derives the HMAC on every request using the
 * in-memory daemonToken. auth_sessions table provides revocation on top of this.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "vst-session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days in seconds (for Max-Age)

// In-memory rate limiter for /auth/login — max 10 attempts per minute per IP.
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 10;

// In-memory rate limiter for /mobile-auth — max 20 attempts per minute per phone IP.
// Keyed by CF-Connecting-IP value (never undefined — callers must check header first).
const mobileAuthAttempts = new Map<string, { count: number; resetAt: number }>();
const MOBILE_RATE_LIMIT_MAX = 20;

/** Returns true if this IP is within the rate limit, false if exceeded. */
export function checkLoginRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= RATE_LIMIT_MAX;
}

/** Reset the rate limit counter for an IP (called on successful login). */
export function resetLoginRateLimit(ip: string): void {
  loginAttempts.delete(ip);
}

/**
 * Returns true if the CF-Connecting-IP is within the mobile-auth rate limit.
 * Callers must verify the header is present before calling this — never pass undefined.
 */
export function checkMobileAuthRateLimit(cfIp: string): boolean {
  const now = Date.now();
  const entry = mobileAuthAttempts.get(cfIp);
  if (!entry || now > entry.resetAt) {
    mobileAuthAttempts.set(cfIp, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= MOBILE_RATE_LIMIT_MAX;
}

/**
 * Mint a new session cookie value for the given daemonToken.
 */
export function generateSessionCookie(daemonToken: string): string {
  const issuedAt = Date.now().toString(10);
  const nonce = randomBytes(16).toString("hex");
  const hmac = computeHmac(issuedAt, nonce, daemonToken);
  return `${issuedAt}.${nonce}.${hmac}`;
}

/**
 * Mint a session cookie re-using an existing nonce (sliding bump re-issuance).
 * Produces a new issuedAt so the HMAC TTL clock resets; same nonce as DB PK.
 */
export function generateSessionCookieWithNonce(daemonToken: string, nonce: string): string {
  const issuedAt = Date.now().toString(10);
  const hmac = computeHmac(issuedAt, nonce, daemonToken);
  return `${issuedAt}.${nonce}.${hmac}`;
}

/**
 * Parse the structural fields from a cookie value without HMAC verification.
 * Returns null if the format is malformed.
 */
export function parseSessionCookie(cookie: string): { issuedAt: string; nonce: string } | null {
  const dotFirst = cookie.indexOf(".");
  if (dotFirst === -1) return null;
  const dotSecond = cookie.indexOf(".", dotFirst + 1);
  if (dotSecond === -1) return null;
  const issuedAt = cookie.slice(0, dotFirst);
  const nonce = cookie.slice(dotFirst + 1, dotSecond);
  if (!issuedAt || !nonce) return null;
  return { issuedAt, nonce };
}

/**
 * Validate a session cookie value against the daemonToken.
 * Returns true only if the HMAC is correct and the cookie is within TTL.
 */
export function validateSessionCookie(cookie: string, daemonToken: string): boolean {
  const dotFirst = cookie.indexOf(".");
  if (dotFirst === -1) return false;
  const dotSecond = cookie.indexOf(".", dotFirst + 1);
  if (dotSecond === -1) return false;

  const issuedAt = cookie.slice(0, dotFirst);
  const nonce = cookie.slice(dotFirst + 1, dotSecond);
  const receivedHmac = cookie.slice(dotSecond + 1);

  // Guard: receivedHmac must be exactly 64 hex chars (SHA-256 output)
  // timingSafeEqual throws if buffers differ in length — check first.
  if (receivedHmac.length !== 64) return false;

  // Recompute and constant-time compare
  const expectedHmac = computeHmac(issuedAt, nonce, daemonToken);
  try {
    const received = Buffer.from(receivedHmac, "hex");
    const expected = Buffer.from(expectedHmac, "hex");
    if (!timingSafeEqual(received, expected)) return false;
  } catch {
    return false;
  }

  // Age check: 0 <= age < TTL (rejects future-dated AND expired cookies)
  const ts = parseInt(issuedAt, 10);
  if (!Number.isFinite(ts)) return false;
  const age = Date.now() - ts;
  return age >= 0 && age < SESSION_TTL_MS;
}

function computeHmac(issuedAt: string, nonce: string, key: string): string {
  return createHmac("sha256", key)
    .update(`${issuedAt}.${nonce}`)
    .digest("hex");
}
