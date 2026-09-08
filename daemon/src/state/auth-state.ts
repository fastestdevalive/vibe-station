/**
 * In-memory mutable auth state singleton.
 *
 * `daemonToken` is generated fresh at daemon startup (randomBytes(32)) and
 * never written to disk — it is the HMAC signing key for all tokens.
 * `browserEpoch` is persisted to config.json so "revoke all browser sessions"
 * survives a daemon restart (all pre-bump browser tokens stay invalid after
 * restart anyway because daemonToken rotates, but the epoch is kept for clarity).
 */
import type { TokenScope } from "../types.js";

/**
 * A browser-scoped token that has been minted (e.g. via the mobile QR
 * auth-code exchange) but may not yet have an active WS connection. Tracked so
 * the sessions list can show a device the moment it authenticates — before it
 * opens the dashboard and connects a WS. In-memory only; resets on restart
 * (all old browser tokens become invalid anyway because daemonToken rotates).
 */
export interface BrowserSession {
  tokenId: string;
  scope: TokenScope;
  issuedAt: number;
  expiresAt: number | null;
  /** browserEpoch at mint time — used to drop tokens invalidated by revoke-all. */
  epoch: number;
  /** Human-readable device name parsed from the User-Agent at QR exchange time. */
  deviceName?: string;
}

export interface AuthState {
  daemonToken: string;
  browserEpoch: number;
  /** In-memory token revocation set. Resets on daemon restart. */
  revokedTokenIds: Set<string>;
  /** Minted browser sessions, keyed by tokenId. Resets on daemon restart. */
  mintedBrowserSessions: Map<string, BrowserSession>;
}

let _state: AuthState | null = null;

/** Load the auth singleton at daemon startup. Must be called before getAuthState(). */
export function loadAuthState(daemonToken: string, browserEpoch: number): void {
  _state = { daemonToken, browserEpoch, revokedTokenIds: new Set(), mintedBrowserSessions: new Map() };
}

/** Record a freshly minted browser session so it appears in the sessions list before its WS connects. */
export function recordBrowserSession(session: BrowserSession): void {
  if (!_state) throw new Error("Auth state not initialised");
  _state.mintedBrowserSessions.set(session.tokenId, session);
}

/**
 * Return all minted browser sessions that are still valid — pruning (and
 * dropping) any that are revoked, epoch-mismatched (revoke-all), or expired.
 * Source of truth for the sessions list; broadcaster enriches these with live
 * WS connection counts.
 */
export function getActiveBrowserSessions(): BrowserSession[] {
  if (!_state) throw new Error("Auth state not initialised");
  const now = Date.now();
  const out: BrowserSession[] = [];
  for (const [tokenId, session] of _state.mintedBrowserSessions) {
    const stale =
      _state.revokedTokenIds.has(tokenId) ||
      session.epoch !== _state.browserEpoch ||
      (session.expiresAt !== null && session.expiresAt <= now);
    if (stale) {
      _state.mintedBrowserSessions.delete(tokenId);
      continue;
    }
    out.push(session);
  }
  return out;
}

/** Return the deviceName for a minted browser session, if available. */
export function getDeviceNameForToken(tokenId: string): string | undefined {
  return _state?.mintedBrowserSessions.get(tokenId)?.deviceName;
}

/** Revoke a specific token by its payloadB64 id. Future verifyToken calls will reject it. */
export function revokeTokenId(tokenId: string): void {
  if (!_state) throw new Error("Auth state not initialised");
  _state.revokedTokenIds.add(tokenId);
}

/** Get the current auth state. Throws if loadAuthState() has not been called. */
export function getAuthState(): AuthState {
  if (!_state) throw new Error("Auth state not initialised — call loadAuthState() first");
  return _state;
}

/**
 * Bump the browserEpoch in-memory and await the persist callback.
 * Returns the new epoch value. Throws if persist fails.
 */
export async function bumpBrowserEpoch(persist: () => Promise<void>): Promise<number> {
  if (!_state) throw new Error("Auth state not initialised");
  _state.browserEpoch += 1;
  await persist(); // surface errors to caller; Fastify returns 500 on throw
  return _state.browserEpoch;
}
