// @ts-nocheck
import type { WSConnection } from "../connection.js";

/**
 * Handle ping message: reply with pong.
 */
export function handlePing(conn: WSConnection): void {
  conn.send({ type: "pong" });
}
