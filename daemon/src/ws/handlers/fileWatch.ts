import type { WSConnection } from "../connection.js";
import type { ClientMessage } from "../protocol.js";
import { contextRefFromMessage } from "../protocol.js";
import { FileWatcher } from "../streams/fileWatcher.js";
import { join } from "node:path";
import { resolveWatchContext } from "./watchContext.js";

/**
 * Handle file:watch: start watching a file for changes.
 *
 * Works for BOTH worktree and direct (project) contexts. This used to resolve
 * by scanning `p.worktrees` only, so a direct session — which has no worktree
 * by design — got "Worktree '<id>' not found" and could never watch anything.
 * The client worked around it by skipping watches for project scope entirely,
 * which is why direct-session file trees and previews never live-updated.
 */
export function handleFileWatch(
  conn: WSConnection,
  msg: Extract<ClientMessage, { type: "file:watch" }>,
): void {
  const { path } = msg;
  const wireRef = contextRefFromMessage(msg);
  if (!wireRef) {
    conn.send({ type: "system:error", message: "file:watch requires a context or worktreeId" });
    return;
  }

  // Key includes kind so a worktree and a project of the same id can't collide.
  const watchKey = `file:${wireRef.kind}:${wireRef.id}:${path}`;

  // Check if already watching
  if ((conn as any).fileWatches?.has?.(watchKey)) {
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
    const root = ctx.cwd;
    const absPath = join(root, path);
    const context = { kind: wireRef.kind, id: wireRef.id } as const;
    // Echo the legacy field for worktree contexts so pre-context clients match.
    const legacy = ctx.worktree ? { worktreeId: ctx.worktree.id } : {};

    const watcher = new FileWatcher();

    // Set up event listeners
    watcher.on("file:changed", () => {
      conn.send({ type: "file:changed", context, ...legacy, path });
    });

    watcher.on("file:deleted", () => {
      conn.send({ type: "file:deleted", context, ...legacy, path });
    });

    watcher.on("error", (message: string) => {
      // On error, stop watching. Close first so the underlying chokidar
      // instance releases its inotify handles — unregistering before closing
      // would orphan the watcher (cleanup() can no longer find it).
      void watcher.close();
      conn.unregisterFileWatcher(watchKey);
      conn.send({
        type: "system:error",
        message: `File watcher error for ${path}: ${message}`,
      });
    });

    // Register the watcher
    conn.registerFileWatcher(watchKey, watcher);

    // Start watching
    watcher.watch(absPath, root);
  } catch (err) {
    conn.send({
      type: "system:error",
      message: `Failed to watch file ${path}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
