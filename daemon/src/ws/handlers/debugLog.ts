import type { WSConnection } from "../connection.js";
import type { ClientMessage } from "../protocol.js";
import { appendDebug } from "../../debugLog.js";

/**
 * Persist client-shipped input/composition events (mobile double-text
 * investigation). Receiving any debug:log marks the connection debug-active so
 * its session:input bytes are logged too (see sessionInput.ts).
 */
export function handleDebugLog(
  conn: WSConnection,
  msg: Extract<ClientMessage, { type: "debug:log" }>,
): void {
  conn.debugInput = true;
  for (const entry of msg.entries) {
    appendDebug({ src: "client", conn: conn.id, ...entry });
  }
}
