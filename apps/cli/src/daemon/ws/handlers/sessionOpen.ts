import type { WSConnection } from "../connection.js";
import type { ClientMessage } from "../protocol.js";
import { TmuxOutputStream } from "../streams/tmuxOutput.js";
import { findTmuxNameForSession } from "./sessionLookup.js";

export async function handleSessionOpen(
  conn: WSConnection,
  msg: Extract<ClientMessage, { type: "session:open" }>,
): Promise<void> {
  const { sessionId, cols, rows } = msg;

  // If a stale stream is still registered (e.g. user clicked Resume after the
  // tmux pane died — the FIFO close didn't unregister), tear it down so this
  // open can attach to the freshly-spawned pane.
  if (conn.hasOpenStream(sessionId)) {
    const stale = conn.openStreams.get(sessionId) as TmuxOutputStream | undefined;
    if (stale) {
      try { await stale.detach(); } catch { /* best-effort */ }
    }
    conn.unregisterOpenStream(sessionId);
  }

  const tmuxName = findTmuxNameForSession(sessionId);
  if (!tmuxName) {
    conn.send({
      type: "session:error",
      sessionId,
      message: `Session '${sessionId}' not found`,
    });
    return;
  }

  try {

    const stream = new TmuxOutputStream(tmuxName);
    conn.registerOpenStream(sessionId, stream);

    // Set up event listeners
    stream.once("opened", () => {
      conn.send({
        type: "session:opened",
        sessionId,
      });
    });

    stream.on("chunk", (chunk: string) => {
      conn.send({
        type: "session:output",
        sessionId,
        chunk,
      });
    });

    stream.once("error", (message: string) => {
      conn.unregisterOpenStream(sessionId);
      conn.send({
        type: "session:error",
        sessionId,
        message,
      });
    });

    stream.once("close", () => {
      conn.unregisterOpenStream(sessionId);
    });

    // Start attachment
    await stream.attach(cols, rows);
  } catch (err) {
    conn.send({
      type: "session:error",
      sessionId,
      message: err instanceof Error ? err.message : "Unknown error",
    });
  }
}
