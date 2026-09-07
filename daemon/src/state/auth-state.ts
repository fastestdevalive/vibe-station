/**
 * In-memory mutable auth state singleton.
 *
 * `daemonToken` is generated fresh at daemon startup (randomBytes(32)) and
 * never written to disk — it is the HMAC signing key for all tokens.
 * `browserEpoch` is persisted to config.json so "revoke all browser sessions"
 * survives a daemon restart (all pre-bump browser tokens stay invalid after
 * restart anyway because daemonToken rotates, but the epoch is kept for clarity).
 */
export interface AuthState {
  daemonToken: string;
  browserEpoch: number;
  /** In-memory token revocation set. Resets on daemon restart. */
  revokedTokenIds: Set<string>;
}

let _state: AuthState | null = null;

/** Load the auth singleton at daemon startup. Must be called before getAuthState(). */
export function loadAuthState(daemonToken: string, browserEpoch: number): void {
  _state = { daemonToken, browserEpoch, revokedTokenIds: new Set() };
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
