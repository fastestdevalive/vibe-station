import type { WSConnection } from "../connection.js";
import type { ClientMessage } from "../protocol.js";

/**
 * Handle subscribe message: add session IDs to the subscription set.
 * The connection will then receive state events for these sessions via the broadcaster.
 */
export function handleSubscribe(conn: WSConnection, msg: Extract<ClientMessage, { type: "subscribe" }>): void {
  conn.subscribe(msg.sessionIds);
}

/**
 * Handle unsubscribe message: remove session IDs from the subscription set.
 */
export function handleUnsubscribe(conn: WSConnection, msg: Extract<ClientMessage, { type: "unsubscribe" }>): void {
  conn.unsubscribe(msg.sessionIds);
}
