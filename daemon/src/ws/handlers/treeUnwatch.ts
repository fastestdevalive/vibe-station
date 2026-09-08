import type { WSConnection } from "../connection.js";
import type { ClientMessage } from "../protocol.js";
import type { FileWatcher } from "../streams/fileWatcher.js";

/**
 * Handle tree:unwatch: release this consumer's reference to a directory
 * tree watch. The underlying watcher is only actually closed once every
 * consumer has released it (Decision 8: refcounted watcher maps) — so one
 * consumer unwatching never tears down a watcher another consumer still
 * depends on.
 */
export async function handleTreeUnwatch(
  conn: WSConnection,
  msg: Extract<ClientMessage, { type: "tree:unwatch" }>,
): Promise<void> {
  const { worktreeId, path: treePathOverride } = msg;

  const treePath = treePathOverride ?? "";
  const watchKey = `tree:${worktreeId}:${treePath}`;

  try {
    const watcher = conn.releaseTreeWatcher(watchKey) as FileWatcher | null;
    if (watcher) {
      await watcher.close();
    }
  } catch (err) {
    console.error(`[WS] Error unwatching tree at ${treePath || "root"}:`, err);
  }
}
