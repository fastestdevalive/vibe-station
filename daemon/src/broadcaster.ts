// @ts-nocheck
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
