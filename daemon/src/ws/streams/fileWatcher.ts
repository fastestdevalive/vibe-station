import { watch, type FSWatcher } from "chokidar";
import type { Stats } from "node:fs";
import { EventEmitter } from "node:events";
import { buildIgnoreMatcher } from "../../services/ignoreFilter.js";

/**
 * Wraps chokidar to watch files with gitignore filtering and debouncing.
 * Emits 'file:changed' and 'file:deleted' events after 200ms debounce.
 */
export class FileWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly DEBOUNCE_MS = 200;

  /**
   * Start watching a file with gitignore filtering.
   * Emits 'file:changed' and 'file:deleted' after debounce.
   */
  watch(absPath: string, worktreeRoot: string): void {
    try {
      // Build a nested-gitignore-aware filter that ALSO hard-excludes
      // node_modules/.git. Critical: without the node_modules exclusion a
      // single recursive watch on a JS repo allocates tens of thousands of
      // inotify watches and exhausts the kernel limit (which then starves
      // Vite's HMR watcher → ENOSPC). See services/ignoreFilter.ts.
      const matcher = buildIgnoreMatcher(worktreeRoot);
      const ignoreFilter = (path: string, stats?: Stats) =>
        matcher.ignores(path, stats ? stats.isDirectory() : false);

      // Create watcher with gitignore filtering.
      // `ignoreInitial: true` is critical — without it, chokidar fires an
      // `add`/`addDir` event for every file/dir that already exists when
      // the watch starts. That produces a flood of `tree:changed` /
      // `file:changed` broadcasts on every watch open, which thrashes UI
      // consumers (Quick Open refetches the file list, FileTreeSidebar
      // refetches every open directory). Consumers always have a fresh
      // initial snapshot via their own GET (`/tree`, `/file-list`,
      // `/files/*path`); the watcher's only job is to notify of REAL
      // changes after that.
      this.watcher = watch(absPath, {
        ignored: ignoreFilter,
        persistent: true,
        depth: undefined,
        ignoreInitial: true,
      });

      this.watcher.on("add", (path: string) => {
        this._debounceEvent("change", path);
      });

      this.watcher.on("change", (path: string) => {
        this._debounceEvent("change", path);
      });

      this.watcher.on("addDir", (path: string) => {
        this._debounceEvent("change", path);
      });

      this.watcher.on("unlink", (path: string) => {
        this._debounceEvent("unlink", path);
      });

      this.watcher.on("unlinkDir", (path: string) => {
        this._debounceEvent("unlink", path);
      });

      this.watcher.on("error", (err: unknown) => {
        console.warn(`[FileWatcher] Error watching ${absPath}:`, err);
        const msg = err instanceof Error ? err.message : String(err);
        this.emit("error", msg);
      });
    } catch (err) {
      this.emit("error", err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Debounce file change events to coalesc rapid saves.
   */
  private _debounceEvent(eventType: "change" | "unlink", path: string): void {
    const key = `${eventType}:${path}`;

    // Clear existing timer
    const existing = this.debounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    // Set new timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      if (eventType === "change") {
        this.emit("file:changed", path);
      } else {
        this.emit("file:deleted", path);
      }
    }, this.DEBOUNCE_MS);

    this.debounceTimers.set(key, timer);
  }

  /**
   * Close the watcher.
   */
  async close(): Promise<void> {
    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Close the watcher
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
