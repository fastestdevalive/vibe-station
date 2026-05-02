import { watch, type FSWatcher } from "chokidar";
import ignore from "ignore";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";

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
      // Build gitignore filter
      let ignoreFilter = (_: string) => false; // default: don't ignore anything

      const gitignorePath = join(worktreeRoot, ".gitignore");
      try {
        const gitignoreContent = readFileSync(gitignorePath, "utf8");
        const ig = ignore().add(gitignoreContent);
        ignoreFilter = (path: string) => ig.ignores(path);
      } catch {
        // No .gitignore — use default
      }

      // Create watcher with gitignore filtering
      this.watcher = watch(absPath, {
        ignored: ignoreFilter,
        persistent: true,
        depth: undefined,
      });

      this.watcher.on("change", (path: string) => {
        this._debounceEvent("change", path);
      });

      this.watcher.on("unlink", (path: string) => {
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
