// @ts-nocheck
import { execSync } from "node:child_process";
import type { WSConnection } from "../connection.js";
import type { ClientMessage } from "../protocol.js";
import { findSessionRecord } from "./sessionLookup.js";

/**
 * Resize the session's PTY to match the client viewport.
 *
 * Tmux mode: must update BOTH the tmux pane and the `tmux attach-session`
 * PTY's terminal size. Tmux's default `window-size=latest` resizes the
 * window to the most-recently-active client's terminal dimensions on
 * every interaction — so a stale PTY cols/rows would cause tmux to snap
 * the pane back to those dimensions on the next keystroke or output,
 * silently undoing our resize. The TmuxOutputStream's `resize` method
 * handles both via `pty.resize` + `tmux resize-window`. When no stream
 * is registered yet (mid attach/detach, fullscreen-toggle remount) we
 * still apply `tmux resize-window` so the next attach starts at the
 * correct size.
 *
 * Direct-pty mode: resize the open stream's PTY. Dropped if no stream is
 * registered; the next session:open will attach with up-to-date cols/rows
 * from the client.
 */
export function handleSessionResize(
  conn: WSConnection,
  msg: Extract<ClientMessage, { type: "session:resize" }>,
): void {
  const { sessionId, cols, rows } = msg;

  const result = findSessionRecord(sessionId);
  if (!result) return;

  const { session } = result;
  const entry = conn.openStreams.get(sessionId);

  if (session.useTmux) {
    if (entry) {
      try {
        entry.stream.resize(cols, rows, entry.subscriberId);
      } catch (err) {
        console.warn(`[WS] Failed to resize session ${sessionId}:`, err);
      }
    } else {
      try {
        execSync(`tmux resize-window -t ${session.tmuxName} -x ${cols} -y ${rows}`, {
          timeout: 5000,
        });
      } catch (err) {
        console.warn(`[WS] Failed to resize tmux window for ${sessionId}:`, err);
      }
    }
    return;
  }

  // Direct-pty mode: resize through the open stream, passing subscriberId so
  // DirectPtyStream can apply minimum-wins across all active subscribers.
  if (!entry) return;

  try {
    entry.stream.resize(cols, rows, entry.subscriberId);
  } catch (err) {
    console.warn(`[WS] Failed to resize session ${sessionId}:`, err);
  }
}
