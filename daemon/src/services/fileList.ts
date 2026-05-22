/**
 * Flat file listing for a worktree, used by Quick Open file search.
 *
 * Two backends:
 *  1. `rg --files` (preferred): respects .gitignore (including nested ignore
 *     files and .git/info/exclude), multithreaded, fast on large repos.
 *  2. Node `readdir` recursive walk (fallback when `rg` is not on PATH): reads
 *     only the root `.gitignore`. Less strict than `rg` — we accept this gap
 *     for v1; users who care about big repos should install ripgrep.
 *
 * Both backends:
 *  - Skip `.git/` directories.
 *  - Include dotfiles by default (matches `/tree` behavior).
 *  - Cap the result at MAX_ENTRIES and return `truncated: true` on overflow.
 */
import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import ignore from "ignore";

export const MAX_ENTRIES = 100_000;
/** Effective cap — equals MAX_ENTRIES in production. Overridable for tests
 *  (creating 100k+ files just to exercise the cap path would be slow). */
let effectiveMaxEntries = MAX_ENTRIES;
/** Test-only: override the effective cap. Pass `null` to restore the default. */
export function _setMaxEntriesForTest(n: number | null): void {
  effectiveMaxEntries = n ?? MAX_ENTRIES;
}
const RG_TIMEOUT_MS = 30_000;
/** Grace period after SIGTERM before we escalate to SIGKILL. ripgrep
 *  normally exits within milliseconds of SIGTERM; we only need the kill
 *  escalation for pathological cases (rg wedged in a syscall on a dead
 *  FUSE mount, kernel signal mask, etc). */
const RG_SIGKILL_GRACE_MS = 2_000;

export type FileListSource = "ripgrep" | "node";

export interface FileListResult {
  files: string[];
  truncated: boolean;
  source: FileListSource;
}

/** Cached detection: does `rg` exist on PATH? */
let rgAvailablePromise: Promise<boolean> | null = null;

function detectRipgrep(): Promise<boolean> {
  if (rgAvailablePromise) return rgAvailablePromise;
  rgAvailablePromise = new Promise((resolve) => {
    const child = spawn("rg", ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
  return rgAvailablePromise;
}

/** Test-only: reset the rg-availability cache so unit tests can simulate
 *  either presence or absence of ripgrep. */
export function _resetRipgrepDetectionForTest(): void {
  rgAvailablePromise = null;
}

/** Test-only: force the rg-availability answer without running `rg --version`. */
export function _setRipgrepAvailableForTest(available: boolean): void {
  rgAvailablePromise = Promise.resolve(available);
}

/**
 * List every file under `wtPath` (worktree-relative paths, POSIX separators).
 * Always uses POSIX separators in the output regardless of platform — the UI
 * normalizes paths this way.
 */
export async function listFiles(wtPath: string): Promise<FileListResult> {
  const hasRg = await detectRipgrep();
  if (hasRg) {
    return listFilesWithRipgrep(wtPath);
  }
  return listFilesWithNode(wtPath);
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

function listFilesWithRipgrep(wtPath: string): Promise<FileListResult> {
  return new Promise((resolve) => {
    const files: string[] = [];
    let truncated = false;
    let buffer = "";
    let settled = false;
    let sigkillTimer: NodeJS.Timeout | null = null;

    const child = spawn(
      "rg",
      ["--files", "--hidden", "--glob", "!.git", "--glob", "!.git/**"],
      { cwd: wtPath, stdio: ["ignore", "pipe", "ignore"] },
    );

    /** SIGTERM the child; if it doesn't exit within the grace period, SIGKILL.
     *  Critical for pathological cases where rg is wedged in a syscall — without
     *  the SIGKILL escalation the Promise never resolves and we leak a process. */
    const killChild = () => {
      if (sigkillTimer) return; // already escalating
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
      sigkillTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already exited */ }
        // Force-resolve in case 'exit' never fires (extremely rare — typically
        // means the process is a zombie awaiting reap, which Node handles).
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ files, truncated, source: "ripgrep" });
        }
      }, RG_SIGKILL_GRACE_MS);
    };

    // Hard timeout: kill the child but return what we've collected so far.
    const timer = setTimeout(() => {
      truncated = true;
      killChild();
    }, RG_TIMEOUT_MS);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      resolve({ files, truncated, source: "ripgrep" });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return;
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        if (files.length >= effectiveMaxEntries) {
          // Cap hit — terminate the child and stop reading. The 'exit'
          // handler will resolve once rg has exited.
          truncated = true;
          killChild();
          buffer = "";
          break;
        }
        files.push(toPosix(line));
      }
    });

    child.on("error", () => {
      // Spawn failed — fall back to Node walker. Drop any partial output
      // collected before the error (clean restart from the fallback).
      clearTimeout(timer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (settled) return;
      settled = true;
      if (files.length > 0) {
        console.warn(
          `[fileList] rg errored after ${files.length} entries; restarting via Node fallback`,
        );
      }
      listFilesWithNode(wtPath).then(resolve, () =>
        resolve({ files: [], truncated: false, source: "ripgrep" }),
      );
    });

    child.on("exit", () => {
      // Flush any trailing line without newline (respecting the cap).
      if (buffer && !truncated && files.length < effectiveMaxEntries) {
        files.push(toPosix(buffer));
      }
      finish();
    });
  });
}

async function listFilesWithNode(wtPath: string): Promise<FileListResult> {
  // Load root .gitignore once (matches /tree behavior — does not walk
  // nested .gitignore files; ripgrep does, hence the documented gap).
  let ig: ReturnType<typeof ignore> | null = null;
  try {
    const content = await readFile(join(wtPath, ".gitignore"), "utf8");
    ig = ignore().add(content);
  } catch {
    // No root .gitignore — proceed without filter.
  }

  const files: string[] = [];
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    if (truncated) return;
    let entries: { name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // Permission error or transient — skip this directory.
      return;
    }

    for (const e of entries) {
      if (truncated) return;
      if (e.name === ".git") continue;
      const abs = join(dir, e.name);
      const rel = toPosix(relative(wtPath, abs));

      if (ig && ig.ignores(rel)) continue;

      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        // Resolve symlink to decide dir-vs-file. Skip on broken symlink.
        try {
          const s = await stat(abs);
          isDir = s.isDirectory();
        } catch {
          continue;
        }
      }

      if (isDir) {
        await walk(abs);
      } else {
        if (files.length >= effectiveMaxEntries) {
          truncated = true;
          return;
        }
        files.push(rel);
      }
    }
  }

  await walk(wtPath);
  return { files, truncated, source: "node" };
}
