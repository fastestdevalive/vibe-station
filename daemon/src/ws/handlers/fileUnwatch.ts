import type { WSConnection } from "../connection.js";
import type { ClientMessage } from "../protocol.js";
import type { FileWatcher } from "../streams/fileWatcher.js";
import { contextRefFromMessage } from "../protocol.js";

/**
 * Handle file:unwatch: stop watching a file.
 */
export async function handleFileUnwatch(
  conn: WSConnection,
  msg: Extract<ClientMessage, { type: "file:unwatch" }>,
): Promise<void> {
  const { path } = msg;
  // Must build the key exactly as handleFileWatch does — a mismatch silently
  // leaks the watcher (and its inotify handles) for the life of the connection.
  const wireRef = contextRefFromMessage(msg);
  if (!wireRef) return;
  const watchKey = `file:${wireRef.kind}:${wireRef.id}:${path}`;

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
