/**
 * Filesystem routes — GET /fs/complete and GET /fs/check
 *
 * `/fs/complete` backs the directory comboboxes and the Browse dialog with live
 * filesystem suggestions. `/fs/check` reports whether a path exists, is a
 * directory, is a git repo, and has any commits, so the New Agent dialog can
 * describe accurately what registering it will do.
 *
 * Both are read-only, directories-only, capped, and defensive: the daemon binds
 * to 127.0.0.1 and is auth-gated, but these endpoints browse the host
 * filesystem so they stay conservative about what they expose. Neither ever
 * 500s on an unreadable or half-typed path.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { hasCommits, isGitRepo } from "../services/git.js";

const MAX_ENTRIES = 50;

const QuerySchema = z.object({
  path: z.string().max(4096),
});

/**
 * Resolve a leading `~` (either exactly `~` or `~/...`) to the user's home
 * dir. `path.join()` normalizes away a trailing separator, which would
 * silently turn `~/` into `/home/user` (no trailing slash) and break the R4
 * "ends with separator → list children" rule for the common home-dir case —
 * so a trailing separator on the input is restored on the output.
 */
function expandTilde(input: string): string {
  if (input === "~") return homedir();
  if (!(input.startsWith(`~${sep}`) || input.startsWith("~/"))) return input;
  const rest = input.slice(2);
  const joined = join(homedir(), rest);
  const hadTrailingSep = input.endsWith(sep) || input.endsWith("/");
  return hadTrailingSep && !joined.endsWith(sep) ? joined + sep : joined;
}

export function registerFsRoutes(app: FastifyInstance): void {
  // GET /fs/check?path=<path>
  app.get("/fs/check", async (req, reply) => {
    const result = QuerySchema.safeParse(req.query);
    if (!result.success) {
      return reply.status(400).send({ error: "Validation error", details: result.error.issues });
    }
    const { path: rawPath } = result.data;

    if (rawPath.includes("\0")) {
      return reply.status(400).send({ error: "Path cannot contain a null byte." });
    }

    const resolved = expandTilde(rawPath);
    if (!isAbsolute(resolved)) {
      return reply.status(400).send({ error: `Path must be absolute (or start with ~). Got: '${rawPath}'` });
    }

    try {
      const stats = await stat(resolved);
      const isDirectory = stats.isDirectory();
      if (!isDirectory) {
        return reply.send({ exists: true, isDirectory: false, isGit: false, hasCommits: null });
      }
      const isGit = await isGitRepo(resolved);
      // Only meaningful for a git dir — project-setup.sh makes an initial
      // commit of the whole directory whenever HEAD doesn't resolve, even for
      // an already-git dir, so callers need this to describe setup accurately.
      const commits = isGit ? await hasCommits(resolved) : null;
      return reply.send({ exists: true, isDirectory: true, isGit, hasCommits: commits });
    } catch {
      // ENOENT/EACCES/etc — user is mid-typing or path doesn't exist. Never 500.
      return reply.send({ exists: false, isDirectory: false, isGit: false, hasCommits: null });
    }
  });

  // GET /fs/complete?path=<partial>
  app.get("/fs/complete", async (req, reply) => {
    const result = QuerySchema.safeParse(req.query);
    if (!result.success) {
      return reply.status(400).send({ error: "Validation error", details: result.error.issues });
    }
    const { path: rawPath } = result.data;

    if (rawPath.includes("\0")) {
      return reply.status(400).send({ error: "Path cannot contain a null byte." });
    }

    const resolved = expandTilde(rawPath);
    if (!isAbsolute(resolved)) {
      return reply.status(400).send({ error: `Path must be absolute (or start with ~). Got: '${rawPath}'` });
    }

    // R4: only list children of the typed dir when the text ends with the
    // path separator. Otherwise prefix-match child names of the parent dir —
    // do NOT auto-descend just because the text already equals a dir name.
    let dir: string;
    let prefix: string;
    if (resolved.endsWith(sep)) {
      dir = resolved;
      prefix = "";
    } else {
      dir = dirname(resolved);
      prefix = basename(resolved);
    }

    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      // ENOENT/EACCES/etc — user is mid-typing, never 500.
      return reply.send({ base: dir, entries: [], truncated: false });
    }

    // Sort by name BEFORE capping, then cap. Sorting the (name-)filtered list
    // is cheap (string compares only, no stat() calls) — it just needs to
    // happen before slice() so the cap keeps the alphabetically-first N
    // entries rather than an arbitrary readdir-order N. Capping before sort
    // (the original approach) is fine for narrow prefix-matched type-ahead
    // (rarely >50 matches) but actively misleading for a full directory
    // listing (empty prefix) in the Browse dialog — e.g. `/usr/lib` could
    // silently omit the very folder the user is looking for.
    // Only directory-ish dirents count toward the cap and toward `truncated`.
    // Filtering on the name alone would let plain files inflate the count: a
    // directory holding 60 files and 2 subdirs would report truncated:true
    // while omitting nothing, and the UI would show a "showing the first 50"
    // warning over a two-item list. Symlinks are kept as candidates because
    // only a stat() can say whether they point at a directory — and that stat
    // stays bounded by the cap below, which is why the cap exists.
    const filtered = dirents
      .filter((d) => prefix === "" || d.name.startsWith(prefix))
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const truncated = filtered.length > MAX_ENTRIES;
    const candidates = filtered.slice(0, MAX_ENTRIES);

    const entries: { name: string; path: string }[] = [];
    for (const d of candidates) {
      const full = join(dir, d.name);
      if (d.isDirectory()) {
        entries.push({ name: d.name, path: full });
      } else if (d.isSymbolicLink()) {
        try {
          const s = await stat(full);
          if (s.isDirectory()) entries.push({ name: d.name, path: full });
        } catch {
          // Broken symlink — skip.
        }
      }
    }

    return reply.send({ base: dir, entries, truncated });
  });
}
