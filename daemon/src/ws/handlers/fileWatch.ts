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

  // If another consumer already watches this key, just add a reference —
  // do NOT create a second watcher (Decision 8: refcounted watcher maps).
  if (conn.retainFileWatcher(watchKey)) {
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
      // On error, stop watching. Close first so the underlying chokidar
      // instance releases its inotify handles — unregistering before closing
      // would orphan the watcher (cleanup() can no longer find it).
      // Force-teardown path (distinct from `releaseFileWatcher`'s per-consumer
      // decrement): the one shared watcher for this key has died, so every
      // retainer loses service regardless of refCount.
      void watcher.close();
      conn.unregisterFileWatcher(watchKey);
      conn.send({
        type: "system:error",
        message: `File watcher error for ${path}: ${message}`,
      });
    });

    // Register the watcher
    conn.registerFileWatcher(watchKey, watcher);

    // Start watching. `watchFile` watches the file's parent directory
    // (depth: 0) and filters events to this exact path, rather than
    // watching the file's own inode directly — chokidar loses the watch on
    // an atomic rename-replace save (editor writes a tmp file then renames
    // over the original), which orphans a direct single-file watch.
    watcher.watchFile(absPath, worktreeRoot);
  } catch (err) {
    conn.send({
      type: "system:error",
      message: `Failed to watch file ${path}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
