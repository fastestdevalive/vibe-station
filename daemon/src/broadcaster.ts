import type { ServerMessage } from "./ws/protocol.js";
import type { WSConnection } from "./ws/connection.js";

/**
 * WS broadcaster: manages broadcast events to connected clients.
 * Connections register/unregister themselves on open/close.
 * Routes broadcast events to all connections, and per-session events to subscribers only.
 */

const connections = new Set<WSConnection>();

/**
 * Register a connection for broadcasts.
 * Called when a WS connection opens.
 */
export function registerConnection(conn: WSConnection): void {
  connections.add(conn);
}

/**
 * Unregister a connection from broadcasts.
 * Called when a WS connection closes.
 */
export function unregisterConnection(conn: WSConnection): void {
  connections.delete(conn);
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
