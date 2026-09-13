import type { ServerMessage } from "./ws/protocol.js";
import type { WSConnection } from "./ws/connection.js";
import type { TokenScope } from "./types.js";
import { getActiveBrowserSessions, getDeviceNameForToken } from "./state/auth-state.js";

/**
 * WS broadcaster: manages broadcast events to connected clients.
 * Connections register/unregister themselves on open/close.
 * Routes broadcast events to all connections, and per-session events to subscribers only.
 */

const connections = new Set<WSConnection>();

// TODO: mobile scope is browser for now — there is no dedicated "mobile" scope
// minted anywhere yet. Re-add "mobile" here once a real mobile scope is implemented.
const REMOTE_SCOPES: ReadonlySet<TokenScope> = new Set(["browser" /*, "mobile" */]);

export type TokenSession = {
  tokenId: string;
  scope: string;
  issuedAt: number;
  expiresAt: number | null;
  lastSeenAt: number;
  connections: number;
  deviceName?: string;
};

/** Token-level session map. One entry per unique auth token (0+ WS connections each). */
const tokenSessions = new Map<string, TokenSession>();

/**
 * Register a connection for broadcasts.
 * Called when a WS connection opens.
 */
export function registerConnection(conn: WSConnection): void {
  connections.add(conn);
  if (conn.tokenId && conn.scope && REMOTE_SCOPES.has(conn.scope)) {
    const now = Date.now();
    const existing = tokenSessions.get(conn.tokenId);
    if (existing) {
      existing.connections += 1;
      existing.lastSeenAt = now;
    } else {
      tokenSessions.set(conn.tokenId, {
        tokenId: conn.tokenId,
        scope: conn.scope,
        issuedAt: conn.tokenIssuedAt ?? now,
        expiresAt: conn.tokenExpiresAt ?? null,
        lastSeenAt: now,
        connections: 1,
        deviceName: getDeviceNameForToken(conn.tokenId),
      });
    }
    const session = tokenSessions.get(conn.tokenId)!;
    broadcastAll({ type: "remote:connected", session: { tokenId: session.tokenId, scope: session.scope, connections: session.connections, issuedAt: session.issuedAt, lastSeenAt: session.lastSeenAt, expiresAt: session.expiresAt ?? undefined, deviceName: session.deviceName } });
  }
}

/**
 * Unregister a connection from broadcasts.
 * Called when a WS connection closes.
 */
export function unregisterConnection(conn: WSConnection): void {
  connections.delete(conn);
  if (conn.tokenId && conn.scope && REMOTE_SCOPES.has(conn.scope)) {
    const entry = tokenSessions.get(conn.tokenId);
    if (entry) {
      entry.connections = Math.max(0, entry.connections - 1);
      entry.lastSeenAt = Date.now();
    }
    broadcastAll({ type: "remote:disconnected", tokenId: conn.tokenId, connections: entry?.connections ?? 0 });
  }
}

/**
 * Invoke `fn` for every live WS connection. Used by `ws/server.ts`'s heartbeat
 * sweep to ping connections and reap stale ones (socket-cycling fix, Fix 5).
 */
export function forEachConnection(fn: (conn: WSConnection) => void): void {
  for (const conn of connections) fn(conn);
}

/**
 * Return a snapshot of token-level remote sessions.
 *
 * Minted browser tokens (from auth-state) are the source of truth — a device
 * that completed the QR auth-code exchange appears here immediately, with
 * `connections: 0`, even before it opens the dashboard and connects a WS.
 * WS-derived entries in `tokenSessions` supply the live connection count and
 * `lastSeenAt`, and also cover any connected token not in the minted store.
 */
export function getRemoteSessions(): TokenSession[] {
  const now = Date.now();
  const byId = new Map<string, TokenSession>();

  for (const m of getActiveBrowserSessions()) {
    byId.set(m.tokenId, {
      tokenId: m.tokenId,
      scope: m.scope,
      issuedAt: m.issuedAt,
      expiresAt: m.expiresAt,
      lastSeenAt: m.issuedAt,
      connections: 0,
      deviceName: m.deviceName,
    });
  }

  for (const ws of tokenSessions.values()) {
    if (ws.expiresAt && ws.expiresAt <= now) continue;
    const existing = byId.get(ws.tokenId);
    if (existing) {
      existing.connections = ws.connections;
      existing.lastSeenAt = ws.lastSeenAt;
    } else {
      byId.set(ws.tokenId, ws);
    }
  }

  return [...byId.values()];
}

/** Close all WS connections for a token and remove it from the session map. Best-effort. */
export function closeConnectionsByTokenId(tokenId: string, code: number, reason: string): boolean {
  const found = tokenSessions.has(tokenId);
  tokenSessions.delete(tokenId);
  for (const conn of connections) {
    if (conn.tokenId === tokenId) {
      try { conn.socket.close(code, reason); } catch { /* best-effort */ }
    }
  }
  return found;
}

/**
 * Broadcast an event to all connected clients.
 * Used for project/worktree/mode CRUD events.
 */
export function broadcastAll(msg: ServerMessage): void {
  for (const conn of connections) {
    conn.send(msg);
  }
}

/**
 * Broadcast an event to all connections watching a specific worktree.
 * A connection is considered a watcher when it has any treeWatches key
 * prefixed `tree:${worktreeId}:` (D4).
 */
export function broadcastWorktree(worktreeId: string, msg: ServerMessage): void {
  const prefix = `tree:${worktreeId}:`;
  for (const conn of connections) {
    for (const key of conn.treeWatches.keys()) {
      if (key.startsWith(prefix)) {
        conn.send(msg);
        break;
      }
    }
  }
}

/**
 * Send an event to subscribers of a specific session.
 * Used for per-session state/lifecycle events.
 */
export function notifySession(sessionId: string, msg: ServerMessage): void {
  for (const conn of connections) {
    if (conn.isSubscribedTo(sessionId)) {
      conn.send(msg);
    }
  }
}

/**
 * Close all WebSocket connections authenticated with the given token scope.
 * Called by POST /auth/revoke-browser after bumping browserEpoch. Also prunes
 * matching entries from `tokenSessions` — otherwise revoked sessions linger
 * with connections:0 and reappear in the next `getRemoteSessions()` poll.
 */
export function closeConnectionsByScope(scope: TokenScope, code: number, reason: string): void {
  for (const [tokenId, session] of tokenSessions) {
    if (session.scope === scope) {
      tokenSessions.delete(tokenId);
    }
  }
  for (const conn of connections) {
    if (conn.scope === scope) {
      try {
        conn.socket.close(code, reason);
      } catch {
        // best-effort — socket may already be closing
      }
    }
  }
}

/**
 * Force-detach every connection's open WS stream on `sessionId` (Decision 9).
 *
 * `releaseSessionRuntime` (services/sessionRuntime.ts) kills the actual
 * process/pane, but does nothing about a browser tab's already-open
 * terminal-pane WS stream pointing at the now-archived session id — without
 * this, that tab's pane silently stops receiving output with no error, and a
 * stale entry lingers in `WSConnection.openStreams`. Used by
 * `POST /sessions/:id/reset` right after `releaseSessionRuntime`.
 *
 * Mirrors `ws/handlers/sessionClose.ts`'s `closeSessionLocked` exactly, run
 * under each connection's own `withSessionLock` (same invariant as
 * session:open/session:close — see AGENTS.md).
 */
export async function forceCloseSessionStreams(sessionId: string): Promise<void> {
  for (const conn of connections) {
    await conn.withSessionLock(sessionId, async () => {
      const entry = conn.openStreams.get(sessionId);
      if (!entry) return;
      try {
        entry.stream.off("chunk", entry.onChunk);
        await entry.stream.detach(entry.subscriberId);
      } catch {
        // Stream already gone — nothing to detach, matches closeSessionLocked's own tolerance.
      }
      if (conn.openStreams.get(sessionId) === entry) conn.unregisterOpenStream(sessionId);
    });
  }
}
