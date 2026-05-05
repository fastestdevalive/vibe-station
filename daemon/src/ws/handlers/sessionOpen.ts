// @ts-nocheck
import type { WSConnection } from "../connection.js";
import type { OpenStreamEntry } from "../connection.js";
import type { ClientMessage } from "../protocol.js";
import { TmuxOutputStream } from "../streams/tmuxOutput.js";
import { findSessionRecord } from "./sessionLookup.js";
import { directPtyRegistry } from "../../state/directPtyRegistry.js";
import type { SessionStream } from "../streams/sessionStream.js";

export async function handleSessionOpen(
  conn: WSConnection,
  msg: Extract<ClientMessage, { type: "session:open" }>,
): Promise<void> {
  const { sessionId, cols, rows } = msg;

  // If a stale stream is still registered (e.g. user clicked Resume after the
  // tmux pane died — the FIFO close didn't unregister), tear it down so this
  // open can attach to the freshly-spawned pane.
  const stale = conn.openStreams.get(sessionId);
  if (stale) {
    try {
      stale.stream.off("chunk", stale.onChunk);
      await stale.stream.detach(stale.subscriberId);
    } catch { /* best-effort */ }
    if (conn.openStreams.get(sessionId) === stale) {
      conn.unregisterOpenStream(sessionId);
    }
  }

  const result = findSessionRecord(sessionId);
  if (!result) {
    conn.send({
      type: "session:error",
      sessionId,
      message: `Session '${sessionId}' not found`,
    });
    return;
  }

  const { session } = result;
  const subscriberId = `${conn.id}:${sessionId}`;

  try {
    let stream: SessionStream;

    if (session.useTmux) {
      // Tmux mode: one PTY per connection
      stream = new TmuxOutputStream(session.tmuxName);
    } else {
      // Direct-pty mode: shared stream from registry
      const existing = directPtyRegistry.get(sessionId);
      if (!existing) {
        conn.send({
          type: "session:error",
          sessionId,
          message: `Session '${sessionId}' not running`,
        });
        return;
      }
      stream = existing;
    }

    const onChunk = (chunk: string) => {
      conn.send({
        type: "session:output",
        sessionId,
        chunk,
      });
    };

    const entry: OpenStreamEntry = {
      kind: session.useTmux ? "tmux" : "direct",
      stream,
      subscriberId,
      onChunk,
    };
    conn.registerOpenStream(sessionId, entry);

    // Set up event listeners. The unregister-on-close/error guards check that
    // the openStreams entry still points at THIS stream — under StrictMode
    // dev or a fullscreen-toggle remount, a follow-up open can replace the
    // entry, and we must not clobber it when this stream finally closes.
    stream.once("opened", () => {
      conn.send({
        type: "session:opened",
        sessionId,
      });
    });

    stream.on("chunk", onChunk);

    stream.once("error", (message: string) => {
      stream.off("chunk", onChunk);
      if (conn.openStreams.get(sessionId) === entry) {
        conn.unregisterOpenStream(sessionId);
      }
      conn.send({
        type: "session:error",
        sessionId,
        message,
      });
    });

    stream.once("close", () => {
      stream.off("chunk", onChunk);
      if (conn.openStreams.get(sessionId) === entry) {
        conn.unregisterOpenStream(sessionId);
      }
    });

    // Start attachment
    await stream.attach(cols, rows, subscriberId);
  } catch (err) {
    conn.send({
      type: "session:error",
      sessionId,
      message: err instanceof Error ? err.message : "Unknown error",
    });
  }
}
