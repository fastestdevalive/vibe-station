import type { WSConnection } from "../connection.js";
import type { ClientMessage } from "../protocol.js";
import { contextRefFromMessage } from "../protocol.js";
import { FileWatcher } from "../streams/fileWatcher.js";
import { join } from "node:path";
import { resolveWatchContext } from "./watchContext.js";

/**
 * Handle tree:watch: start watching a directory tree for changes.
 *
 * Works for BOTH worktree and direct (project) contexts — see fileWatch.ts for
 * why the worktree-only resolution this replaced left direct sessions with no
 * live tree updates at all.
 */
export function handleTreeWatch(
  conn: WSConnection,
  msg: Extract<ClientMessage, { type: "tree:watch" }>,
): void {
  const { path: treePathOverride } = msg;
  const wireRef = contextRefFromMessage(msg);
  if (!wireRef) {
    conn.send({ type: "system:error", message: "tree:watch requires a context or worktreeId" });
    return;
  }

  // Default to the context root if path is not specified
  const treePath = treePathOverride ?? "";
  // Key includes kind so a worktree and a project of the same id can't collide.
  const watchKey = `tree:${wireRef.kind}:${wireRef.id}:${treePath}`;

  // Check if already watching
  if ((conn as any).treeWatches?.has?.(watchKey)) {
    // Already watching — no-op
    return;
  }

  try {
    const ctx = resolveWatchContext(wireRef);
    if (!ctx) {
      conn.send({
        type: "system:error",
        message: `Context '${wireRef.id}' not found`,
      });
      return;
    }
    // Watch relative to the context's working dir: the worktree checkout, or
    // the project dir for a direct session.
    const worktreeRoot = ctx.cwd;
    const absPath = treePath ? join(worktreeRoot, treePath) : worktreeRoot;
    const context = { kind: wireRef.kind, id: wireRef.id } as const;
    // Echo the legacy field for worktree contexts so pre-context clients match.
    const legacy = ctx.worktree ? { worktreeId: ctx.worktree.id } : {};

    const watcher = new FileWatcher();

    // Set up event listeners
    watcher.on("file:changed", (filePath: string) => {
      // Map file path back to relative path
      const relPath = filePath.replace(worktreeRoot + "/", "");
      conn.send({
        type: "tree:changed",
        context,
        ...legacy,
        path: treePath,
        kind: "added", // In v1, we don't distinguish between add/unlink; both are changes
      });
    });

    watcher.on("file:deleted", (filePath: string) => {
      conn.send({
        type: "tree:changed",
        context,
        ...legacy,
        path: treePath,
        kind: "deleted",
      });
    });

    watcher.on("error", (message: string) => {
      // On error, stop watching. Close first so the underlying chokidar
      // instance releases its inotify handles — unregistering before closing
      // would orphan the watcher (cleanup() can no longer find it).
      void watcher.close();
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
