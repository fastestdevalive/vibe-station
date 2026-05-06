import type { WSConnection } from "../connection.js";
import type { ClientMessage } from "../protocol.js";
import { FileWatcher } from "../streams/fileWatcher.js";
import { join } from "node:path";
import { getAllProjects } from "../../state/project-store.js";
import { worktreePath as getWorktreePath } from "../../services/paths.js";

/**
 * Handle tree:watch: start watching a directory tree for changes.
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
    const project = getAllProjects().find((p) => p.worktrees.some((w) => w.id === worktreeId));
    if (!project) {
      conn.send({
        type: "system:error",
        message: `Worktree '${worktreeId}' not found`,
      });
      return;
    }
    const worktreeRoot = getWorktreePath(project.id, worktreeId);
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
