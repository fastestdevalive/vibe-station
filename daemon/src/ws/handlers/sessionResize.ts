import { execSync } from "node:child_process";
import type { WSConnection } from "../connection.js";
import type { ClientMessage } from "../protocol.js";
import { findSessionRecord } from "./sessionLookup.js";
import { MIN_TMUX_COLS } from "../streams/tmuxOutput.js";

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
    // Authoritative squished-history guard. tmux's scrollback reflow is lossy:
    // an implausibly narrow width permanently mangles the pane's history and
    // widening can't restore it (only a fresh attach can). A usable terminal is
    // never this narrow, so any such value is a transient layout artifact (e.g.
    // a remounting pane's host collapsing to ~0). Drop it here — the single
    // chokepoint for BOTH the stream-resize and the no-stream resize-window
    // paths below — so no client code path can ever bake the history.
    if (cols < MIN_TMUX_COLS) return;
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
