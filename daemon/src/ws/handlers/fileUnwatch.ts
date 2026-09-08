import type { WSConnection } from "../connection.js";
import type { ClientMessage } from "../protocol.js";
import type { FileWatcher } from "../streams/fileWatcher.js";

/**
 * Handle file:unwatch: release this consumer's reference to a file watch.
 * The underlying watcher is only actually closed once every consumer has
 * released it (Decision 8: refcounted watcher maps).
 */
export async function handleFileUnwatch(
  conn: WSConnection,
  msg: Extract<ClientMessage, { type: "file:unwatch" }>,
): Promise<void> {
  const { worktreeId, path } = msg;

  const watchKey = `file:${worktreeId}:${path}`;

  try {
    const watcher = conn.releaseFileWatcher(watchKey) as FileWatcher | null;
    if (watcher) {
      await watcher.close();
    }
  } catch (err) {
    console.error(`[WS] Error unwatching file ${path}:`, err);
  }
}
