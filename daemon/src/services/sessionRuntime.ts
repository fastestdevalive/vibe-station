import type { SessionRecord } from "../types.js";
import { jsonAgentRegistry } from "../state/jsonAgentRegistry.js";
import { directPtyRegistry } from "../state/directPtyRegistry.js";
import { clearSessionAttachments } from "../state/attachmentRegistry.js";
import { killSession } from "./tmux.js";
import { clearIdleTracking } from "./lifecycle.js";

/**
 * Release every LIVE runtime resource a session holds, without touching
 * anything persisted.
 *
 * Freed here:
 * - the `JsonAgentSession` (in-flight turn's process group, turn queue, its own
 *   SQLite WAL handle = 3 fds, stream listeners) and its registry entry
 * - the tmux pane (and with it the agent CLI's whole process tree) or, for
 *   `useTmux: false`, the direct-pty child
 * - the lifecycle poller's idle-hash entry
 *
 * NOT touched (so the session stays resumable):
 * - the `SessionRecord` in the manifest — including `agentChatId`, which is
 *   what `POST /sessions/:id/resume` feeds to `--resume`
 * - the session data dir (system prompt, JSON transcript SQLite file)
 * - the worktree checkout and the agent CLI's own history files
 * - staged attachments, unless `clearAttachments` is set
 *
 * Callers:
 * - `POST /sessions/:id/done` / `POST /worktrees/:id/done` — reclaim resources
 *   while keeping the session resumable (attachments kept)
 * - `DELETE /sessions/:id` / `DELETE /worktrees/:id` — same teardown as the
 *   first step of a destructive removal (`clearAttachments: true`)
 *
 * Best-effort throughout: a missing pane, an unregistered pty, or a
 * already-released agent are all normal, so nothing here throws.
 */
export async function releaseSessionRuntime(
  session: SessionRecord,
  opts: { clearAttachments?: boolean } = {},
): Promise<void> {
  // Unregister BEFORE releasing so a concurrent request can't hand out a
  // handle that is mid-teardown; `release()` is idempotent either way.
  const agent = jsonAgentRegistry.get(session.id);
  jsonAgentRegistry.delete(session.id);
  // Awaited: `release()` latches the session against late writes, kills the
  // turn's process group, waits (bounded) for the drain to unwind, and only
  // then closes SQLite. Without the await, the drain's trailing lifecycle
  // persist would land after the caller writes `done` and demote it to `idle`.
  if (agent) await agent.release();

  if (opts.clearAttachments) clearSessionAttachments(session.id);

  if (!session.useTmux) {
    // Direct-pty (and json, which is always `useTmux: false` — a registry miss
    // there, since json sessions spawn per turn and hold no long-lived pty).
    directPtyRegistry.get(session.id)?.kill?.();
  } else {
    try {
      await killSession(session.tmuxName);
    } catch {
      // Pane already gone — nothing to reclaim.
    }
  }

  clearIdleTracking(session.id);
}
