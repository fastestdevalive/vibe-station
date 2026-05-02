import type { WSConnection } from "../connection.js";
import type { ClientMessage } from "../protocol.js";
import type { TmuxOutputStream } from "../streams/tmuxOutput.js";

/**
 * Handle session:close: detach from a tmux pane and stop streaming.
 */
export async function handleSessionClose(
  conn: WSConnection,
  msg: Extract<ClientMessage, { type: "session:close" }>,
): Promise<void> {
  const { sessionId } = msg;

  if (!conn.hasOpenStream(sessionId)) {
    // No-op if not open
    return;
  }

  try {
    const stream = conn.openStreams.get(sessionId) as TmuxOutputStream | undefined;
    if (stream) {
      await stream.detach();
    }
    conn.unregisterOpenStream(sessionId);
  } catch (err) {
    console.error(`[WS] Error closing session ${sessionId}:`, err);
  }
}
