import type { WSConnection } from "../connection.js";
import type { ClientMessage } from "../protocol.js";
import { FileWatcher } from "../streams/fileWatcher.js";
import { join } from "node:path";

/**
 * Handle tree:watch: start watching a directory tree for changes.
 * For Phase 7, we'll use a simple path construction.
 * In a real implementation, this would look up the worktree path from the project store.
 */
export function handleTreeWatch(
  conn: WSConnection,
  msg: Extract<ClientMessage, { type: "tree:watch" }>,
): void {
  const { worktreeId, path: treePathOverride } = msg;

  // Default to worktree root if path is not specified
  const treePath = treePathOverride ?? "";
  const watchKey = `tree:${worktreeId}:${treePath}`;

  // Check if already watching
  if ((conn as any).treeWatches?.has?.(watchKey)) {
    // Already watching — no-op
    return;
  }

  try {
    // For Phase 7, construct the absolute path from worktreeId and path.
    // In a real implementation, look up the worktree root from the project store.
    const worktreeRoot = join(process.env.HOME || "/tmp", ".vibe-station", "projects", "test", "worktrees", worktreeId);
    const absPath = treePath ? join(worktreeRoot, treePath) : worktreeRoot;

    const watcher = new FileWatcher();

    // Set up event listeners
    watcher.on("file:changed", (filePath: string) => {
      // Map file path back to relative path
      const relPath = filePath.replace(worktreeRoot + "/", "");
      conn.send({
        type: "tree:changed",
        worktreeId,
        path: treePath,
        kind: "added", // In v1, we don't distinguish between add/unlink; both are changes
      });
    });

    watcher.on("file:deleted", (filePath: string) => {
      conn.send({
        type: "tree:changed",
        worktreeId,
        path: treePath,
        kind: "deleted",
      });
    });

    watcher.on("error", (message: string) => {
      // On error, stop watching
      conn.unregisterTreeWatcher(watchKey);
      conn.send({
        type: "system:error",
        message: `Tree watcher error for ${treePath || "root"}: ${message}`,
      });
    });

    // Register the watcher
    conn.registerTreeWatcher(watchKey, watcher);

    // Start watching
    watcher.watch(absPath, worktreeRoot);
  } catch (err) {
    conn.send({
      type: "system:error",
      message: `Failed to watch tree at ${treePath || "root"}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
