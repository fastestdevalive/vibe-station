// @ts-nocheck
import type { WSConnection } from "../connection.js";
import type { ClientMessage } from "../protocol.js";
import type { FileWatcher } from "../streams/fileWatcher.js";

/**
 * Handle tree:unwatch: stop watching a directory tree.
 */
export async function handleTreeUnwatch(
  conn: WSConnection,
  msg: Extract<ClientMessage, { type: "tree:unwatch" }>,
): Promise<void> {
  const { worktreeId, path: treePathOverride } = msg;

  const treePath = treePathOverride ?? "";
  const watchKey = `tree:${worktreeId}:${treePath}`;

  try {
    const watcher = conn.treeWatches?.get?.(watchKey) as FileWatcher | undefined;
    if (watcher) {
      await watcher.close();
    }
    conn.unregisterTreeWatcher(watchKey);
  } catch (err) {
    console.error(`[WS] Error unwatching tree at ${treePath || "root"}:`, err);
  }
}
