import { execSync } from "node:child_process";
import type { WSConnection } from "../connection.js";
import type { ClientMessage } from "../protocol.js";
import { findTmuxNameForSession } from "./sessionLookup.js";

export function handleSessionResize(
  conn: WSConnection,
  msg: Extract<ClientMessage, { type: "session:resize" }>,
): void {
  const { sessionId, cols, rows } = msg;

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
    execSync(`tmux resize-window -t ${tmuxName} -x ${cols} -y ${rows}`, { timeout: 5000 });
  } catch (err) {
    // Resize is best-effort: a transient failure shouldn't show a banner.
    // Lifecycle poller handles whole-session death.
    console.warn(`[WS] Failed to resize session ${sessionId}:`, err);
  }
}
