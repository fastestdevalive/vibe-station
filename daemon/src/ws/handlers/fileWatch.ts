import type { WSConnection } from "../connection.js";
import type { ClientMessage } from "../protocol.js";
import { FileWatcher } from "../streams/fileWatcher.js";
import { join } from "node:path";
import { getAllProjects } from "../../state/project-store.js";
import { worktreePath as getWorktreePath } from "../../services/paths.js";

/**
 * Handle file:watch: start watching a file for changes.
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
    const project = getAllProjects().find((p) => p.worktrees.some((w) => w.id === worktreeId));
    if (!project) {
      conn.send({
        type: "system:error",
        message: `Worktree '${worktreeId}' not found`,
      });
      return;
    }
    const worktreeRoot = getWorktreePath(project.id, worktreeId);
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
