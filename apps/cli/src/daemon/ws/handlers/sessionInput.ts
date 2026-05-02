import { execSync } from "node:child_process";
import type { WSConnection } from "../connection.js";
import type { ClientMessage } from "../protocol.js";
import { findTmuxNameForSession } from "./sessionLookup.js";

export function handleSessionInput(
  conn: WSConnection,
  msg: Extract<ClientMessage, { type: "session:input" }>,
): void {
  const { sessionId, data } = msg;

  if (!data || data.length === 0) return;

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
    const escaped = data.replace(/'/g, "'\\''");
    execSync(`tmux send-keys -t ${tmuxName} -l '${escaped}'`, { timeout: 5000 });
  } catch (err) {
    console.warn(`[WS] Failed to send input to session ${sessionId}:`, err);
    // tmux send-keys failed — most commonly the pane is gone. Tell the UI so
    // it can mark the session as no longer typable. The lifecycle poller will
    // also emit session:exited within ~1s.
    conn.send({
      type: "session:error",
      sessionId,
      message: err instanceof Error ? err.message : "Failed to send input",
    });
  }
}
