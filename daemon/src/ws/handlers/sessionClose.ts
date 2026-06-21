import type { WSConnection } from "../connection.js";
import type { ClientMessage } from "../protocol.js";
import { getLiveTmuxStreamCount } from "../streams/tmuxOutput.js";
import { appendDebug } from "../../debugLog.js";

/**
 * Handle session:close: detach from a stream and stop streaming.
 * Works for both tmux and direct-pty modes.
 *
 * Serialized under the connection's per-session lock so close can't interleave
 * with an open for the same session (which is what orphaned a live PTY).
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
    if (conn.debugInput) {
      appendDebug({
        src: "daemon",
        conn: conn.id,
        kind: "stream:detach",
        sessionId,
        liveTmuxStreams: getLiveTmuxStreamCount(),
      });
    }
  } catch (err) {
    console.error(`[WS] Error closing session ${sessionId}:`, err);
  }
}
