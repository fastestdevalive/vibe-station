/**
 * `FileWatcher.watchFile()` — watches a file's PARENT directory (depth: 0)
 * and filters chokidar events down to the exact watched path, instead of
 * watching the file's own inode directly. This is what survives an atomic
 * rename-replace save (Requirement 5 / Decision 8's Phase 1 fix): a direct
 * single-file chokidar watch loses the inode when an editor writes a temp
 * file and renames it over the original.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileWatcher } from "../ws/streams/fileWatcher.js";

let dir: string | null = null;
let watcher: FileWatcher | null = null;

afterEach(async () => {
  if (watcher) {
    await watcher.close();
    watcher = null;
  }
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = null;
  }
});

/** Poll for a condition instead of a fixed sleep, since chokidar + the
 * watcher's own 200ms debounce introduce unavoidable async delay. */
async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("FileWatcher.watchFile", () => {
  it("fires file:changed only for the exact watched path, not sibling files", async () => {
    dir = await mkdtemp(join(tmpdir(), "vst-filewatcher-test-"));
    const target = join(dir, "target.txt");
    const sibling = join(dir, "sibling.txt");
    await writeFile(target, "v1\n");

    const changed: string[] = [];
    watcher = new FileWatcher();
    watcher.on("file:changed", (p: string) => changed.push(p));

    watcher.watchFile(target, dir);
    // Let chokidar finish its initial scan (ignoreInitial: true) before
    // triggering real changes.
    await new Promise((r) => setTimeout(r, 300));

    await writeFile(sibling, "sibling change\n");
    await writeFile(target, "v2\n");

    await waitFor(() => changed.includes(target));
    // Give any (incorrect) sibling event a chance to also arrive.
    await new Promise((r) => setTimeout(r, 300));

    expect(changed).toContain(target);
    expect(changed).not.toContain(sibling);
  }, 10000);

  it("survives an atomic rename-replace save (the bug this fixes)", async () => {
    dir = await mkdtemp(join(tmpdir(), "vst-filewatcher-rename-test-"));
    const target = join(dir, "target.txt");
    const tmpFile = join(dir, "target.txt.tmp");
    await writeFile(target, "v1\n");

    const changed: string[] = [];
    watcher = new FileWatcher();
    watcher.on("file:changed", (p: string) => changed.push(p));

    watcher.watchFile(target, dir);
    await new Promise((r) => setTimeout(r, 300));

    // Atomic rename-replace: write to a temp file in the same dir, then
    // rename over the target — the target gets a NEW inode.
    await writeFile(tmpFile, "v2\n");
    await rename(tmpFile, target);

    await waitFor(() => changed.includes(target));
    expect(changed).toContain(target);
  }, 10000);

  it("fires file:deleted only for the exact watched path", async () => {
    dir = await mkdtemp(join(tmpdir(), "vst-filewatcher-delete-test-"));
    const target = join(dir, "target.txt");
    const sibling = join(dir, "sibling.txt");
    await writeFile(target, "v1\n");
    await writeFile(sibling, "v1\n");

    const deleted: string[] = [];
    watcher = new FileWatcher();
    watcher.on("file:deleted", (p: string) => deleted.push(p));

    watcher.watchFile(target, dir);
    await new Promise((r) => setTimeout(r, 300));

    await rm(sibling);
    await rm(target);

    await waitFor(() => deleted.includes(target));
    await new Promise((r) => setTimeout(r, 300));

    expect(deleted).toContain(target);
    expect(deleted).not.toContain(sibling);
  }, 10000);
});
