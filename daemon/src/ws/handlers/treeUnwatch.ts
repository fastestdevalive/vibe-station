import type { WSConnection } from "../connection.js";
import type { ClientMessage } from "../protocol.js";
import type { FileWatcher } from "../streams/fileWatcher.js";
import { contextRefFromMessage } from "../protocol.js";

/**
 * Handle tree:unwatch: stop watching a directory tree.
 */
export async function handleTreeUnwatch(
  conn: WSConnection,
  msg: Extract<ClientMessage, { type: "tree:unwatch" }>,
): Promise<void> {
  const { path: treePathOverride } = msg;
  const treePath = treePathOverride ?? "";
  // Key must match handleTreeWatch exactly — see fileUnwatch.
  const wireRef = contextRefFromMessage(msg);
  if (!wireRef) return;
  const watchKey = `tree:${wireRef.kind}:${wireRef.id}:${treePath}`;

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
