// @ts-nocheck
import type { WSConnection } from "../connection.js";
import type { ClientMessage } from "../protocol.js";
import { FileWatcher } from "../streams/fileWatcher.js";
import { join } from "node:path";

/**
 * Handle file:watch: start watching a file for changes.
 * For Phase 6, we'll use a simple path construction.
 * In a real implementation, this would look up the worktree path from the project store.
 */
export function handleFileWatch(
  conn: WSConnection,
  msg: Extract<ClientMessage, { type: "file:watch" }>,
): void {
  const { worktreeId, path } = msg;

  const watchKey = `file:${worktreeId}:${path}`;

  // Check if already watching
  if ((conn as any).fileWatches?.has?.(watchKey)) {
    // Already watching — no-op
    return;
  }

  try {
    // For Phase 6, construct the absolute path from worktreeId and path.
    // In a real implementation, look up the worktree root from the project store.
    // For now, assume a simple path structure or use a placeholder.
    const worktreeRoot = join(process.env.HOME || "/tmp", ".vibe-station", "projects", "test", "worktrees", worktreeId);
    const absPath = join(worktreeRoot, path);

    const watcher = new FileWatcher();

    // Set up event listeners
    watcher.on("file:changed", () => {
      conn.send({
        type: "file:changed",
        worktreeId,
        path,
      });
    });

    watcher.on("file:deleted", () => {
      conn.send({
        type: "file:deleted",
        worktreeId,
        path,
      });
    });

    watcher.on("error", (message: string) => {
      // On error, stop watching
      conn.unregisterFileWatcher(watchKey);
      conn.send({
        type: "system:error",
        message: `File watcher error for ${path}: ${message}`,
      });
    });

    // Register the watcher
    conn.registerFileWatcher(watchKey, watcher);

    // Start watching
    watcher.watch(absPath, worktreeRoot);
  } catch (err) {
    conn.send({
      type: "system:error",
      message: `Failed to watch file ${path}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
