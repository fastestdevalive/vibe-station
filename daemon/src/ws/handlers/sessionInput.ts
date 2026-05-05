// @ts-nocheck
import { execSync } from "node:child_process";
import type { WSConnection } from "../connection.js";
import type { ClientMessage } from "../protocol.js";
import { findSessionRecord } from "./sessionLookup.js";

/**
 * Forward client keystrokes to the session.
 *
 * Tmux mode: prefer writing through the open `tmux attach-session` PTY
 * (`entry.stream.write`) so tmux's input parser sees the bytes and can
 * react to the prefix key (Ctrl-B by default). The touch-scroll handler
 * relies on this — it sends `Ctrl-B [` to enter copy-mode, then arrow
 * keys for navigation; without prefix processing those bytes leak into
 * the active pane (e.g. claude shows "Scroll wheel is sending arrow
 * keys"). Fall back to `tmux send-keys -l` if no stream is registered
 * yet (mid attach-detach race) so input still reaches the pane.
 *
 * Direct-pty mode: write to the open stream's PTY. Requires session:open
 * first; if no stream is registered the input is dropped silently and the
 * client should retry after session:open completes.
 */
export function handleSessionInput(
  conn: WSConnection,
  msg: Extract<ClientMessage, { type: "session:input" }>,
): void {
  const { sessionId, data } = msg;
  if (!data || data.length === 0) return;

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
  const entry = conn.openStreams.get(sessionId);

  if (session.useTmux) {
    if (entry) {
      try {
        entry.stream.write(data);
        return;
      } catch (err) {
        console.warn(`[WS] pty.write failed for ${sessionId}, falling back to send-keys:`, err);
      }
    }
    // No stream (or write threw) — fall back to direct tmux command.
    // send-keys -l bypasses tmux's prefix interpretation, so this path does
    // NOT support touch-scroll's copy-mode entry; it's a "best-effort keep
    // typing working" path during attach gaps.
    try {
      const escaped = data.replace(/'/g, "'\\''");
      execSync(`tmux send-keys -t ${session.tmuxName} -l '${escaped}'`, { timeout: 5000 });
    } catch (err) {
      console.warn(`[WS] Failed to send input to session ${sessionId}:`, err);
      conn.send({
        type: "session:error",
        sessionId,
        message: err instanceof Error ? err.message : "Failed to send input",
      });
    }
    return;
  }

  // Direct-pty mode: write through the open stream.
  if (!entry) return;

  try {
    entry.stream.write(data);
  } catch (err) {
    console.warn(`[WS] Failed to send input to session ${sessionId}:`, err);
    conn.send({
      type: "session:error",
      sessionId,
      message: err instanceof Error ? err.message : "Failed to send input",
    });
  }
}
