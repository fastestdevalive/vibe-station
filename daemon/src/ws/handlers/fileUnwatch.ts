// @ts-nocheck
import type { WSConnection } from "../connection.js";
import type { ClientMessage } from "../protocol.js";
import type { FileWatcher } from "../streams/fileWatcher.js";

/**
 * Handle file:unwatch: stop watching a file.
 */
export async function handleFileUnwatch(
  conn: WSConnection,
  msg: Extract<ClientMessage, { type: "file:unwatch" }>,
): Promise<void> {
  const { worktreeId, path } = msg;

  const watchKey = `file:${worktreeId}:${path}`;

  try {
    const watcher = (conn as any).fileWatches?.get?.(watchKey) as FileWatcher | undefined;
    if (watcher) {
      await watcher.close();
    }
    conn.unregisterFileWatcher(watchKey);
  } catch (err) {
    console.error(`[WS] Error unwatching file ${path}:`, err);
  }
}
