/**
 * Directory-aware, nested-gitignore-aware ignore matcher for a worktree.
 *
 * Why this exists (and why the naive "load only the root .gitignore" approach
 * was a real bug): chokidar watches the whole worktree recursively and places
 * one inotify watch per directory AND per file. If `node_modules` isn't
 * excluded, a single tree:watch on a JS repo allocates tens of thousands of
 * watches and blows past the kernel's `fs.inotify.max_user_watches` limit —
 * which then also starves Vite's HMR watcher (ENOSPC). The root `.gitignore`
 * frequently does NOT mention `node_modules` because the rule lives in a
 * nested `.gitignore` (e.g. `web/.gitignore: /node_modules`), so loading only
 * the root file misses it entirely.
 *
 * This matcher:
 *  - ALWAYS excludes any path containing a `node_modules` or `.git` segment,
 *    regardless of gitignore contents (defensive; matches what ripgrep does).
 *  - Walks every `.gitignore` from the worktree root down to a path's parent
 *    and applies each one relative to its own directory (git semantics for
 *    nested ignore files), lazily and cached.
 *  - Appends a trailing slash when testing directory entries, which the
 *    `ignore` package requires to honor directory-only patterns and their
 *    negations (e.g. `.claude/*` + `!.claude/skills/`).
 */
import ignore from "ignore";
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ALWAYS_IGNORED = new Set(["node_modules", ".git"]);

export interface IgnoreMatcher {
  /** True if `absPath` should be ignored. `isDir` controls directory-pattern matching. */
  ignores(absPath: string, isDir: boolean): boolean;
}

export function buildIgnoreMatcher(worktreeRoot: string): IgnoreMatcher {
  // dir (absolute) -> ignore instance from that dir's .gitignore, or null if none.
  const cache = new Map<string, ReturnType<typeof ignore> | null>();

  function gitignoreFor(dirAbs: string): ReturnType<typeof ignore> | null {
    const cached = cache.get(dirAbs);
    if (cached !== undefined) return cached;
    let ig: ReturnType<typeof ignore> | null = null;
    try {
      ig = ignore().add(readFileSync(join(dirAbs, ".gitignore"), "utf8"));
    } catch {
      // No .gitignore in this directory.
    }
    cache.set(dirAbs, ig);
    return ig;
  }

  return {
    ignores(absPath: string, isDir: boolean): boolean {
      const rel = relative(worktreeRoot, absPath);
      // Outside the worktree (escaped symlink) or the root itself — never ignore.
      if (!rel || rel.startsWith("..")) return false;

      const segments = rel.split(sep);
      // Hard-exclude node_modules / .git anywhere in the path. This is the
      // line that prevents inotify exhaustion; it does not depend on stats.
      if (segments.some((s) => ALWAYS_IGNORED.has(s))) return true;

      // Apply each ancestor directory's .gitignore to the remaining relative
      // path, matching git's nested-ignore semantics.
      let dirAbs = worktreeRoot;
      for (let i = 0; i < segments.length; i++) {
        const ig = gitignoreFor(dirAbs);
        if (ig) {
          let subRel = segments.slice(i).join("/");
          // Trailing slash so directory-only patterns / negations match.
          if (isDir) subRel += "/";
          if (ig.ignores(subRel)) return true;
        }
        dirAbs = join(dirAbs, segments[i]!);
      }
      return false;
    },
  };
}
