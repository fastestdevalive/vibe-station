import type { WSConnection } from "../connection.js";
import type { ClientMessage } from "../protocol.js";

/**
 * Handle session:close: detach from a stream and stop streaming.
 * Works for both tmux and direct-pty modes.
 *
 * Runs under WSConnection.withSessionLock so that a rapid close+open sequence
 * (e.g. a terminal pane remount) cannot interleave: the open waits for the
 * close to finish before attaching, preventing multiple live tmux clients.
 *
 * Race-safe: only unregisters the entry if it's still the same one we
 * captured. Under StrictMode dev (or back-to-back close+open from a
 * pane-fullscreen toggle), an open#2 can interleave during the await and
 * register a fresh entry; an unconditional unregister here would clobber it
 * and silently drop subsequent input/resize that look up by sessionId.
 */
export function handleSessionClose(
  conn: WSConnection,
  msg: Extract<ClientMessage, { type: "session:close" }>,
): Promise<void> {
  return conn.withSessionLock(msg.sessionId, () => closeSessionLocked(conn, msg));
}

async function closeSessionLocked(
  conn: WSConnection,
  msg: Extract<ClientMessage, { type: "session:close" }>,
): Promise<void> {
  const { sessionId } = msg;

  const entry = conn.openStreams.get(sessionId);
  if (!entry) return;

  try {
    entry.stream.off("chunk", entry.onChunk);
    await entry.stream.detach(entry.subscriberId);
    if (conn.openStreams.get(sessionId) === entry) {
      conn.unregisterOpenStream(sessionId);
    }
  } catch (err) {
    console.error(`[WS] Error closing session ${sessionId}:`, err);
  }
}
